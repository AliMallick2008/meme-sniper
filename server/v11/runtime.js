'use strict';
/* v11 runtime: connects the pure engine to the live world inside the server process. It turns legacy-core events
   (crossings, checks) and its own polling (DexScreener every 5 s, Jupiter every 20 s, quotes on demand) into engine
   events stamped with the time they were received, validates every payload first (a schema change becomes an invalid
   observation, never a silent zero), runs a decision tick every 5 s, and exposes state for saving and for the page. */
const zlib = require('zlib');
const { createEngine } = require('./engine.js');
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const JUP = 'https://lite-api.jup.ag';

const num = v => (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '')) && isFinite(+v) ? +v : NaN;

// ------------------------------------------------------------------------------------------------ payload validation
function fromDex(pairs, m, at) {
  if (!Array.isArray(pairs)) return { m, at, src: 'dex', valid: false, reason: 'DexScreener: response is not a list' };
  const mine = pairs.filter(p => p && p.baseToken && p.baseToken.address === m);
  if (!mine.length) return null;   // not listed (yet): no observation, not an error
  const pool = mine.find(p => p.dexId === 'pumpswap' && num(p.priceUsd) > 0);
  const p = pool || mine.find(p => p.dexId === 'pumpfun');
  if (!p) return { m, at, src: 'dex', valid: false, reason: 'DexScreener: no pump.fun or PumpSwap pair' };
  const pu = num(p.priceUsd), pn = num(p.priceNative);
  if (!(pu > 0) || !(pn > 0)) return { m, at, src: 'dex', valid: false, reason: 'DexScreener: priceUsd/priceNative missing or not a number (schema change?)' };
  const tx = p.txns && p.txns.m5, vol = p.volume || {};
  return { m, at, src: 'dex', valid: true, p: pu, ps: p.quoteToken && p.quoteToken.symbol === 'SOL' ? pn : null, mc: num(p.marketCap) || num(p.fdv) || null,
    venue: pool ? 'pool' : 'curve', pool: pool ? pool.pairAddress : null,
    liq: p.liquidity ? { usd: num(p.liquidity.usd) || null, base: num(p.liquidity.base) || null, quote: num(p.liquidity.quote) || null } : null,
    dx: { b5: tx ? num(tx.buys) : NaN, s5: tx ? num(tx.sells) : NaN, v5: num(vol.m5), v1h: num(vol.h1) } };
}
function fromJup(x, at, solUsd) {
  if (!x || typeof x.id !== 'string') return null;
  const pu = num(x.usdPrice);
  if (!(pu > 0)) return { m: x.id, at, src: 'jup', valid: false, reason: 'Jupiter: usdPrice missing (schema change?)' };
  const s5 = x.stats5m || {}, s1 = x.stats1h || {};
  const st = o => ({ bv: num(o.buyVolume), sv: num(o.sellVolume), nb: num(o.numBuys), ns: num(o.numSells), tr: num(o.numTraders), nnb: num(o.numNetBuyers),
    nob: num(o.numOrganicBuyers), hc: num(o.holderChange), lc: num(o.liquidityChange), pc: num(o.priceChange) });
  return { m: x.id, at, src: 'jup', valid: true, p: pu, ps: solUsd ? pu / solUsd : null, mc: num(x.mcap) || null, liqUsd: num(x.liquidity) || null,
    holders: num(x.holderCount) || null, org: num(x.organicScore), asOf: x.updatedAt ? Date.parse(x.updatedAt) || null : null,
    st: st(s5), st1h: st(s1), audit: x.audit && typeof x.audit === 'object' ? x.audit : null };
}
function fromQuote(q) {
  if (!q || typeof q !== 'object') return { valid: false, reason: 'quote: empty response' };
  if (q.error || q.errorCode) return { valid: true, ok: false, err: String(q.errorCode || q.error).slice(0, 80) };
  const inA = num(q.inAmount), outA = num(q.outAmount);
  if (!(inA > 0) || !(outA > 0) || !Array.isArray(q.routePlan)) return { valid: false, reason: 'quote: inAmount/outAmount/routePlan missing (schema change?)' };
  const route = q.routePlan.map(r => r && r.swapInfo && String(r.swapInfo.label || '?'));
  const venue = route.length && route.every(l => /^pump\.?fun$/i.test(l)) ? 'curve' : 'pool';
  return { valid: true, ok: true, inAmount: inA, outAmount: outA, impactPct: num(q.priceImpactPct), route, venue, slot: q.contextSlot || null };
}

