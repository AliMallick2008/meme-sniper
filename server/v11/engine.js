'use strict';
/* Meme Sniper v11 engine: a deterministic, event-driven paper trader that only acts on what it had received by the time
   it acts (audit Section E, phases 1 and 2).
   - Input: events from parse.js, each with `at` (received) and `req` (requested), fed in arrival order by the runtime,
     plus tick(at) about once a second. Output: quote requests (requests()), state (save()), a page view (view()) and
     event-log records (drain()).
   - Eligibility starts when the last required check arrived, never at the crossing (Finding 01).
   - A decision becomes an order; the order fills only from a Jupiter quote requested after the decision, with a latency
     allowance and network costs, or fails (Findings 02, 13). Exits get priority over entries (Finding 11).
   - Positions are marked from a fresh sell quote, else the curve/pool model at a fresh price, else UNPRICEABLE with the
     last value and its age next to a worst case (Finding 12). SOL/USD is only ever looked up backwards.
   - Silence longer than gapS is a coverage gap: open orders are cancelled, watches re-arm, and what the rules would have
     done inside the gap is only recorded as hypothetical, never booked (Finding 19).
   Paper only: a quote is a price for an exact size; nothing is ever signed or sent. */
const MODEL = require('./model.js');
const G = require('./gates.js');
const SOCIAL = require('./social.js');
const { SOL_MINT } = require('./parse.js');

const DEF = {
  version: '11.0', exp: 'v11', startSol: 10,
  gapS: 90,              // silence longer than this is a coverage gap
  orderTtlS: 30,         // an order not filled by a quote within this is cancelled
  quoteRetryS: 8,        // re-request an order's quote after this (rate limit, error)
  landS: 2,              // decision -> landed transaction, for timestamps
  latency: 0.005,        // adverse price allowance between the quote and landing
  prioSol: 0.0002,       // priority fee per swap (paid, not a price haircut)
  netFeeSol: 0.000005,   // base network fee per swap
  rentSol: 0.00203928,   // token account rent, locked while holding, refunded at close
  pxFreshS: 30,          // a price observation fresh enough to act on or mark from
  quoteDirectS: 20,      // a sell quote used directly as the mark
  quoteFreshS: 90,       // a sell quote fresh enough to calibrate the model
  markQuoteEveryS: 60,   // sell quote per held coin
  feedStaleS: 60,        // no price observation at all for this long halts entries
  solStaleS: 600,        // no SOL/USD for this long halts entries
  exitRetryS: 15,        // wait after a failed exit before trying again
  routeLostAfter: 2,     // consecutive failed sell quotes = exit unavailable
  crossMc: 7000, followS: 75 * 60, keepObsS: 1800, keepCoinS: 3 * 3600, memeWinS: 7200,
  eqFineS: 6 * 3600, eqCoarseS: 900, decKeep: 200, errKeep: 60, keepTrades: 150,
  social: { source: null },   // no approved X / Telegram source connected: attention is 'unavailable', never 'none'
};

