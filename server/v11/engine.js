'use strict';
/* v11 paper engine: decisions only from what was observed before them, fills only from executable quotes received
   after them, and nothing credited for time the server was not running.

   The engine is pure and deterministic. The runtime feeds it events (each with `at`, the ms time the runtime received
   it) and calls tick(at); tick returns the quote requests the runtime must make. Its whole state is plain JSON, so it
   is saved and resumed across server runs, and tests can drive it with exact event sequences. */
const E = require('../sniper.js');
const MK = require('./market.js');
const G = require('./gates.js');
const X = require('./model.js');
const FEES = require('./fees.js');
const ST = require('./strategies.js');
const V2 = require('./v2.js');
const FT = require('./features.js');
const TS = require('./tapestate.js');
const V3 = require('./v3.js');

const VERSION = '11.1';            // 11.1: Jupiter-first prices with data times (market.js); 11.0 accounts archived
const GAP_MS = 90000;            // silence longer than this between server runs is a coverage gap
const ORDER_TTL = 30000;         // an order with no quote by then fails
const FEED_STALE_MS = 60000;     // no valid market data on any active coin for this long: entries halt
const MAX_SLIP = { buy: 0.10, sell: 0.60 };   // worst accepted quote vs the decision-time estimate
const DEC = 6;                   // pump.fun token decimals
const KEEP_COIN_MS = 3 * 3600e3; // coins nobody holds or watches are dropped after this
const EQ_EVERY = 120000;         // equity point spacing
const DEDUP = new Set(['crossing', 'audit', 'rugcheck', 'quote', 'rcreport', 'legacy_watch']);
const MARK_Q_CURVE = 60000, MARK_Q_POOL = 30000;   // executable sell quote for each held coin this often
const ROUTE_LOST_AFTER = 2;                       // consecutive failed sell quotes before a coin counts as unsellable
const DROP_UNWATCHED_MS = 20 * 60000;   // a crossed coin no account watches or holds is forgotten after this (unless alive)
const FAST_YOUNG_MS = 20 * 60000;       // every crossed coin gets 5 s prices for its first 20 minutes
const FOLLOW_MS = 3 * 3600e3, FOLLOW_POOL_MS = 8 * 3600e3;   // then 30 s prices while alive: 3 h, or 8 h once it trades on a pool
const alive = (c, at) => !c.deadAt && (at - c.xAt < FOLLOW_MS || (c.stage === 'pool' && at - c.xAt < FOLLOW_POOL_MS));