function createRuntime({ core, clock, log, store, run }) {
  const now = () => clock.now();
  const eng = createEngine();
  let events = [], evH = 0, part = 0, lastSol = null, started = false, urgentFlag = false;
  const stats = { dex: 0, jup: 0, quotes: 0, quoteFails: 0, invalid: 0, flushed: 0 };

  function load(saved) {
    if (saved && saved.v && saved.accts) { eng.load(unpack(saved)); log(`v11: resumed (started ${new Date(saved.startedAt).toISOString()})`); }
    else { eng.init(now()); log('v11: fresh start, every account 10 paper SOL'); }
    eng.ingest({ type: 'run_start', at: now(), run });
    started = true;
  }
  const ingest = ev => { try { eng.ingest(ev); } catch (e) { core.note('v11 ingest: ' + (e.message || e)); } };

  // -------------------------------------------------------------------------------------------- legacy-core hooks
  const hooks = {
    onCross(k, c, tSec) {
      if (!started) return;
      ingest({ id: 'x:' + k.m, type: 'crossing', at: Math.round(tSec * 1000), m: k.m, sym: k.sym, name: k.name, t0: k.t, mcX: k.mcX, hiMc: c && c.max, bc: k.bc, links: k.links || null });
    },
    onAudit(k, reqAt, at, missing) {
      if (!started) return;
      ingest({ id: 'a:' + k.m, type: 'audit', at, reqAt, m: k.m, valid: !missing, reason: missing ? 'Jupiter had no audit for this coin after 4 tries' : null,
        fields: missing ? {} : Object.assign({}, k.audit, { holders: k.holders, socials: k.soc, organicScore: k.org }) });
    },
    onRugcheck(k, reqAt, at) {
      if (!started) return;
      const rc = k.rc || {};
      ingest({ id: 'r:' + k.m, type: 'rugcheck', at, reqAt, m: k.m, valid: !rc.missing, reason: rc.missing ? 'no RugCheck report' : null, risks: rc.risks || [], score: rc.score, sn: rc.sn });
    },
  };

  // -------------------------------------------------------------------------------------------- polling
  async function pollDex() {
    const w = eng.wanted(now()), list = w.held.concat(w.watch, w.recent).filter(core.okAddr);
    for (let i = 0; i < list.length; i += 30) {
      const batch = list.slice(i, i + 30);
      let j; try { j = await core.getJSON('dex', `${core.API.dex}/tokens/v1/solana/${batch.join(',')}`); } catch (e) { continue; }
      const at = now();
      for (const m of batch) { const s = fromDex(j, m, at); if (s) { s.id = `d:${m}:${at}`; s.type = 'snapshot'; if (!s.valid) stats.invalid++; ingest(s); stats.dex++; } }
    }
  }
  async function pollJup() {
    const w = eng.wanted(now()), list = w.held.concat(w.watch, w.recent).filter(core.okAddr).slice(0, 100);
    if (!list.length) return;
    let j; try { j = await core.getJSON('jup', `${JUP}/tokens/v2/search?query=${list.join(',')}`); } catch (e) { return; }
    const at = now();
    if (!Array.isArray(j)) { for (const m of list) ingest({ id: `j:${m}:${at}`, type: 'snapshot', m, at, src: 'jup', valid: false, reason: 'Jupiter: response is not a list' }); stats.invalid++; return; }
    const sol = solUsd(at);
    for (const x of j) { const s = fromJup(x, at, sol); if (s) { s.id = `j:${s.m}:${at}`; s.type = 'snapshot'; if (!s.valid) stats.invalid++; ingest(s); stats.jup++; } }
  }
  function solUsd(at) { const S = eng.state(); let b = null; for (const x of S.sol) if (x.at <= at && (!b || x.at > b.at)) b = x; return b && at - b.at <= 300000 ? b.usd : null; }
  async function getQuote(r) {
    const reqAt = now();
    const [i, o] = r.side === 'buy' ? [SOL_MINT, r.m] : [r.m, SOL_MINT];
    let q = null, err = null;
    try { q = await core.getJSON('jup', `${JUP}/swap/v1/quote?inputMint=${i}&outputMint=${o}&amount=${r.amount}&slippageBps=1000&restrictIntermediateTokens=true`); }
    catch (e) { err = String(e && e.message || e); }
    const at = now();
    stats.quotes++;
    if (err === 'rate limited') { stats.quoteFails++; return; }   // transient: the order times out and the signal is re-checked
    // Jupiter answers 400 when it has no route: that is a sellability fact. Timeouts and 5xx say nothing about the route.
    const v = err ? (err === 'HTTP 400' ? { valid: true, ok: false, err: 'no route (HTTP 400)', noRoute: true } : { valid: true, ok: false, err, transport: true }) : fromQuote(q);
    if (!v.ok) stats.quoteFails++;
    ingest(Object.assign({ id: `q:${r.orderId || r.m}:${at}`, type: 'quote', at, reqAt, orderId: r.orderId || null, m: r.m, side: r.side, inAmount: r.amount }, v));
  }
  function tick() {
    const at = now();
    const sol = core.M.solNow;
    if (sol > 0 && sol !== lastSol) { lastSol = sol; ingest({ type: 'sol', at, usd: sol }); }
    let reqs = [];
    try { reqs = eng.tick(at); } catch (e) { core.note('v11 tick: ' + (e.message || e)); }
    for (const r of reqs) getQuote(r);
    for (const e of eng.drain()) { if (!events.length) evH = Math.floor(at / 3600e3); events.push(JSON.stringify(e)); if (urgentTypes.has(e.type)) urgentFlag = true; }
    return reqs.length;
  }
  // decisions that should reach the page quickly
  const urgentTypes = new Set(['OrderFilled', 'PositionClosed', 'OrderFailed', 'CoverageGap', 'EntriesHalted']);
  function urgent() { const u = urgentFlag; urgentFlag = false; return u; }

  // -------------------------------------------------------------------------------------------- persistence
  // the saved copy is trimmed: a few recent snapshots, 60 compact bars per coin, the last 200 log events (the full event
  // stream goes to the research branch under v11-events/)
  const r6 = v => typeof v === 'number' ? +v.toPrecision(6) : v;
  function save() {
    const s = eng.save();
    for (const c of Object.values(s.coins)) {
      c.snaps = c.snaps.slice(-4).map(x => Object.assign({}, x, { audit: undefined, st1h: undefined }));
      c.bars = c.bars.slice(-60).map(b => [b.t, r6(b.o), r6(b.h), r6(b.l), r6(b.c), b.n]);
    }
    for (const A of Object.values(s.accts)) for (const k of Object.keys(A.seen)) A.seen[k] = { at: A.seen[k].at, pass: A.seen[k].pass };
    s.log = s.log.slice(-200);
    return s;
  }
  function unpack(saved) {
    for (const c of Object.values(saved.coins || {})) c.bars = (c.bars || []).map(b => Array.isArray(b) ? { t: b[0], o: b[1], h: b[2], l: b[3], c: b[4], n: b[5] } : b);
    return saved;
  }
  function view() {
    const S = eng.state(), at = now();
    const acct = A => {
      const eq = eng.equityNow(A);
      return { id: A.id, exp: A.exp, kind: A.kind, legacy: A.legacy || null, name: A.name, desc: A.desc, P: A.P || null, cash: A.cash, rent: A.rent,
        value: eq.value, lo: eq.lo, known: eq.known, mdd: A.mdd, n: A.n, pos: A.pos, pending: A.pending ? S.orders[A.pending] : null,
        trades: A.trades.slice(-60), nTrades: A.trades.length, realized: A.trades.reduce((x, t) => x + t.net, 0), wins: A.trades.filter(t => t.net > 0).length,
        eq: A.eq.filter((x, i, a) => i % Math.max(1, Math.ceil(a.length / 400)) === 0 || i === a.length - 1),
        watch: Object.values(A.watch).filter(w => !w.done || at - Math.min(w.to, at) < 1800e3).map(w => ({ m: w.m, from: w.from, to: w.to, armed: w.armed, trig: w.trig, done: w.done, dipAt: w.dipAt })),
        fails: A.fails.slice(-20) };
    };
    // only coins an account watches, holds or traded recently, without their price history (the page draws its own charts)
    const used = new Set();
    for (const A of Object.values(S.accts)) { if (A.pos) used.add(A.pos.m); for (const w of Object.values(A.watch)) if (!w.done || at - Math.min(w.to, at) < 1800e3) used.add(w.m); for (const t of A.trades.slice(-10)) used.add(t.m); }
    const coins = {};
    for (const m of used) { const c = S.coins[m]; if (!c) continue;
      coins[m] = { m, sym: c.sym, name: c.name, xAt: c.xAt, bc: c.bc, stage: c.stage, hi: c.hi && { p: c.hi.p, at: c.hi.at }, last: c.last && { p: c.last.p, ps: c.last.ps, at: c.last.at, src: c.last.src },
        jup: c.jup ? { at: c.jup.at, st: c.jup.st, liqUsd: c.jup.liqUsd, holders: c.jup.holders, asOf: c.jup.asOf } : null,
        audit: c.audit ? { reqAt: c.audit.reqAt, at: c.audit.at, valid: c.audit.valid, f: c.audit.fields && { mint: c.audit.fields.mintAuthorityDisabled, freeze: c.audit.fields.freezeAuthorityDisabled, dev: c.audit.fields.devBalancePercentage, top: c.audit.fields.topHoldersPercentage, devMints: c.audit.fields.devMints, holders: c.audit.fields.holders } } : null,
        rc: c.rc ? { reqAt: c.rc.reqAt, at: c.rc.at, valid: c.rc.valid, danger: (c.rc.risks || []).filter(r => r[1] === 'danger').map(r => r[0]), sn: c.rc.sn } : null, invalid: c.invalid }; }
    const log = S.log.filter(e => !/^(QuoteIgnored|DataInvalid)$/.test(e.type)).slice(-80).map(e => e.type === 'EligibilityDecided' ? Object.assign({}, e, { gates: undefined, failed: (e.gates || []).filter(g => g[1] !== 'pass').map(g => g[0]) }) : e);
    return { v: S.v, startedAt: S.startedAt, lastAt: S.lastAt, run: S.run, halted: S.halted, gaps: S.gaps.slice(-20), lastFeedAt: S.lastFeedAt,
      accts: Object.values(S.accts).map(acct), coins, log, stats };
  }
  async function flush(force, put) {
    if (!events.length) return;
    const h = Math.floor(now() / 3600e3);
    if (!force && h === evH && events.length < 3000) return;
    const lines = events, h0 = evH; events = [];
    try {
      const d = new Date(h0 * 3600e3).toISOString();
      await put(`v11-events/${d.slice(0, 10)}/${d.slice(11, 13)}h-run${run}-${++part}.jsonl.gz`, zlib.gzipSync(Buffer.from(lines.join('\n') + '\n')));
      stats.flushed += lines.length;
    } catch (e) { events = lines.concat(events); evH = h0; log('v11 event upload failed: ' + (e.message || e)); }
  }
  function start(L) {
    L(pollDex, 5000, 'v11-dex');
    L(pollJup, 20000, 'v11-jup');
    L(async () => { tick(); }, 5000, 'v11-tick');
  }
  return { hooks, load, start, tick, save, view, flush, urgent, engine: eng, stats };
}
module.exports = { createRuntime, fromDex, fromJup, fromQuote };