function create(opts = {}) {
  const C = Object.assign({}, DEF, opts.config || {});
  const STRATS = opts.strategies || [];
  const byId = new Map(STRATS.map(s => [s.id, s]));
  const S = opts.state && opts.state.v === 1 ? opts.state : fresh();
  const pre = new Map();               // young coins under $7K (memory only; a new run re-learns them)
  const seen = new Set(S.seen);
  // saved states drop the second copy of an audit or report that was never re-checked
  for (const k of Object.values(S.coins)) { if (!k.auditLast) k.auditLast = k.audit; if (!k.rcLast) k.rcLast = k.rc; }
  let outLog = [];
  for (const s of STRATS) if (!S.accts[s.id]) S.accts[s.id] = newAcct(s);

  function fresh() {
    return { v: 1, exp: C.exp, version: C.version, created: null, lastAt: null, runs: [], gaps: [], seen: [], seq: 0, dup: 0,
      sol: null, solT: [], solM: {}, lastPxAt: null, coins: {}, crosses: [], accts: {}, orders: {}, q: {}, hypo: [],
      status: { state: 'starting', why: ['no data yet'], since: null }, errors: [], dec: [], n: { cross: 0, eligible: 0, orders: 0, fills: 0, fails: 0 } };
  }
  function newAcct(s) {
    return { id: s.id, kind: s.kind, label: s.label, locked: s.locked || null, start: null, cash: C.startSol, rent: 0, pos: null, trades: [],
      watch: [], eq: [], eqT: 0, peak: C.startSol, mdd: 0, peakLo: C.startSol, mddLo: 0, cool: {}, n: { signals: 0, orders: 0, fills: 0, fails: 0 } };
  }

  // ------------------------------------------------------------------ bookkeeping
  const r6 = v => v == null || !isFinite(v) ? v : +v.toPrecision(7);
  function log(kind, o) { outLog.push(Object.assign({ k: kind, at: S.lastAt }, o)); }
  function dec(acct, kind, text, m, extra) {
    const d = Object.assign({ at: S.lastAt, a: acct || '', k: kind, t: text, m: m || null }, extra || {});
    S.dec.push(d); if (S.dec.length > C.decKeep) S.dec.splice(0, S.dec.length - C.decKeep);
    log('decision', d);
  }
  function err(text) { S.errors.push([S.lastAt, String(text).slice(0, 160)]); if (S.errors.length > C.errKeep) S.errors.shift(); }
  function remember(id) { seen.add(id); S.seen.push(id); if (S.seen.length > 600) seen.delete(S.seen.shift()); }
  /* The engine's clock only moves forward; a silence longer than gapS inside a run is also a gap. */
  function advance(at, type) {
    if (!isFinite(at)) return S.lastAt;
    if (S.created == null) S.created = at;
    if (S.lastAt != null && type !== 'run_start' && at - S.lastAt > C.gapS) openGap(S.lastAt, at, 'stall', null);
    if (S.lastAt == null || at > S.lastAt) S.lastAt = at;
    return S.lastAt;
  }

  // ------------------------------------------------------------------ SOL/USD: only values known at or before t
  function solAt(t) {
    let best = null;
    for (const [a, px] of S.solT) if (a <= t && (!best || a > best[0])) best = [a, px];
    const m = Math.floor(t / 60) * 60 - 60;       // the last minute candle that had closed by t
    for (let k = 0; k < 240; k++) { const px = S.solM[m - k * 60]; if (px) { const a = m - k * 60 + 60; if (!best || a > best[0]) best = [a, px]; break; } }
    return best && t - best[0] <= 4 * 3600 ? best[1] : null;
  }
  function solNow() { return S.sol && S.lastAt - S.sol.at <= C.solStaleS ? S.sol.px : null; }

  // ------------------------------------------------------------------ coins
  function newCoin(p, at) {
    return { m: p.m, sym: p.sym || '', name: p.name || '', t0: p.t0 || null, first: p.first || at, quote: p.quote || null, bc: p.bc || null, pool: p.pool || null,
      words: G.words(p.name, p.sym), cross: null, stage: 'curve', stageAt: at, last: p.last || null, hi: p.hi || 0, hiAt: p.hiAt || null, chi: 0,
      obs: p.obs || [], bars: p.bars || [], bar: p.bar || null, flow: p.flow || [], snaps: [], cs: {}, audit: null, auditLast: null, rc: null, rcLast: null, dec: 6,
      g0: null, gs: null, meme: null, sq: null, sqFails: 0, invalid: null, claims: null, used: 0 };
  }
  function coinPx(k, pairs, at) {
    const pf = pairs.find(p => p.dex === 'pumpfun'), ps = pairs.find(p => p.dex === 'pumpswap'), main = ps || pf;
    if (pf && pf.pair) k.bc = pf.pair;
    if (ps && ps.pair) k.pool = ps.pair;
    if (pf && pf.quote) k.quote = pf.quote; else if (main.quote) k.quote = main.quote;
    if (!(main.usd > 0)) { k.invalid = { at, why: 'price missing or not a number' }; return false; }
    const sol = main.quote === 'SOL' && main.native > 0 ? main.native : (solNow() ? main.usd / solNow() : null);
    const mc = main.mc > 0 ? main.mc : main.usd * MODEL.SUPPLY;
    k.last = { at, usd: main.usd, sol, mc, src: main.dex, liq: main.liq || null };
    if (k.invalid && k.invalid.src !== 'jup') k.invalid = null;
    if (main.usd > k.hi) { k.hi = main.usd; k.hiAt = at; }
    if (k.obs) {
      k.obs.push([at, main.usd, sol]); while (k.obs.length && k.obs[0][0] < at - C.keepObsS) k.obs.shift();
      k.flow.push([at, main.b5, main.s5, main.v5, main.liq ? main.liq.usd : null]); while (k.flow.length && k.flow[0][0] < at - C.keepObsS) k.flow.shift();
      barAdd(k, at, main.usd);
      // pool once a PumpSwap pair (or a pool route) is seen, and it stays so; migrating = the curve is complete (or nearly,
      // and a quote found no route) with no pool confirmed yet
      const prog = sol ? MODEL.curveProgress(sol * MODEL.SUPPLY) : 0;
      const stage = ps || k.stage === 'pool' ? 'pool' : prog >= 0.999 || (k.stage === 'migrating' && prog >= 0.98) ? 'migrating' : 'curve';
      if (stage !== k.stage) { log('stage', { m: k.m, from: k.stage, to: stage }); k.stage = stage; k.stageAt = at; }
      const cl = pairs.map(p => p.claims).find(Boolean);
      if (cl) k.claims = { at, socials: cl.socials, webs: cl.webs };
    }
    return true;
  }
  /* 1-minute bars from our own price observations (open = first seen in the minute, close = last). A bar is complete,
     and usable, only once an event at or after the minute's end has arrived. */
  function barAdd(k, at, usd) {
    const t = Math.floor(at / 60) * 60;
    if (k.bar && k.bar.t !== t) { k.bars.push([k.bar.t, k.bar.o, k.bar.h, k.bar.l, k.bar.c, k.bar.n]); if (k.bars.length > 30) k.bars.shift(); k.bar = null; }
    if (!k.bar) k.bar = { t, o: usd, h: usd, l: usd, c: usd, n: 0 };
    k.bar.h = Math.max(k.bar.h, usd); k.bar.l = Math.min(k.bar.l, usd); k.bar.c = usd; k.bar.n++;
  }
  function lastBar(k, at) {
    if (k.bar && k.bar.t + 60 <= at) { k.bars.push([k.bar.t, k.bar.o, k.bar.h, k.bar.l, k.bar.c, k.bar.n]); if (k.bars.length > 30) k.bars.shift(); k.bar = null; }
    return k.bars.length ? k.bars[k.bars.length - 1] : null;
  }
  function promote(p, at, mc) {
    const k = newCoin(p, at);
    k.cross = { at, mc };
    S.coins[k.m] = k; pre.delete(k.m);
    S.crosses.push([at, k.m, k.words]);
    S.n.cross++;
    log('cross', { m: k.m, sym: k.sym, mc, t0: k.t0 });
    return k;
  }
  /* Freshness of a coin's price for acting on it: null if usable, else why not. */
  function blocked(k, at) {
    if (!k || !k.last) return 'no price yet';
    if (k.invalid) return 'unreadable data: ' + k.invalid.why;
    if (at - k.last.at > C.pxFreshS) return `price ${Math.round(at - k.last.at)} s old`;
    if (k.stage === 'migrating') return 'graduating: curve complete, pool not confirmed';
    if (!k.last.sol) return 'no SOL price for it';
    return null;
  }
  function high(k) { return Math.max(k.hi || 0, k.chi || 0); }
  function liqOf(k) { return k.stage === 'pool' && k.last ? k.last.liq : null; }

  // ------------------------------------------------------------------ gates
  function evalGates(k, at) {
    if (!k.cross) return;
    k.social = SOCIAL.assess(k, at, C.social);
    if (!k.g0 && k.audit && k.rc) {   // the legacy rule sets decide once, when both first checks are in
      k.meme = G.memeScore(k.words, S.crosses, k.cross.at, k.m, C.memeWinS);
      const decidedAt = Math.max(k.audit.at, k.rc.at);
      k.g0 = { at: decidedAt, eligibleAt: Math.max(k.cross.at, decidedAt), score: +G.legacyScore(k).toFixed(2), r: {} };
      for (const s of STRATS) if (s.gate === 'legacy') {
        const g = G.legacy(k, s.Cg);
        k.g0.r[s.id] = g.ok ? 1 : 0;
        log('gates', { m: k.m, a: s.id, set: 'legacy', ok: g.ok, res: g.res.map(r => [r.id, r.v, r.legacyPass ? 1 : 0]), cross: k.cross.at, auditAt: k.audit.at, rcAt: k.rc.at });
        if (g.ok) { S.n.eligible++; const A = S.accts[s.id]; if (A.start != null) s.onEligible(ctx, A, k, k.g0.eligibleAt, g); }
      }
    }
    const a = k.auditLast, r = k.rcLast;
    if (a && r) {
      const g = G.strict(Object.assign({}, k, { audit: a, rc: r }));
      const was = k.gs && k.gs.ok;
      k.gs = { at: Math.max(a.at, r.at), ok: g.ok, unknown: g.unknown, failed: g.failed, res: g.res.map(x => [x.id, x.v, x.text]), eligibleAt: g.ok ? (was ? k.gs.eligibleAt : Math.max(k.cross.at, a.at, r.at)) : null };
      if (g.ok !== !!was) log('gates', { m: k.m, set: 'strict', ok: g.ok, unknown: g.unknown, failed: g.failed });
      if (g.ok && !was) for (const s of STRATS) if (s.gate === 'strict') { const A = S.accts[s.id]; if (A.start != null && s.onEligible) s.onEligible(ctx, A, k, k.gs.eligibleAt, g); }
      if (!g.ok && was) for (const s of STRATS) if (s.onGateLost) { const A = S.accts[s.id]; if (A.start != null) s.onGateLost(ctx, A, k, at, g); }
    }
  }

  // ------------------------------------------------------------------ orders and quotes
  const keyOf = (inMint, outMint, amount) => `${inMint}>${outMint}:${amount}`;
  function openOrder(A) { for (const o of Object.values(S.orders)) if (o.acct === A.id) return o; return null; }
  /* An order: side 'buy' with stake (SOL) or 'sell' of the whole position. limits: { maxPx, maxImpact } for buys. */
  function place(A, o, at) {
    const k = S.coins[o.m];
    const id = `${A.id}:${++S.seq}`;
    const amount = o.side === 'buy' ? Math.round(o.stake * 1e9) : A.pos.raw;
    const ord = Object.assign({ id, acct: A.id, at, ttl: at + C.orderTtlS, tries: 0 }, o, {
      key: o.side === 'buy' ? keyOf(SOL_MINT, o.m, amount) : keyOf(o.m, SOL_MINT, amount), amount, sym: k ? k.sym : '' });
    S.orders[id] = ord; A.n.orders++; S.n.orders++;
    const q = S.q[ord.key] || (S.q[ord.key] = { key: ord.key, inMint: o.side === 'buy' ? SOL_MINT : o.m, outMint: o.side === 'buy' ? o.m : SOL_MINT, amount, sentAt: null, pri: 9 });
    q.pri = Math.min(q.pri, o.side === 'sell' ? 0 : 1);
    log('order', { id, a: A.id, side: o.side, m: o.m, amount, why: o.why, sigAt: o.sigAt, sigPx: o.sigPx, maxPx: o.maxPx });
    return ord;
  }
  function fail(o, at, why) {
    delete S.orders[o.id];
    const A = S.accts[o.acct]; A.n.fails++; S.n.fails++;
    log('fail', { id: o.id, a: o.acct, side: o.side, m: o.m, why });
    const s = byId.get(o.acct);
    if (o.side === 'sell' && A.pos) {
      A.pos.exitFails = (A.pos.exitFails || 0) + 1; A.pos.retryAt = at + C.exitRetryS;
      if (/no route/.test(why) && A.pos.exitFails >= C.routeLostAfter) setState(A, A.pos, 'exit_unavailable', why, at);
      dec(A.id, 'exit-fail', `${s ? s.label : A.id}: could not sell ${o.sym} (${why}); trying again`, o.m);
    } else dec(A.id, 'order-fail', `${s ? s.label : A.id}: buy of ${o.sym} not filled (${why})`, o.m);
    if (s && s.onFail) s.onFail(ctx, A, o, why, at);
  }
  function setState(A, pos, st, why, at) {
    if (pos.state === st) return;
    pos.states = pos.states || [];
    pos.states.push([at, st, String(why || '').slice(0, 120)]);
    if (pos.states.length > 20) pos.states.shift();
    pos.state = st;
    log('review', { a: A.id, m: pos.m, state: st, why });
  }
  /* A quote arrived: fill or fail the orders waiting for exactly this route and size, update marks and route health. */
  function onQuote(ev, at) {
    const key = keyOf(ev.inMint, ev.outMint, ev.amount);
    const q = S.q[key];
    if (q) { q.gotAt = at; if (ev.ok || !ev.retry) q.done = at; }
    const sellOf = ev.outMint === SOL_MINT ? ev.inMint : null, k = sellOf ? S.coins[sellOf] : S.coins[ev.outMint];
    if (k && ev.ok && ev.labels && ev.labels.length) {
      const pool = ev.labels.some(l => /pump/i.test(l) && /amm|swap/i.test(l)), curve = ev.labels.some(l => /^pump\.?fun$/i.test(l));
      if (pool && k.stage !== 'pool') { log('stage', { m: k.m, from: k.stage, to: 'pool', via: 'quote route' }); k.stage = 'pool'; k.stageAt = at; }
      else if (curve && k.stage === 'migrating') k.curveRouteAt = at;
    }
    if (k && sellOf) {
      if (ev.ok) {
        const v = ev.outAmount / 1e9;
        const p = k.last && at - k.last.at <= C.pxFreshS && k.last.sol ? k.last : null;
        const mod = p ? MODEL.sellOut(ev.amount / 10 ** k.dec, p.sol, k.stage === 'pool' ? 'pool' : 'curve', liqOf(k), at).sol : null;
        k.sq = { at, req: ev.req, amount: ev.amount, out: v, impact: ev.impact, cal: mod > 0 ? Math.max(0.2, Math.min(1.5, v / mod)) : null };
        k.sqFails = 0;
      } else if (!ev.retry) { k.sqFails++; k.sqFailAt = at; k.sqWhy = ev.why; }
    }
    if (k && !ev.ok && !ev.retry && k.stage === 'curve' && k.last && k.last.sol && MODEL.curveProgress(k.last.sol * MODEL.SUPPLY) >= 0.98) {
      log('stage', { m: k.m, from: 'curve', to: 'migrating', via: 'no route at the end of the curve' }); k.stage = 'migrating'; k.stageAt = at;
    }
    for (const o of Object.values(S.orders)) {
      if (o.key !== key || !(ev.req >= o.at)) continue;   // only a quote requested after the decision can fill it
      if (!ev.ok) { if (!ev.retry) fail(o, at, ev.why); continue; }
      if (o.side === 'buy') fillBuy(o, ev, at); else fillSell(o, ev, at);
    }
    if (k && sellOf && !ev.ok && !ev.retry) for (const A of Object.values(S.accts)) if (A.pos && A.pos.m === k.m && k.sqFails >= C.routeLostAfter) setState(A, A.pos, 'exit_unavailable', 'no sell route: ' + ev.why, at);
  }
  function fillBuy(o, ev, at) {
    const A = S.accts[o.acct], k = S.coins[o.m], s = byId.get(o.acct);
    if (A.pos) { fail(o, at, 'already holding'); return; }
    if (k.stage === 'migrating' && !(ev.labels || []).some(l => /amm|swap/i.test(l))) { fail(o, at, 'graduating: no fills until the pool is confirmed'); return; }
    const raw = Math.floor(ev.outAmount * (1 - C.latency)), qty = raw / 10 ** k.dec;
    if (!(qty > 0)) { fail(o, at, 'empty quote'); return; }
    const px = o.stake / qty;
    if (o.maxPx && px > o.maxPx) { fail(o, at, `price moved: ${((px / (o.sigPx || o.maxPx) - 1) * 100).toFixed(1)}% above the signal`); return; }
    if (o.maxImpact != null && ev.impact != null && ev.impact > o.maxImpact) { fail(o, at, `price impact ${(ev.impact * 100).toFixed(1)}% over the ${(o.maxImpact * 100).toFixed(0)}% limit`); return; }
    const fixed = C.prioSol + C.netFeeSol;
    if (A.cash < o.stake + fixed + C.rentSol - 1e-12) { fail(o, at, 'not enough cash'); return; }
    delete S.orders[o.id];
    A.cash -= o.stake + fixed + C.rentSol; A.rent += C.rentSol;
    const mkt = k.last && at - k.last.at <= C.pxFreshS ? k.last.sol : null;
    const pos = { id: o.id, m: o.m, sym: k.sym, kind: A.kind, sigAt: o.sigAt, sigPx: o.sigPx, at: o.at, quoteReq: ev.req, quoteAt: at, fillAt: at + C.landS,
      stake: o.stake, qty, raw, dec: k.dec, px, mkt, cost: o.stake + fixed, rent: C.rentSol, impact: ev.impact, route: ev.labels, stage: k.stage,
      slip: o.sigPx ? px / o.sigPx - 1 : null, why: o.why, thesis: o.thesis || null, state: 'healthy', states: [], rules: {}, flags: [],
      mark: null, mae: 0, mfe: 0, maeLo: 0, peakV: null, exitFails: 0, snap: o.snap || null };
    A.pos = pos; A.n.fills++; S.n.fills++;
    if (s && s.onFill) s.onFill(ctx, A, pos, at);
    log('fill', { id: o.id, a: A.id, side: 'buy', m: o.m, stake: o.stake, qty, px, mkt, impact: ev.impact, route: ev.labels, quoteReq: ev.req, quoteAt: at, slip: pos.slip, rules: pos.rules, flags: pos.flags });
    dec(A.id, 'buy', `${s ? s.label : A.id}: bought ${o.stake.toFixed(2)} SOL of ${k.sym} (${o.why})`, o.m, { px, slip: pos.slip });
    markPos(A, pos, at);
  }
  function fillSell(o, ev, at) {
    const A = S.accts[o.acct], pos = A.pos, s = byId.get(o.acct);
    if (!pos || pos.m !== o.m) { fail(o, at, 'nothing to sell'); return; }
    delete S.orders[o.id];
    const fixed = C.prioSol + C.netFeeSol, proceeds = ev.outAmount / 1e9 * (1 - C.latency);
    A.cash += proceeds - fixed + pos.rent; A.rent -= pos.rent;
    const net = proceeds - fixed - pos.cost;
    const tr = { id: pos.id, m: pos.m, sym: pos.sym, kind: pos.kind, sigAt: pos.sigAt, sigPx: pos.sigPx, at: pos.at, quoteReq: pos.quoteReq, quoteAt: pos.quoteAt, fillAt: pos.fillAt, stake: pos.stake,
      qty: pos.qty, px: pos.px, mkt: pos.mkt, cost: pos.cost, impact: pos.impact, slip: pos.slip, why: pos.why, rules: pos.rules, flags: pos.flags, thesis: pos.thesis,
      exitAt: o.at, exitQuoteReq: ev.req, exitQuoteAt: at, exitFillAt: at + C.landS, exitWhy: o.why, exitReason: o.reason, exitImpact: ev.impact, exitRoute: ev.labels,
      exitMark: o.markV, proceeds, net, ret: net / pos.cost, mae: pos.mae, mfe: pos.mfe, maeLo: pos.maeLo, holdS: at + C.landS - pos.fillAt, states: pos.states,
      fees: { fixed: 2 * fixed, latency: (pos.qty * pos.px * C.latency / (1 - C.latency)) + proceeds * C.latency / (1 - C.latency) }, late: o.late || null };
    A.trades.push(tr); A.pos = null; A.n.fills++; S.n.fills++;
    log('fill', { id: o.id, a: A.id, side: 'sell', m: pos.m, proceeds, net, ret: tr.ret, reason: o.reason, impact: ev.impact, route: ev.labels, quoteReq: ev.req, quoteAt: at });
    dec(A.id, net >= 0 ? 'win' : 'loss', `${s ? s.label : A.id}: sold ${pos.sym} (${o.why}), ${net >= 0 ? '+' : ''}${net.toFixed(3)} SOL (${(tr.ret * 100).toFixed(1)}%)`, pos.m, { net, ret: tr.ret });
    if (s && s.onClose) s.onClose(ctx, A, tr, at);
  }
  function exitOrder(A, r, at) {
    const pos = A.pos;
    setState(A, pos, 'exit_pending', r.why, at);
    place(A, { side: 'sell', m: pos.m, why: r.why, reason: r.reason, markV: pos.mark ? pos.mark.v : null, late: r.late || null }, at);
  }

  // ------------------------------------------------------------------ marks and the equity ledger
  function markPos(A, pos, at) {
    const k = S.coins[pos.m], fixed = C.prioSol + C.netFeeSol;
    const p = k && k.last && at - k.last.at <= C.pxFreshS && !k.invalid && k.last.sol ? k.last : null;
    let v = null, src = 'u', why = '';
    const sq = k && k.sq;
    if (k && k.stage === 'migrating') {   // only a successful quote newer than the migration and the last failed one prices it
      if (sq && sq.at > Math.max(k.stageAt, k.sqFailAt || 0) && sq.amount === pos.raw && at - sq.at <= C.quoteDirectS) { v = sq.out * (1 - C.latency) - fixed; src = 'q'; }
      else why = 'graduating';
    } else if (sq && sq.amount === pos.raw && at - sq.at <= C.quoteDirectS) { v = sq.out * (1 - C.latency) - fixed; src = 'q'; }
    else if (p) {
      v = MODEL.sellOut(pos.qty, p.sol, k.stage === 'pool' ? 'pool' : 'curve', liqOf(k), at).sol * (1 - C.latency);
      if (sq && sq.cal && at - sq.at <= C.quoteFreshS) { v *= sq.cal; src = 'c'; } else src = 'm';
      v -= fixed;
    } else why = !k || !k.last ? 'no price' : k.invalid ? 'unreadable data' : `price ${Math.round(at - k.last.at)} s old`;
    if (pos.state === 'exit_unavailable') { src = v != null ? src : 'u'; why = why || 'no sell route'; }
    const worst = Math.max(0, MODEL.worstOut(pos.qty, k && k.stage === 'curve' ? 'curve' : 'pool', at) * (1 - C.latency) - fixed);
    const prev = pos.mark;
    pos.mark = { at, v: v != null ? Math.max(0, v) : null, src, why, worst, last: v != null ? Math.max(0, v) : prev ? prev.last : null, lastAt: v != null ? at : prev ? prev.lastAt : null };
    if (v != null) {
      const r = v / pos.cost - 1;
      pos.mae = Math.min(pos.mae, r); pos.mfe = Math.max(pos.mfe, r);
      pos.peakV = Math.max(pos.peakV || 0, v);
    }
    pos.maeLo = Math.min(pos.maeLo, (v != null ? Math.min(v, Math.max(worst, 0)) : worst) / pos.cost - 1);
  }
  function equity(A) {
    const base = A.cash + A.rent;
    if (!A.pos) return { eq: base, lo: base, src: 'c' };
    const mk = A.pos.mark || {};
    const v = mk.v != null ? mk.v : mk.last != null ? mk.last : A.pos.cost;
    return { eq: base + v, lo: base + (mk.worst || 0), src: mk.v != null ? mk.src : 'u', age: mk.v != null ? 0 : mk.lastAt ? S.lastAt - mk.lastAt : null };
  }
  function ledger(A, at) {
    const t = Math.floor(at / 60) * 60;
    if (A.eqT >= t) return;
    A.eqT = t;
    const e = equity(A);
    A.eq.push([t, r6(e.eq), r6(e.lo), e.src]);
    if (e.src !== 'u') { A.peak = Math.max(A.peak, e.eq); A.mdd = Math.min(A.mdd, e.eq / A.peak - 1); }
    A.peakLo = Math.max(A.peakLo, e.lo); A.mddLo = Math.min(A.mddLo, e.lo / A.peakLo - 1);
    // older than eqFineS: one row per 15 min; older than 3 days: one per hour (each the bucket's lowest equity, so
    // drawdowns survive the compaction)
    if (t % 900 === 0) { A.eq = compactRows(A.eq, t - 3 * 86400, 3600); A.eq = compactRows(A.eq, t - C.eqFineS, C.eqCoarseS); }
  }
  function compactRows(rows, cut, bucket) {
    const out = [];
    for (const r of rows) {
      if (r[0] >= cut) { out.push(r); continue; }
      const b = Math.floor(r[0] / bucket) * bucket, last = out[out.length - 1];
      if (last && last[0] === b) { if (r[1] < last[1]) last[1] = r[1]; if (r[2] < last[2]) last[2] = r[2]; if (r[3] === 'u') last[3] = 'u'; }
      else out.push([b, r[1], r[2], r[3]]);
    }
    return out;
  }

  // ------------------------------------------------------------------ coverage gaps and hypotheticals
  function openGap(from, to, why, run) {
    const g = { id: 'g' + (++S.seq), from, to, why, run, cancelled: [], open: [], hypo: [] };
    for (const o of Object.values(S.orders)) { g.cancelled.push([o.id, o.side, o.m]); fail(o, to, why === 'offline' ? 'server offline' : 'server stalled'); }
    for (const A of Object.values(S.accts)) {
      for (const w of A.watch) if (!w.done) { w.ready = false; w.armed = false; w.rearmAt = to; }
      if (A.pos) { g.open.push({ a: A.id, m: A.pos.m, pos: A.pos.id, last: A.pos.mark ? A.pos.mark.last : null, rules: A.pos.rules, qty: A.pos.qty, stage: A.pos.stage }); if (A.pos.mark) A.pos.mark.v = null; }
    }
    S.gaps.push(g); if (S.gaps.length > 60) S.gaps.shift();
    log('gap', { id: g.id, from, to, why, run, cancelled: g.cancelled.length, open: g.open.length });
    dec('', 'gap', `No data from ${new Date(from * 1000).toISOString().slice(11, 19)} to ${new Date(to * 1000).toISOString().slice(11, 19)} UTC (${why}). Nothing is booked for that time; open orders were cancelled and watches must see a fresh setup.`, null, { gap: g.id });
  }
  /* Candles received after a gap: what the held positions' rules would have done inside it. Recorded as hypothetical only. */
  function hypothetical(k, at) {
    for (const g of S.gaps) for (const o of g.open) {
      if (o.m !== k.m || g.hypo.some(h => h.a === o.a)) continue;
      const mins = Object.keys(k.cs).map(Number).filter(t => t >= Math.floor(g.from / 60) * 60 && t < g.to).sort((a, b) => a - b);
      if (!mins.length || mins[mins.length - 1] + 60 < Math.floor(g.to / 60) * 60) continue;   // not covered yet
      let h = { a: o.a, m: o.m, gap: g.id, rule: 'none', at: null };
      for (const t of mins) {
        const [, hiU, loU] = k.cs[t], s = solAt(t + 60);
        if (!s) { h = { a: o.a, m: o.m, gap: g.id, rule: 'unknown', why: 'no SOL/USD before that minute' }; break; }
        if (o.rules.slPx && loU / s <= o.rules.slPx) { h = { a: o.a, m: o.m, gap: g.id, rule: 'sl', at: t, px: o.rules.slPx }; break; }
        if (o.rules.tpPx && hiU / s >= o.rules.tpPx) { h = { a: o.a, m: o.m, gap: g.id, rule: 'tp', at: t, px: o.rules.tpPx }; break; }
      }
      g.hypo.push(h); S.hypo.push(h); if (S.hypo.length > 200) S.hypo.shift();
      log('hypothetical', h);
    }
  }

  // ------------------------------------------------------------------ status: the kill switch for entries
  function updateStatus(at) {
    const why = [];
    if (S.lastPxAt == null || at - S.lastPxAt > C.feedStaleS) why.push(S.lastPxAt == null ? 'no price feed yet' : `no prices for ${Math.round(at - S.lastPxAt)} s`);
    if (!solNow()) why.push('SOL/USD unknown or stale');
    const recent = S.errors.filter(e => e[0] > at - 120 && /^schema/.test(e[1]));
    if (recent.length >= 3) why.push('API format changed: ' + recent[recent.length - 1][1].slice(7, 80));
    const st = why.length ? 'incomplete' : 'forward';
    if (st !== S.status.state) { S.status.since = at; log('status', { state: st, why }); }
    S.status.state = st; S.status.why = why;
  }

  // ------------------------------------------------------------------ the strategies' view of the world
  const ctx = {
    C, MODEL, G,
    get at() { return S.lastAt; },
    coin: m => S.coins[m], blocked, high, liqOf, lastBar, solAt, solNow, dec, log, err,
    halted: () => S.status.state !== 'forward' ? S.status.why.join('; ') : null,
    openOrder,
    buy(A, o, at) {
      if (A.pos || openOrder(A)) return null;
      A.n.signals++;
      return place(A, Object.assign({ side: 'buy' }, o), at);
    },
    exit: exitOrder,
    setState,
    coins: () => S.coins,
    accts: () => S.accts,
  };

  // ------------------------------------------------------------------ events
  function ingest(ev) {
    if (!ev || !ev.type) return;
    if (ev.id != null) { if (seen.has(ev.id)) { S.dup++; return; } remember(ev.id); }
    const prev = S.lastAt;
    const at = advance(ev.at, ev.type);
    if (at == null) return;
    switch (ev.type) {
      case 'run_start': {
        // the saved state ends where the last run stopped (or last saved before a crash): the time between is a gap
        if (prev != null && ev.at - prev > C.gapS) openGap(prev, ev.at, 'offline', ev.run);
        S.runs.push({ run: ev.run, at: ev.at, sha: ev.sha || null }); if (S.runs.length > 60) S.runs.shift();
        for (const s of STRATS) { const A = S.accts[s.id]; if (A.start == null) { A.start = ev.at; A.eqT = 0; dec(A.id, 'start', `${s.label} starts with ${C.startSol} paper SOL`, null); } }
        break;
      }
      case 'coin': if (!S.coins[ev.m] && !pre.has(ev.m) && ev.t0 && at - ev.t0 < C.followS) pre.set(ev.m, preCoin(ev, ev.t0, at)); break;
      case 'px': {
        let k = S.coins[ev.m], p = k ? null : pre.get(ev.m);
        const pf = ev.pairs.find(x => x.dex === 'pumpfun');
        if (!k && !p) {   // a young coin first seen through prices (a run restarted while the legacy bots followed it)
          const t0 = pf && pf.created ? pf.created : null;
          if (!pf || !t0 || at - t0 > C.followS) break;
          p = preCoin(pf, t0, at); p.m = ev.m; pre.set(ev.m, p);
        }
        S.lastPxAt = at;
        if (k) { k.used = at; coinPx(k, ev.pairs, at); if (k.invalid) err(`field dexscreener ${k.sym}: ${k.invalid.why}`); break; }
        if (!coinPx(p, ev.pairs, at)) break;
        if (p.t0 && at - p.t0 > C.followS) { pre.delete(ev.m); break; }
        if (p.quote === 'SOL' && p.bc && p.last.mc >= C.crossMc) { const k2 = promote(p, at, p.last.mc); coinPx(k2, ev.pairs, at); }
        break;
      }
      case 'jup': {
        const k = S.coins[ev.m];
        if (!k) break;
        k.used = at;
        if (ev.sym && !k.sym) k.sym = ev.sym;
        if (ev.dec != null && ev.dec >= 0 && ev.dec <= 12) k.dec = ev.dec;
        const a = Object.assign({ at, req: ev.req }, ev.audit, { holders: ev.holders, org: ev.org, soc: { tw: !!ev.claims.tw, web: !!ev.claims.web, tg: !!ev.claims.tg }, bad: ev.bad && ev.bad.length ? ev.bad : undefined });
        if (ev.bad && ev.bad.some(b => /^audit/.test(b))) { k.invalid = { at, why: 'audit fields: ' + ev.bad.join(', '), src: 'jup' }; err(`field jupiter ${k.sym}: ${ev.bad.join(', ')}`); }
        else if (k.invalid && k.invalid.src === 'jup') k.invalid = null;
        if (!k.audit) { k.audit = a; log('audit', { m: k.m, src: 'jupiter', req: ev.req, at, audit: ev.audit, holders: ev.holders, bad: ev.bad }); }
        k.auditLast = a;
        k.snaps.push({ at, srcAt: ev.srcAt, usd: ev.usd, mc: ev.mc, liq: ev.liq, holders: ev.holders, org: ev.org, s5: ev.s5, s1h: ev.s1h });
        while (k.snaps.length && k.snaps[0].at < at - C.keepObsS) k.snaps.shift();
        if (ev.claims && (ev.claims.tw || ev.claims.web || ev.claims.tg)) k.jclaims = { at, tw: ev.claims.tw, web: ev.claims.web, tg: ev.claims.tg };
        evalGates(k, at);
        break;
      }
      case 'rc': {
        const k = S.coins[ev.m];
        if (!k) break;
        const r = ev.missing ? { at, req: ev.req, missing: true, invalid: !!ev.invalid } : { at, req: ev.req, score: ev.score, sn: ev.sn, danger: ev.danger || [], risks: ev.risks || [] };
        if (!k.rc) { k.rc = r; log('audit', { m: k.m, src: 'rugcheck', req: ev.req, at, rc: r }); }
        k.rcLast = r;
        evalGates(k, at);
        break;
      }
      case 'quote': onQuote(ev, at); break;
      case 'sol': S.sol = { px: ev.px, at }; S.solT.push([at, ev.px]); while (S.solT.length > 150) S.solT.shift(); break;
      case 'solc': for (const [t, px] of ev.rows) if (t + 60 <= at) S.solM[t] = px; pruneSol(at); break;
      case 'candles': {
        const k = Object.values(S.coins).find(c => c.bc === ev.pool || c.pool === ev.pool);
        if (!k) break;
        for (const [t, o, h, l, c] of ev.rows) if (t + 120 <= at) { k.cs[t] = [o, h, l, c]; if (h > k.chi) k.chi = h; }
        const ts = Object.keys(k.cs).map(Number).sort((a, b) => a - b);
        for (const t of ts.slice(0, Math.max(0, ts.length - 300))) delete k.cs[t];
        hypothetical(k, at);
        break;
      }
      case 'schema': err(`schema ${ev.src}: ${ev.why}`); break;
      case 'social': { const k = S.coins[ev.m]; if (k) { SOCIAL.ingest(k, ev, at, C.social); log('social', { m: k.m, src: ev.src, id: ev.id, status: k.social.status }); } break; }
      default: break;
    }
    evaluate(at);
  }
  /* a young coin under $7K: its recent price history is kept (in memory) so momentum is known the moment it crosses */
  function preCoin(x, t0, at) { return { m: x.m, sym: x.sym || '', name: x.name || '', t0, first: at, hi: 0, obs: [], flow: [], bars: [], bar: null, stage: 'curve', stageAt: at }; }
  function pruneSol(at) { for (const t of Object.keys(S.solM)) if (+t < at - 6 * 3600) delete S.solM[t]; }
  /* Once a second from the runtime: clocks, expiries, marks, the ledger, and decisions that depend on time alone. */
  function tick(at) {
    at = advance(at, 'tick');
    if (at == null) return;
    for (const o of Object.values(S.orders)) if (at > o.ttl) fail(o, at, 'no quote in time');
    evaluate(at);
    for (const A of Object.values(S.accts)) if (A.start != null) ledger(A, at);
    if (!(at - (S.pruneAt || 0) < 60)) { S.pruneAt = at; prune(at); }
  }
  function evaluate(at) {
    updateStatus(at);
    // held positions first (exits outrank entries), then entries
    for (const s of STRATS) {
      const A = S.accts[s.id];
      if (A.start == null || !A.pos) continue;
      markPos(A, A.pos, at);
      if (openOrder(A) || (A.pos.retryAt && at < A.pos.retryAt)) continue;
      const r = s.review(ctx, A, A.pos, at);
      if (r && r.exit) exitOrder(A, r, at);
    }
    for (const s of STRATS) {
      const A = S.accts[s.id];
      if (A.start == null || A.pos || openOrder(A)) continue;
      s.entry(ctx, A, at);
    }
  }
  function prune(at) {
    const keep = new Set();
    for (const A of Object.values(S.accts)) { if (A.pos) keep.add(A.pos.m); for (const w of A.watch) if (!w.done) keep.add(w.m); }
    for (const o of Object.values(S.orders)) keep.add(o.m);
    for (const [m, k] of Object.entries(S.coins)) if (!keep.has(m) && at - Math.max(k.cross ? k.cross.at : 0, k.used || 0) > C.keepCoinS) delete S.coins[m];
    for (const [m, p] of pre) if (at - (p.t0 || p.first) > C.followS) pre.delete(m);
    S.crosses = S.crosses.filter(c => at - c[0] < C.memeWinS + 600);
    for (const [k, q] of Object.entries(S.q)) if (q.done && at - q.done > 120 && !Object.values(S.orders).some(o => o.key === k)) delete S.q[k];
    for (const A of Object.values(S.accts)) {
      A.watch = A.watch.filter(w => !w.done || at - (w.doneAt || w.to) < 6 * 3600);
      // old trades keep their numbers; their full records are in the event log
      for (let i = 0; i < A.trades.length - C.keepTrades; i++) { const t = A.trades[i]; if (t.states) { delete t.states; delete t.snap; delete t.thesis; delete t.exitRoute; t.rules = null; } }
    }
  }

  // ------------------------------------------------------------------ what the runtime should fetch
  /* Quote requests, most urgent first: exits, entries, then one sell quote a minute per held coin (marks and route health). */
  function requests(at) {
    const out = [];
    const want = new Set();
    for (const o of Object.values(S.orders)) {
      const q = S.q[o.key];
      // a quote requested after the decision is needed; re-ask when the last one was lost or rate limited
      const need = q.sentAt == null || q.sentAt < o.at || (!(q.done >= q.sentAt) && at - q.sentAt >= C.quoteRetryS);
      if (need && !want.has(o.key)) { want.add(o.key); out.push({ key: o.key, inMint: q.inMint, outMint: q.outMint, amount: q.amount, pri: o.side === 'sell' ? 0 : 1, why: o.side + ' ' + o.sym }); }
    }
    const held = new Map();
    for (const A of Object.values(S.accts)) if (A.pos && !openOrder(A)) { const h = held.get(A.pos.m); if (!h || A.pos.raw > h) held.set(A.pos.m, A.pos.raw); }
    for (const [m, raw] of held) {
      const k = S.coins[m]; if (!k) continue;
      const key = keyOf(m, SOL_MINT, raw);
      const last = Math.max(k.sq ? k.sq.at : 0, k.sqFailAt || 0, (S.q[key] && S.q[key].sentAt) || 0);
      if (at - last >= C.markQuoteEveryS) {
        if (!S.q[key]) S.q[key] = { key, inMint: m, outMint: SOL_MINT, amount: raw, sentAt: null, pri: 2 };
        out.push({ key, inMint: m, outMint: SOL_MINT, amount: raw, pri: 2, why: 'mark ' + k.sym });
      }
    }
    out.sort((a, b) => a.pri - b.pri);
    return out;
  }
  function sent(key, at) { const q = S.q[key]; if (q) q.sentAt = at; }
  /* Coins the runtime should snapshot (Jupiter: stats, audit re-checks) and price often (DexScreener). */
  function active(at) {
    const hot = new Set(), warm = new Set();
    for (const A of Object.values(S.accts)) { if (A.pos) hot.add(A.pos.m); for (const w of A.watch) if (!w.done && at < w.to) warm.add(w.m); }
    for (const o of Object.values(S.orders)) hot.add(o.m);
    for (const s of STRATS) if (s.interest) for (const m of s.interest(ctx, S.accts[s.id], at)) warm.add(m);
    for (const k of Object.values(S.coins)) if (k.cross && at - k.cross.at < 1800 && (!k.audit || !k.rc) && at - k.cross.at > 60) warm.add(k.m);
    for (const m of hot) warm.delete(m);
    return { hot: [...hot], warm: [...warm] };
  }
  function drain() { const o = outLog; outLog = []; return o; }
  function save() { return S; }

  return { ingest, tick, requests, sent, active, drain, save, state: () => S, ctx, solAt, equity, C, pre: () => pre, markPos };
}
module.exports = { create, DEF };