// opts.accounts: the account set (default: the 7 E0 accounts, HOLD, V2 A/B/C and v3 A3/A3e/B3); replays use it for ablations
function createEngine(opts = {}) {
  let S = null;
  const accountDefs = opts.accounts || (() => ST.accounts().concat(V2.accounts(), V3.accounts()));

  // ------------------------------------------------------------------------------------------------ state
  function init(at) {
    S = { v: VERSION, startedAt: at, lastAt: at, run: null, runs: [], coins: {}, crosses: [], sol: [], accts: {}, orders: {}, seen: {},
      log: [], outbox: [], gaps: [], halted: null, lastFeedAt: 0, nOrders: 0, cq: [] };
    for (const a of accountDefs()) S.accts[a.id] = newAccount(a, at);
    return S;
  }
  function newAccount(a, at) {
    return Object.assign({}, a, { startedAt: at, cash: ST.START_SOL, rent: 0, pos: null, pending: null, watch: {}, seen: {}, trades: [], fails: [],
      eq: [[at, ST.START_SOL, ST.START_SOL]], peak: ST.START_SOL, mdd: 0, n: { orders: 0, fills: 0, fails: 0 } });
  }
  const save = () => JSON.parse(JSON.stringify(Object.assign({}, S, { outbox: [] })));
  function load(s) {
    S = s; S.outbox = []; S.cq = S.cq || [];
    if (S.v !== VERSION) upgrade(S.v);
    // an account whose rules changed revision (e.g. E0 rev 2: the legacy bots' own watchlists) is archived and restarts alone
    for (const a of accountDefs()) {
      const A = S.accts[a.id];
      if (A && (A.rev || 1) !== (a.rev || 1)) { archiveAcct(A, S.lastAt, `rev ${A.rev || 1}`); delete S.accts[a.id];
        log('AccountRestarted', S.lastAt, { acct: a.id, from: A.rev || 1, to: a.rev || 1, why: a.revWhy || 'rules revised' }); }
      if (!S.accts[a.id]) S.accts[a.id] = newAccount(a, S.lastAt);
    }
    return S;
  }
  function archiveAcct(A, at, engine) {
    const eq = equityValue(A);
    S.archive = S.archive || [];
    S.archive.push({ engine, acct: A.id, name: A.name, from: A.startedAt || S.startedAt, to: at, value: eq.known ? +eq.v.toFixed(6) : null, lo: +eq.lo.toFixed(6),
      cash: +A.cash.toFixed(6), trades: A.trades.length, wins: A.trades.filter(t => t.net > 0).length, net: +A.trades.reduce((x, t) => x + t.net, 0).toFixed(6),
      open: A.pos ? { m: A.pos.m, sym: A.pos.sym, cost: A.pos.cost, mark: A.pos.mark ? A.pos.mark.value : null } : null });
    for (const o of Object.values(S.orders)) if (o.status === 'requested' && o.acct === A.id) { o.status = 'cancelled'; o.reason = 'account restarted'; o.doneAt = at; }
  }
  /* A saved state from an older engine: under 11.0 a lagging DexScreener price could overwrite a fresh Jupiter price,
     so its results are not comparable with 11.1's. Every account is archived with its last mark and starts again with
     10 paper SOL; orders in flight are cancelled. Coins, checks and coverage history are kept. */
  function upgrade(from) {
    const at = S.lastAt;
    for (const A of Object.values(S.accts)) archiveAcct(A, at, from);
    for (const o of Object.values(S.orders)) if (o.status === 'requested') { o.status = 'cancelled'; o.reason = 'engine upgrade'; o.doneAt = at; }
    S.accts = {};
    log('EngineUpgraded', at, { from, to: VERSION, why: 'prices now come from Jupiter first (DexScreener lags about 46 s on these coins); every account restarts, earlier results are archived' });
    S.v = VERSION; S.upgradedAt = at;
  }
  function log(type, at, f) {
    const e = Object.assign({ type, at }, f);
    S.log.push(e); if (S.log.length > 1500) S.log.splice(0, S.log.length - 1500);
    S.outbox.push(e);
    return e;
  }
  const drain = () => { const o = S.outbox; S.outbox = []; return o; };
  const accts = () => Object.values(S.accts);

  // ------------------------------------------------------------------------------------------------ events
  function ingest(ev) {
    // duplicates matter for crossings, checks and quotes (an order fills once); repeated snapshots are harmless
    if (ev.id && DEDUP.has(ev.type)) { if (S.seen[ev.id]) { return []; } S.seen[ev.id] = ev.at; }
    if (ev.type === 'run_start') return runStart(ev);
    if (ev.at > S.lastAt) S.lastAt = ev.at;
    switch (ev.type) {
      case 'crossing': return crossing(ev);
      case 'audit': return audit(ev);
      case 'rugcheck': return rugcheck(ev);
      case 'rcreport': return rcreport(ev);
      case 'legacy_watch': return legacyWatch(ev);
      case 'snapshot': return snapshot(ev);
      case 'sol': S.sol.push({ at: ev.at, usd: ev.usd }); if (S.sol.length > 600) S.sol.splice(0, S.sol.length - 600); return [];
      case 'quote': qcheck(ev); return quote(ev);
      // the tape lane (tape.js): exact curve reserves and every trade of the coins that matter, kept in c.tp. No v2.0 or
      // E0 rule reads it; the v3 accounts (tape: true) are valued, reviewed and filled on it while it is live
      case 'tape': case 'curve': {
        const c = S.coins[ev.m];
        curveFills(ev.at, true);                    // orders due before this observation fill on the state before it
        if (!c) return [];
        if (ev.type === 'tape') TS.onTape(c, ev); else TS.onCurve(c, ev);
        curveFills(ev.at, false);
        tapeReview(c, ev.at);
        return [];
      }
      case 'tape_sub': { const c = S.coins[ev.m]; if (c) TS.onSub(c, ev); return []; }
      case 'tape_status': {
        const was = S.tape && S.tape.up;
        S.tape = { up: !!ev.up, at: ev.at, subs: ev.subs || 0, why: ev.why || null };
        if (!ev.up) for (const c of Object.values(S.coins)) if (c.tp) c.tp.sub = false;   // every subscription ended with the socket
        if (!!ev.up !== !!was) log(ev.up ? 'TapeUp' : 'TapeDown', ev.at, { why: ev.why || null });
        return [];
      }
      default: return [];
    }
  }
  // a server run starts: time since the last sign of life is a coverage gap; orders in flight are cancelled
  function runStart(ev) {
    const gapMs = ev.at - S.lastAt;
    for (const o of Object.values(S.orders)) if (o.status === 'requested') cancel(o, gapMs > GAP_MS ? 'server offline' : 'server restarted', ev.at);
    if (gapMs > GAP_MS) {
      const gap = { from: S.lastAt, to: ev.at, run: ev.run, held: [], hypo: [] };
      for (const A of accts()) if (A.pos) { gap.held.push({ acct: A.id, m: A.pos.m, sym: A.pos.sym }); A.pos.gapMs = (A.pos.gapMs || 0) + gapMs; }
      S.gaps.push(gap);
      log('CoverageGap', ev.at, { from: gap.from, to: gap.to, held: gap.held, note: 'nothing in this window is credited to the forward ledger' });
    }
    S.lastAt = Math.max(S.lastAt, ev.at); S.run = ev.run; S.runs.push({ run: ev.run, from: ev.at });
    if (S.runs.length > 200) S.runs.splice(0, S.runs.length - 200);
    return [];
  }
  function crossing(ev) {
    if (ev.boot) return [];                       // approximate bootstrap times are never treated as observed crossings
    if (!S.coins[ev.m]) S.coins[ev.m] = MK.newCoin(ev);
    const c = S.coins[ev.m];
    S.crosses.push([ev.at / 1000, ev.m, c.words]);
    log('CrossingObserved', ev.at, { m: ev.m, sym: c.sym, mc: ev.mcX });
    return [];
  }
  function audit(ev) {
    const c = S.coins[ev.m]; if (!c) return [];
    const a = { reqAt: ev.reqAt, at: ev.at, valid: ev.valid !== false, reason: ev.reason || null, fields: ev.fields || {} };
    if (!c.audit) c.audit = a;                    // the check taken when the coin crossed (what legacy rules use)
    c.auditLatest = a;                            // later refreshes (security can change after entry)
    log('AuditReceived', ev.at, { m: ev.m, reqAt: ev.reqAt, valid: a.valid, reason: a.reason });
    admit(c);
    return [];
  }
  function rugcheck(ev) {
    const c = S.coins[ev.m]; if (!c) return [];
    if (!c.rc) c.rc = { reqAt: ev.reqAt, at: ev.at, valid: ev.valid !== false, reason: ev.reason || null, risks: ev.risks || [], score: ev.score, sn: ev.sn };
    log('RugCheckReceived', ev.at, { m: ev.m, reqAt: ev.reqAt, valid: c.rc.valid });
    admit(c);
    return [];
  }
  // the RugCheck full report: a second source for the dev wallet share (Jupiter leaves it out for most coins)
  function rcreport(ev) {
    const c = S.coins[ev.m]; if (!c) return [];
    const r = { reqAt: ev.reqAt, at: ev.at, valid: ev.valid !== false, reason: ev.reason || null };
    if (r.valid) Object.assign(r, { creatorPct: ev.creatorPct, devWallet: ev.devWallet, devWalletPct: ev.devWalletPct, devHow: ev.devHow, devBound: ev.devBound, devPct: ev.devPct,
      top10: ev.top10, totalHolders: ev.totalHolders, insiders: ev.insiders, risks: ev.risks, score: ev.score, rugged: ev.rugged });
    if (r.valid || !c.rcr) c.rcr = r;
    c.rcrTries = (c.rcrTries || 0) + 1;
    log('RugCheckReportReceived', ev.at, { m: ev.m, reqAt: ev.reqAt, valid: r.valid, devPct: r.devPct, how: r.devHow, reason: r.reason });
    return [];
  }
  /* the legacy bots' own watchlist decision for a coin (sniper_core decide(): checks, plus the 6-slot limit where a
     stronger coin replaces the weakest one far from its buy zone). E0 follows it: an E0 account watches only what its
     legacy bot watches, and stops watching a coin the legacy bot swapped out, from the moment it happened. */
  function legacyWatch(ev) {
    const c = S.coins[ev.m];
    if (c) c.legacyWatch = { at: ev.at, bots: ev.bots || [] };
    for (const [bot, m] of ev.dropped || []) {
      const A = S.accts['E0-' + bot], w = A && A.watch[m];
      if (w && !w.done && ev.at < w.to) { w.to = Math.max(w.from, ev.at); w.dropped = ev.at; log('WatchDropped', ev.at, { acct: A.id, m, why: `the legacy bot swapped it out for ${(c && c.sym) || ev.m}` }); }
    }
    if (c) admit(c);
    return [];
  }
  // a coin becomes eligible for an account only once every input its gates need has been received
  function admit(c) {
    if (!c.audit || !c.rc) return;
    const crosses = S.crosses.filter(x => x[0] * 1000 < c.xAt);
    for (const A of accts()) if (A.kind === 'e0') {
      const r = ST.e0Admit(A, c, crosses);
      if (r) log('EligibilityDecided', r.at, { acct: A.id, m: c.m, sym: c.sym, pass: r.pass, crossedAt: c.xAt, eligibleAt: r.at,
        gates: r.gates.map(x => [x.id, x.status, x.value]) });
    }
  }
  function snapshot(ev) {
    const c = S.coins[ev.m]; if (!c) return [];
    MK.observe(c, ev);
    if (ev.valid !== false) S.lastFeedAt = Math.max(S.lastFeedAt, ev.at);
    else log('DataInvalid', ev.at, { m: ev.m, src: ev.src, reason: ev.reason });
    return [];
  }

  // ------------------------------------------------------------------------------------------------ orders
  function order(A, side, sig, at) {
    const c = S.coins[sig.m], venue = c.stage === 'pool' ? 'pool' : 'curve';
    if (side === 'buy' && A.minStake && A.sizeCap && A.sizeCap[sig.m] < A.minStake) return null;
    const id = `${A.id}:${sig.m}:${side}:${at}`;
    const o = { id, acct: A.id, exp: A.exp, m: sig.m, sym: c.sym, side, reqAt: at, status: 'requested', why: sig.why, reason: sig.reason || null,
      decision: { at, sigAt: sig.sigAt || at, p: sig.p, ps: sig.ps, priceAge: c.last ? at - c.last.at : null, venue } };
    if (sig.contract) o.contract = sig.contract;
    if (side === 'buy') {
      o.size = Math.min(sig.size || A.stake || 1, A.cash - FEES.COSTS.networkFeeSol - FEES.COSTS.ataRentSol, (A.sizeCap && A.sizeCap[sig.m]) || Infinity);
      if (A.minStake && o.size < A.minStake) { log('EntrySkipped', at, { acct: A.id, m: sig.m, why: `size cap ${o.size.toFixed(2)} SOL is under the minimum stake: too thin` }); return null; }
      o.decision.expectOut = X.buyOut(o.size, sig.ps, venue, at).tokens;
    } else {
      o.size = A.pos.qty;
      o.decision.expectOut = X.sellOut(o.size, sig.ps, venue, at).sol;
    }
    // v3 (tape: true) while the coin's tape is live: no quote; the order fills against the curve as last received at or
    // before decision + V3.FILL_MS (curveFills), and the decision-time estimate comes from the same curve
    const onCurve = A.tape && venue === 'curve' && TS.live(S, c);
    if (onCurve) {
      const st = c.tp.last, fee = FEES.feeRate(at / 1000, 'curve', st.ps * E.SUPPLY);
      o.mode = 'curve'; o.fillAt = at + V3.FILL_MS;
      o.decision.curve = { at: st.at, slot: st.slot, ps: st.ps };
      o.decision.expectOut = side === 'buy' ? TS.curveBuy(st, o.size, fee).tokens : TS.curveSell(st, o.size, fee).sol;
      S.cq.push(id);
    }
    S.orders[id] = o; A.pending = id; A.n.orders++; S.nOrders++;
    log('OrderRequested', at, { id, acct: A.id, m: o.m, sym: o.sym, side, size: o.size, why: o.why, decision: o.decision, contract: o.contract || undefined, thesis: side === 'sell' && A.pos.thesis ? A.pos.thesis : undefined, fillAt: o.fillAt });
    if (onCurve) return null;
    return { type: 'quote', orderId: id, m: o.m, side, amount: side === 'buy' ? Math.round(o.size * 1e9) : Math.floor(o.size * 10 ** DEC), venue };
  }
  // v3 curve orders whose fill time has come (strict: only those due before `at`, i.e. before an observation received at `at`)
  function curveFills(at, strict) {
    if (!S.cq.length) return;
    for (const id of S.cq.slice()) {
      const o = S.orders[id];
      if (!o || o.status !== 'requested') { S.cq = S.cq.filter(x => x !== id); continue; }
      if (strict ? o.fillAt >= at : o.fillAt > at) continue;
      S.cq = S.cq.filter(x => x !== id);
      const c = S.coins[o.m], st = c && c.tp && c.tp.last;
      if (!st) { fail(o, 'no curve state from the tape', o.fillAt); continue; }
      if (c.tp.done) { fail(o, 'curve complete: the coin is graduating', o.fillAt); continue; }
      // the fill, as an executable answer from the curve (venue fee inside, like a Jupiter quote), then the usual
      // accounting (drift, network fee, rent, slippage and impact checks) in quote()
      const fee = FEES.feeRate(o.fillAt / 1000, 'curve', st.ps * E.SUPPLY);
      const r = o.side === 'buy' ? TS.curveBuy(st, o.size, fee) : TS.curveSell(st, o.size, fee);
      quote({ type: 'quote', at: o.fillAt, orderId: o.id, m: o.m, side: o.side, inAmount: o.side === 'buy' ? Math.round(o.size * 1e9) : Math.floor(o.size * 10 ** DEC),
        outAmount: o.side === 'buy' ? Math.floor(r.tokens * 10 ** DEC) : Math.floor(r.sol * 1e9), impactPct: r.impact, route: ['pump.fun curve (tape)'], venue: 'curve',
        slot: st.slot, curveAt: st.at, ok: true, valid: true, tape: true });
    }
  }
  /* the fill model check (research/v3_protocol.md section 3): each Jupiter quote for a coin whose tape is live, against
     the curve model's answer for the same amount at that moment */
  function qcheck(ev) {
    if (ev.tape || !ev.ok || ev.valid === false || !(ev.outAmount > 0) || !(ev.inAmount > 0) || ev.venue !== 'curve') return;
    const c = S.coins[ev.m]; if (!c || !TS.live(S, c)) return;
    const st = c.tp.last, fee = FEES.feeRate(ev.at / 1000, 'curve', st.ps * E.SUPPLY);
    const model = ev.side === 'buy' ? TS.curveBuy(st, ev.inAmount / 1e9, fee).tokens * 10 ** DEC : TS.curveSell(st, ev.inAmount / 10 ** DEC, fee).sol * 1e9;
    if (!(model > 0)) return;
    const q = S.qc || (S.qc = { n: 0, gaps: [] });
    q.n++; q.gaps.push([ev.at, +(ev.outAmount / model - 1).toFixed(5), ev.at - st.at, ev.side === 'buy' ? 1 : 0]);
    if (q.gaps.length > 300) q.gaps.splice(0, q.gaps.length - 300);
  }
  function cancel(o, why, at) {
    o.status = 'cancelled'; o.reason = why; o.doneAt = at;
    const A = S.accts[o.acct]; if (A && A.pending === o.id) A.pending = null;
    log('OrderCancelled', at, { id: o.id, acct: o.acct, why });
  }
  function fail(o, why, at) {
    o.status = 'failed'; o.reason = why; o.doneAt = at;
    const A = S.accts[o.acct];
    if (A.pending === o.id) A.pending = null;
    A.n.fails++; A.fails.push({ at, id: o.id, m: o.m, sym: o.sym, side: o.side, why }); if (A.fails.length > 100) A.fails.shift();
    if (o.side === 'buy') { const w = A.watch[o.m]; if (w) w.failUntil = at + 60000; if (A.kind === 'v2') { A.cool = A.cool || {}; A.cool[o.m] = Math.max(A.cool[o.m] || 0, at + 60000); } }
    else if (A.pos) { A.pos.exitFail = { at, why, n: ((A.pos.exitFail && A.pos.exitFail.n) || 0) + 1 }; A.pos.state = 'exit_unavailable'; }
    log('OrderFailed', at, { id: o.id, acct: o.acct, m: o.m, side: o.side, why });
  }
  function quote(ev) {
    if (!ev.orderId) return markQuote(ev);
    const o = S.orders[ev.orderId];
    if (!o || o.status !== 'requested') { log('QuoteIgnored', ev.at, { orderId: ev.orderId, why: o ? 'order already ' + o.status : 'unknown order' }); return []; }
    if (ev.at < o.reqAt) { log('QuoteIgnored', ev.at, { orderId: o.id, why: 'quote older than the order' }); return []; }
    if (ev.valid === false) { fail(o, 'quote failed validation: ' + (ev.reason || 'bad data'), ev.at); return []; }
    if (!ev.ok) { fail(o, ev.transport ? 'quote unavailable: ' + ev.err : 'no executable route: ' + (ev.err || 'quote error'), ev.at); return []; }
    const A = S.accts[o.acct], c = S.coins[o.m];
    if (c && c.stage === 'migrating') { fail(o, 'coin is graduating: venue uncertain', ev.at); return []; }
    const drift = FEES.COSTS.landingDrift, fee = FEES.COSTS.networkFeeSol;
    if (o.side === 'buy') {
      const tokens = ev.outAmount / 10 ** DEC * (1 - drift);
      if (A.maxImpact && ev.impactPct > A.maxImpact) {
        A.sizeCap = A.sizeCap || {}; A.sizeCap[o.m] = o.size * 0.5;
        fail(o, `too thin: ${(ev.impactPct * 100).toFixed(1)}% price impact for ${o.size.toFixed(2)} SOL (max ${(A.maxImpact * 100).toFixed(0)}%)`, ev.at);
        return [];
      }
      if (tokens < o.decision.expectOut * (1 - MAX_SLIP.buy)) { fail(o, `price moved: quote gives ${((1 - tokens / o.decision.expectOut) * 100).toFixed(1)}% fewer tokens than expected at the decision`, ev.at); return []; }
      const rent = FEES.COSTS.ataRentSol;
      A.cash -= o.size + fee + rent; A.rent += rent;
      const venue = ev.venue || o.decision.venue;
      A.pos = { m: o.m, sym: o.sym, qty: tokens, cost: o.size + fee, rent, openAt: ev.at, orderId: o.id, sigAt: o.decision.sigAt, decidedAt: o.reqAt,
        entryPs: o.size / tokens, entrySpot: o.decision.ps, venue, route: ev.route, impact: ev.impactPct, state: 'holding', mark: null, mae: 0, mfe: 0, peak: o.size + fee, gapMs: 0 };
      if (A.P && A.P.sl && venue === 'curve' && (1 - A.P.sl) * o.decision.ps < E.CURVE_FLOOR) A.pos.stopUnreachable = true;   // legacy stop under the curve floor: can never trigger
      if (o.contract) { A.pos.contract = o.contract; A.pos.entryP = o.decision.p; A.pos.peakP = o.decision.p; A.funnel && A.funnel.entered++; }
      const w = A.watch[o.m]; if (w) w.done = 'bought';
      o.status = 'filled'; o.doneAt = ev.at;
      o.fill = { at: ev.at, delayMs: ev.at - o.reqAt, quoteAt: ev.at, out: tokens, impact: ev.impactPct, route: ev.route, venue: ev.venue, slot: ev.slot, drift, networkFee: fee, rent };
      A.pending = null; A.n.fills++;
      log('OrderFilled', ev.at, { id: o.id, acct: A.id, m: o.m, sym: o.sym, side: 'buy', sol: o.size, tokens, impact: ev.impactPct, route: ev.route, delayMs: o.fill.delayMs });
      return [];
    }
    const p = A.pos;
    const sol = ev.outAmount / 1e9 * (1 - drift) - fee;   // exits are market orders: any executable price is taken, the gap to the estimate is recorded
    A.cash += sol + p.rent; A.rent -= p.rent;
    const t = { acct: A.id, exp: A.exp, m: p.m, sym: p.sym, qty: p.qty, cost: p.cost, proceeds: sol, net: sol - p.cost, ret: sol / p.cost - 1,
      sigAt: p.sigAt, decidedAt: p.decidedAt, openAt: p.openAt, exitSigAt: o.decision.sigAt, exitDecidedAt: o.reqAt, closeAt: ev.at,
      entryPs: p.entryPs, exitPs: (sol + fee) / (p.qty), entryRoute: p.route, exitRoute: ev.route, entryImpact: p.impact, exitImpact: ev.impactPct,
      exitReason: o.reason, exitWhy: o.why, mae: Math.min(p.mae, sol / p.cost - 1), mfe: Math.max(p.mfe, sol / p.cost - 1), gapMs: p.gapMs || 0, stopUnreachable: !!p.stopUnreachable,
      slipVsDecision: o.decision.expectOut > 0 ? sol / o.decision.expectOut - 1 : null, fees: { network: 2 * fee, drift, venue: 'inside quotes' } };
    if (p.contract) {
      const k = p.contract;
      t.v2 = { setup: k.setup, why: (S.orders[p.orderId] || {}).why || null, score: k.rank.score, n: k.rank.n, plan: k.plan, f: { buyShare5: k.f.buyShare5, netBuyers5: k.f.netBuyers5, traders5: k.f.traders5, r3: k.f.r3, mc: k.f.mc },
        thesis: p.thesis || null, alt: p.alt || null, peakRet: p.peak / p.cost - 1 };
      A.cool = A.cool || {};
      A.cool[p.m] = ev.at + (/^(thesis|emergency)$/.test(o.reason) ? 7 * 86400e3 : A.P.cooldownMin ? A.P.cooldownMin * 60000 : 30 * 60000);
    }
    A.trades.push(t); A.pos = null; A.pending = null; A.n.fills++;
    o.status = 'filled'; o.doneAt = ev.at; o.fill = { at: ev.at, delayMs: ev.at - o.reqAt, out: sol, impact: ev.impactPct, route: ev.route, venue: ev.venue, slot: ev.slot };
    log('PositionClosed', ev.at, { acct: A.id, m: t.m, sym: t.sym, net: t.net, ret: t.ret, reason: t.exitReason, why: t.exitWhy, delayMs: o.fill.delayMs });
    return [];
  }
  // a quote that is not tied to an order: the executable value of a held position right now
  function markQuote(ev) {
    const c = S.coins[ev.m];
    if (c && ev.side === 'sell' && !ev.transport) {   // a timeout or server error says nothing about the route
      const ok = ev.ok && ev.valid !== false;
      c.mq = { at: ev.at, ok, err: ok ? null : (ev.err || ev.reason || 'no route'), route: ev.route || null, venue: ev.venue || null, qty: ev.inAmount / 10 ** DEC, sol: ok ? ev.outAmount / 1e9 : null, impact: ok && isFinite(ev.impactPct) ? ev.impactPct : null };
      if (ok) { if (c.routeLostAt) log('SellRouteRestored', ev.at, { m: c.m, sym: c.sym, after: ev.at - c.routeLostAt }); c.routeFails = 0; c.routeLostAt = null; }
      else { c.routeFails = (c.routeFails || 0) + 1; if (c.routeFails >= ROUTE_LOST_AFTER && !c.routeLostAt) { c.routeLostAt = ev.at; log('SellRouteLost', ev.at, { m: c.m, sym: c.sym, err: c.mq.err }); } }
    }
    for (const A of accts()) {
      const p = A.pos; if (!p || p.m !== ev.m || ev.side !== 'sell') continue;
      if (Math.abs(ev.inAmount - Math.floor(p.qty * 10 ** DEC)) > Math.max(1, p.qty * 10 ** DEC * 0.001)) continue;
      p.quote = ev.ok && ev.valid !== false ? { at: ev.at, sol: ev.outAmount / 1e9 * (1 - FEES.COSTS.landingDrift) - FEES.COSTS.networkFeeSol, impact: ev.impactPct, route: ev.route }
        : { at: ev.at, sol: null, err: ev.err || ev.reason || 'no route' };
    }
    return [];
  }

  // ------------------------------------------------------------------------------------------------ marks and ledger
  // value if sold now: a fresh executable quote, else the model on a fresh price, else unknown (never the entry price)
  function mark(A, at) {
    const p = A.pos, c = S.coins[p.m];
    const venue = c && c.stage === 'pool' ? 'pool' : 'curve';
    let m = null;
    if (c && c.routeLostAt) {
      p.priced = false;
      p.mark = { at, value: null, src: 'route-lost', distressed: true, since: c.routeLostAt, last: p.mark && p.mark.value != null ? { value: p.mark.value, at: p.mark.at } : (p.mark && p.mark.last) || null, lo: 0, floor: 0 };
      return p.mark;
    }
    // v3 (tape: true) while the coin's tape is live: the exact sale of the position on the curve as last received
    if (A.tape && venue === 'curve' && c && TS.live(S, c)) {
      const st = c.tp.last, fee = FEES.feeRate(at / 1000, 'curve', st.ps * E.SUPPLY);
      const value = TS.curveSell(st, p.qty, fee).sol * (1 - FEES.COSTS.landingDrift) - FEES.COSTS.networkFeeSol;
      const floor = X.curveFloorValue(p.qty, at);
      p.mark = { at, value, src: 'curve', age: at - st.at, lo: Math.min(value, Math.max(floor, 0)), floor };
      p.priced = true;
      const r = value / p.cost - 1; p.mae = Math.min(p.mae, r); p.mfe = Math.max(p.mfe, r); p.peak = Math.max(p.peak, value);
      return p.mark;
    }
    // the freshest of: an executable sell quote for this position, or the model on a fresh observed price
    const q = p.quote && p.quote.sol != null && at - p.quote.at <= 90000 ? p.quote : null;
    const last = c && MK.fresh(c, at, 30000);
    const modelOk = last && last.ps > 0 && c.stage !== 'migrating';
    if (q && (!modelOk || q.at + 5000 >= last.at)) m = { at, value: q.sol, src: 'quote', age: at - q.at };
    else if (modelOk) m = { at, value: X.sellOut(p.qty, last.ps, venue, at).sol * (1 - FEES.COSTS.landingDrift) - FEES.COSTS.networkFeeSol, src: 'model', age: at - last.at };
    const floor = venue === 'curve' ? X.curveFloorValue(p.qty, at) : 0;
    if (m) {
      m.lo = Math.min(m.value, floor > 0 ? Math.max(floor, 0) : 0) ; m.floor = floor;
      p.mark = m; p.priced = true;
      const r = m.value / p.cost - 1; p.mae = Math.min(p.mae, r); p.mfe = Math.max(p.mfe, r); p.peak = Math.max(p.peak, m.value);
    } else {
      p.priced = false;
      p.mark = { at, value: null, src: 'unpriceable', last: p.mark && p.mark.value != null ? { value: p.mark.value, at: p.mark.at } : (p.mark && p.mark.last) || null, lo: floor, floor };
    }
    return p.mark;
  }
  function equityValue(A) {
    let v = A.cash + A.rent, lo = v, known = true;
    if (A.pos) { const m = A.pos.mark; if (m && m.value != null) { v += m.value; lo += m.lo; } else { known = false; lo += (m && m.lo) || 0; } }
    return { v, lo, known };
  }
  function equity(A, at) {
    const { v, lo, known } = equityValue(A);
    if (known) {
      if (A.lastEqAt && v < A.peak - 1e-9) A.underwaterMs = (A.underwaterMs || 0) + (at - A.lastEqAt);
      A.peak = Math.max(A.peak, v); A.mdd = Math.min(A.mdd, v / A.peak - 1);
    }
    if (A.pos && A.lastEqAt) A.exposureMs = (A.exposureMs || 0) + (at - A.lastEqAt);
    A.lastEqAt = at;
    const last = A.eq[A.eq.length - 1];
    if (!last || at - last[0] >= EQ_EVERY) { A.eq.push([at, known ? +v.toFixed(6) : null, +lo.toFixed(6)]); if (A.eq.length > 4000) A.eq = A.eq.filter((x, i) => i % 2 === 0 || i > A.eq.length - 2000); }
    return { value: known ? v : null, lo, known };
  }

  // ------------------------------------------------------------------------------------------------ decisions
  function tick(at) {
    if (at < S.lastAt) at = S.lastAt;
    S.lastAt = at;
    const reqs = [];
    const fcache = new Map();      // features of each coin at this tick, shared by every strategy
    fc = c => { let f = fcache.get(c.m); if (!f) { f = FT.features(c, at); fcache.set(c.m, f); } return f; };
    liveCache = null;
    curveFills(at, false);
    for (const o of Object.values(S.orders)) if (o.status === 'requested' && at - o.reqAt > ORDER_TTL) fail(o, 'no quote within 30 s', at);
    const active = Object.keys(S.coins).length > 0;
    const halted = active && at - S.lastFeedAt > FEED_STALE_MS;
    if (halted && !S.halted) { S.halted = { at, why: 'no valid market data for 60 s: new entries halted' }; log('EntriesHalted', at, { why: S.halted.why }); }
    if (!halted && S.halted) { log('EntriesResumed', at, { after: at - S.halted.at }); S.halted = null; }
    // held positions first: their marks, executable mark quotes and exits come before any new entry
    for (const m of new Set(accts().filter(A => A.pos && !A.pending).map(A => A.pos.m))) {
      const c = S.coins[m]; if (!c) continue;
      const every = c.stage === 'pool' ? MARK_Q_POOL : MARK_Q_CURVE;
      if ((!c.mq || at - c.mq.at >= every) && !(c.mqReqAt && at - c.mqReqAt < 20000)) {
        const holder = accts().find(A => A.pos && A.pos.m === m);
        c.mqReqAt = at;
        reqs.push({ type: 'quote', orderId: null, mark: true, m, side: 'sell', amount: Math.floor(holder.pos.qty * 10 ** DEC), venue: c.stage });
      }
    }
    for (const A of accts()) {
      if (A.kind === 'hold' || !A.pos) continue;
      reviewPos(A, at, reqs);
    }
    for (const A of accts()) {
      if (A.kind !== 'hold' && !A.pos && !A.pending && !S.halted && A.cash > 0.06) {
        const sig = entry(A, at);
        if (sig) { const r = order(A, 'buy', sig, at); if (r) reqs.push(r); }
      }
      equity(A, at);
    }
    prune(at);
    return reqs;
  }
  let fc = null, liveCache = null;
  // one held position: its mark, its review, and an exit order when the review says so. f: features (default: the tick's)
  function reviewPos(A, at, reqs, f) {
    mark(A, at);
    if (A.pending) return;
    const c = S.coins[A.pos.m];
    const r = c ? review(A, c, at, f) : { hold: true, state: 'unpriceable', why: 'coin data gone' };
    const prev = A.pos.state;
    if (c && c.routeLostAt && !r.exit) { r.state = 'exit_unavailable'; r.why = 'no executable sell route: value marked distressed'; }
    if (r.exit) {
      if (A.pos.exitFail && at - A.pos.exitFail.at < 15000) { /* wait before retrying a failed exit */ }
      else { const last = MK.fresh(c, at, ST.FRESH_MS) || c.last || {}; const q = order(A, 'sell', { m: A.pos.m, p: last.p, ps: last.ps || A.pos.entrySpot, why: r.why, reason: r.exit, sigAt: at }, at); if (q) reqs.push(q); A.pos.state = 'exit_pending'; }
    } else A.pos.state = A.pos.exitFail && A.pos.state === 'exit_unavailable' ? 'exit_unavailable' : r.state;
    if (A.pos && (A.pos.state !== prev || (r.thesis && r.thesis.state !== (A.pos.lastThesis || 'healthy')))) {
      if (r.thesis) A.pos.lastThesis = r.thesis.state;
      log('PositionReviewed', at, { acct: A.id, m: A.pos.m, sym: A.pos.sym, state: A.pos.state, why: r.why, thesis: r.thesis ? r.thesis.families : undefined, exit: r.exit || undefined });
    }
  }
  /* v3: a held coin's tape moved (a trade or a new curve state): the accounts that hold it on the tape revalue and review
     it now instead of at the next tick. Only while the tape is live and the coin trades on its curve, so any exit order
     fills on the curve (no quote request can be lost here). */
  function tapeReview(c, at) {
    let f = null;
    for (const A of accts()) {
      if (!A.tape || !A.pos || A.pos.m !== c.m || A.pending || c.stage !== 'curve' || !TS.live(S, c)) continue;
      const reqs = [];
      reviewPos(A, at, reqs, f || (f = FT.features(c, at)));
    }
  }
  // coins whose tape is live and that trade on their curve (the v3 entry universe), once per tick
  function liveCoins() {
    if (!liveCache) { liveCache = {}; for (const [m, c] of Object.entries(S.coins)) if (c.stage === 'curve' && TS.live(S, c)) liveCache[m] = c; }
    return liveCache;
  }
  function entry(A, at) {
    if (A.kind === 'e0') return ST.e0Entry(A, at, S.coins);
    if (A.kind === 'v2') {
      let coins = A.tape ? liveCoins() : S.coins;
      // v3.1 A4 (and the replay variant A~late): only coins at least minSinceMin minutes after their crossing
      if (A.minSinceMin) coins = Object.fromEntries(Object.entries(coins).filter(([, c]) => at - c.xAt >= A.minSinceMin * 60000));
      return V2.entry(A, at, coins, fc, A.cash - FEES.COSTS.networkFeeSol - FEES.COSTS.ataRentSol - 0.01, log);
    }
    return null;
  }
  function review(A, c, at, f) {
    if (A.kind === 'e0') return ST.e0Review(A, A.pos, c, at);
    if (A.kind === 'v2') {
      // A3e: the tape's emergency exits come first (research/v3_protocol.md)
      if (A.tapeEmergency && TS.live(S, c)) { const em = V3.emergency(A.pos, c, at); if (em) return { exit: 'emergency', why: em, thesis: A.pos.thesis || null }; }
      return V2.review(A, A.pos, c, at, f || fc(c));
    }
    return { hold: true, state: 'holding', why: '' };
  }
  function prune(at) {
    S.crosses = S.crosses.filter(x => at / 1000 - x[0] < 2.5 * 3600);
    for (const [k, t] of Object.entries(S.seen)) if (at - t > 3 * 3600e3) delete S.seen[k];
    for (const [id, o] of Object.entries(S.orders)) if (o.status !== 'requested' && at - o.reqAt > 24 * 3600e3) delete S.orders[id];
    const keep = new Set();
    for (const A of accts()) { if (A.pos) keep.add(A.pos.m); for (const w of Object.values(A.watch)) if (!w.done || at - w.to < 3600e3) keep.add(w.m); }
    for (const A of accts()) for (const [m, w] of Object.entries(A.watch)) if (w.done && at - w.to > 6 * 3600e3) delete A.watch[m];
    for (const [m, c] of Object.entries(S.coins)) if (!keep.has(m) && !alive(c, at) && at - c.xAt > (Object.values(S.accts).some(A => A.watch[m]) ? KEEP_COIN_MS : DROP_UNWATCHED_MS)) delete S.coins[m];
    for (const A of accts()) for (const [m, s] of Object.entries(A.seen)) if (at - s.at > 3 * 3600e3) delete A.seen[m];
    for (const c of Object.values(S.coins)) TS.trim(c, at);
    for (const A of accts()) if (A.kind === 'v2') {
      for (const [m, x] of Object.entries(A.fun || {})) if (!S.coins[m] && at - x.at > 3600e3) delete A.fun[m];
      for (const m of Object.keys(A.gateSeen || {})) if (!S.coins[m]) delete A.gateSeen[m];
      for (const [m, t] of Object.entries(A.cool || {})) if (t < at && !S.coins[m]) delete A.cool[m];
    }
  }
  // a hypothetical result for a coverage gap (e.g. a candle replay), kept apart from the forward ledger
  function addHypothetical(gapIndex, rec) { const g = S.gaps[gapIndex]; if (g) { g.hypo.push(Object.assign({ label: 'hypothetical: the server was not running' }, rec)); log('HypotheticalRecorded', S.lastAt, { gap: gapIndex, rec }); } }
  // coins that need a RugCheck full report: alive, checked, Jupiter silent on the dev wallet share, none received yet
  function wantReports(at) {
    const out = [];
    for (const c of Object.values(S.coins)) {
      if ((c.rcr && c.rcr.valid) || (c.rcrTries || 0) >= 3 || !alive(c, at) || !c.audit) continue;
      const a = (c.jup && c.jup.audit) || (c.audit.valid ? c.audit.fields : null);
      if (a && a.devBalancePercentage != null) continue;
      out.push(c.m);
    }
    return out.sort((x, y) => S.coins[y].xAt - S.coins[x].xAt);   // newest first
  }
  /* which coins the runtime should observe, and how often. fast (prices every 5 s, Jupiter flow every 20 s): held,
     ordering, watched, and every coin in its first 20 minutes after crossing. slow (prices every 30 s): every other
     crossed coin while it is alive (3 h after crossing, 8 h once on a pool, until it sits under $5K for 5 minutes).
     Held coins come first. */
  function pollPlan(at) {
    const held = new Set(), fast = new Set(), slow = [];
    for (const A of accts()) {
      if (A.pos) held.add(A.pos.m);
      if (A.pending && S.orders[A.pending]) held.add(S.orders[A.pending].m);
      for (const w of Object.values(A.watch)) if (!w.done && at < w.to) fast.add(w.m);
    }
    const v2 = accts().filter(A => A.kind === 'v2');
    for (const c of Object.values(S.coins)) if (at - c.xAt < FAST_YOUNG_MS || v2.some(A => V2.hot(A.strat, c, at))) fast.add(c.m);
    for (const m of held) fast.delete(m);
    for (const c of Object.values(S.coins)) if (!held.has(c.m) && !fast.has(c.m) && alive(c, at)) slow.push(c.m);
    return { held: [...held], fast: [...held, ...fast], slow };
  }
  /* which bonding curves the tape lane should follow (at most TAPE_MAX, tape.js): curve coins held or being ordered
     first, then the fast list (watched, young, V2 setup candidates), newest crossing first */
  function tapePlan(at) {
    const plan = pollPlan(at), held = new Set(plan.held), out = [];
    const ok = c => c && c.bc && c.stage !== 'pool' && !(c.tp && c.tp.done) && !c.deadAt;
    for (const m of plan.held) { const c = S.coins[m]; if (ok(c)) out.push({ m, bc: c.bc }); }
    const rest = plan.fast.filter(m => !held.has(m)).map(m => S.coins[m]).filter(ok).sort((a, b) => b.xAt - a.xAt || (a.m < b.m ? -1 : 1));
    for (const c of rest) out.push({ m: c.m, bc: c.bc });
    return out;
  }
  const equityNow = A => { const r = equityValue(A); return { value: r.known ? r.v : null, lo: r.lo, known: r.known }; };
  return { init, load, save, ingest, tick, drain, addHypothetical, pollPlan, tapePlan, wantReports, state: () => S, mark, equity, equityNow, VERSION };
}
module.exports = { createEngine, VERSION, GAP_MS, ORDER_TTL, MAX_SLIP, alive };
