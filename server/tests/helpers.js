'use strict';
/* Shared scenario harness for the v11 engine tests: a coin crosses $7K at 12:00 UTC, its checks arrive at `checksAt`,
   its price follows `price(t)`; the harness feeds a snapshot every 5 s, ticks every 5 s and answers each quote request
   `quoteDelay` ms later (by default with the exact curve fill at the price then). */
const E = require('../sniper.js');
const { createEngine } = require('../v11/engine.js');
const X = require('../v11/model.js');

const T0 = Date.UTC(2026, 9, 21, 12, 0, 0);          // 12:00 UTC: the coin crosses $7K
const min = n => T0 + n * 60000;
const SOL_USD = 100;
const M = 'Te5tFrogMint1111111111111111111111111111pump', M2 = 'Te5tFrogOther111111111111111111111111111pump';
const BC = 'Te5tBondingCurve111111111111111111111111111';
const HI = 1e-5;                                      // $10K market cap high since launch
const TRIG = 0.6 * HI;                                // 40% dip level

// a market described as price at time; the harness observes it every 5 s, ticks every 5 s and answers quotes 1 s later
function harness({ price, checksAt = min(5), quoteDelay = 1000, quote = null, stopAt = Infinity, extraEvents = [], setup = null, venue = () => 'curve' }) {
  const e = createEngine();
  e.init(min(-20));
  e.ingest({ type: 'run_start', at: min(-20), run: 'test' });
  if (setup) setup(e.state());
  e.ingest({ id: 'x2', type: 'crossing', at: min(-10), m: M2, sym: 'FROGO', name: 'Frog Other', mcX: 7000, bc: BC });
  e.ingest({ id: 'x1', type: 'crossing', at: T0, m: M, sym: 'FROGT', name: 'Frog Test', mcX: 7000, hiMc: HI * 1e9, bc: BC });
  const log = { orders: [], quotes: [] };
  const pending = [];
  let checked = false;
  const evs = extraEvents.slice().sort((a, b) => a.at - b.at);
  for (let t = T0; t <= stopAt; t += 1000) {
    while (evs.length && evs[0].at <= t) e.ingest(evs.shift());
    if (!checked && t >= checksAt) {
      checked = true;
      e.ingest({ id: 'a1', type: 'audit', at: checksAt, reqAt: T0 + 1000, m: M, valid: true, fields: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true, devBalancePercentage: 1, topHoldersPercentage: 10, holders: 120, socials: { tw: true }, devMints: 1 } });
      e.ingest({ id: 'r1', type: 'rugcheck', at: checksAt, reqAt: T0 + 2000, m: M, valid: true, risks: [], sn: 1 });
    }
    for (const q of pending.filter(q => q.at <= t)) { pending.splice(pending.indexOf(q), 1); e.ingest(q.ev); log.quotes.push(q.ev); }
    const p = price(t);
    if ((t - T0) % 5000 === 0 && p != null) e.ingest({ id: 's' + t, type: 'snapshot', m: M, at: t, src: 'dex', valid: true, p, ps: p / SOL_USD, mc: p * 1e9, venue: venue(t) });
    if ((t - T0) % 5000 === 0) for (const r of e.tick(t)) {
      log.orders.push(Object.assign({ t }, r));
      const qa = t + quoteDelay, qp = price(qa) || p;
      const ev0 = quote ? quote(r, qa, qp) : null;
      if (ev0 === false) continue;               // the quote request got no answer at all
      const ev = ev0 || stdQuote(r, qa, qp, venue(qa));
      pending.push({ at: qa, ev });
    }
  }
  return { e, S: e.state(), log };
}
function stdQuote(r, at, p, venue = 'curve') {
  const ps = p / SOL_USD;
  const out = r.side === 'buy' ? X.buyOut(r.amount / 1e9, ps, venue, at).tokens * 1e6 : X.sellOut(r.amount / 1e6, ps, venue, at).sol * 1e9;
  return { id: 'q' + (r.orderId || r.m + ':' + r.amount) + ':' + at, type: 'quote', at, orderId: r.orderId, m: r.m, side: r.side, inAmount: r.amount, outAmount: Math.floor(out), impactPct: 0.05, route: [venue === 'pool' ? 'Pump.fun Amm' : 'Pump.fun'], venue, ok: true, valid: true };
}
const ordersOf = (S, acct, side) => Object.values(S.orders).filter(o => o.acct === acct && (!side || o.side === side));
// the same market as v10 saw it: 1-minute candles from the price path
function candles(price, from, to) {
  const out = [];
  for (let t = from; t < to; t += 60000) {
    const ps = []; for (let s = t; s < t + 60000; s += 1000) ps.push(price(s));
    out.push([t / 1000, ps[0], Math.max(...ps), Math.min(...ps), ps[ps.length - 1], 1000, 0]);
  }
  return out;
}

/* A multi-coin market for the V2 strategies. coins: [{ m, sym, crossAt, mcX, hiMc, mc(t) (USD market cap or null),
   flow(t) (Jupiter 5-minute stats { bv, sv, tr, nnb, nob, hc } or null), flow1h(t), liq(t), venue(t), holders, audit }].
   Prices every 5 s from DexScreener, Jupiter flow + audit every 20 s, checks `checksAfter` ms after each crossing, a decision
   tick every 5 s, every quote answered `quoteDelay` ms later (by `quote(r, at, p)` or the exact model fill). */
const GOOD_AUDIT = { mintAuthorityDisabled: true, freezeAuthorityDisabled: true, devBalancePercentage: 2, topHoldersPercentage: 15, devMints: 1 };
function market({ coins, start = min(-1), stopAt, checksAfter = 30000, quoteDelay = 1000, quote = null, setup = null, accounts = null, extra = [] }) {
  const e = createEngine(accounts ? { accounts } : {});
  e.init(start);
  e.ingest({ type: 'run_start', at: start, run: 'test' });
  if (setup) setup(e.state());
  const pending = [], log = { orders: [], quotes: [] };
  const crossed = new Set(), checked = new Set();
  const venueOf = (c, t) => c.venue ? c.venue(t) : 'curve';
  const evs = extra.slice().sort((a, b) => a.at - b.at);
  for (let t = start; t <= stopAt; t += 1000) {
    while (evs.length && evs[0].at <= t) e.ingest(evs.shift());
    for (const c of coins) {
      if (!crossed.has(c.m) && t >= c.crossAt) { crossed.add(c.m); e.ingest({ id: 'x:' + c.m, type: 'crossing', at: t, m: c.m, sym: c.sym, name: c.name || c.sym, t0: Math.floor((c.crossAt - 120000) / 1000), mcX: c.mcX || 7000, hiMc: c.hiMc || c.mcX || 7000, bc: BC }); }
      if (crossed.has(c.m) && !checked.has(c.m) && t >= c.crossAt + checksAfter) {
        checked.add(c.m);
        e.ingest({ id: 'a:' + c.m, type: 'audit', at: t, reqAt: c.crossAt + 1000, m: c.m, valid: true, fields: Object.assign({ holders: c.holders || 120, socials: { tw: true } }, c.audit || GOOD_AUDIT) });
        e.ingest({ id: 'r:' + c.m, type: 'rugcheck', at: t, reqAt: c.crossAt + 2000, m: c.m, valid: true, risks: [], sn: 1 });
      }
    }
    for (const q of pending.filter(q => q.at <= t)) { pending.splice(pending.indexOf(q), 1); e.ingest(q.ev); log.quotes.push(q.ev); }
    if ((t - start) % 5000 === 0) {
      for (const c of coins) {
        if (!crossed.has(c.m)) continue;
        const mc = c.mc(t); if (mc == null) continue;
        const p = mc / 1e9, v = venueOf(c, t);
        const liq = c.liq ? c.liq(t) : null;
        e.ingest({ id: `d:${c.m}:${t}`, type: 'snapshot', m: c.m, at: t, src: 'dex', valid: true, p, ps: p / SOL_USD, mc, venue: v, pool: v === 'pool' ? 'POOL' + c.sym : null,
          liq: liq ? { usd: liq, base: null, quote: null } : null, dx: { b5: 10, s5: 5, v5: 1000, v1h: 9000 } });
        if ((t - start) % 10000 === 0 && c.flow) {
          const fl = c.flow(t), f1 = c.flow1h ? c.flow1h(t) : { bv: 50000, sv: 40000, nnb: 20 };
          if (fl) e.ingest({ id: `j:${c.m}:${t}`, type: 'snapshot', m: c.m, at: t, src: 'jup', valid: true, p, ps: p / SOL_USD, mc, liqUsd: liq || mc / 10, holders: (c.holders || 120) + Math.floor((t - c.crossAt) / 60000),
            org: 50, asOf: t - 3000, st: Object.assign({ nb: 20, ns: 10, nob: NaN, hc: 2, lc: 0, pc: 0 }, fl), st1h: Object.assign({ nb: 200, ns: 150, tr: 300, nob: NaN, hc: 20 }, f1), audit: Object.assign({}, c.audit || GOOD_AUDIT, c.auditAt ? c.auditAt(t) : {}) });
        }
      }
      for (const r of e.tick(t)) {
        log.orders.push(Object.assign({ t }, r));
        const qa = t + quoteDelay, c = coins.find(x => x.m === r.m), qp = (c.mc(qa) || c.mc(t)) / 1e9;
        const ev0 = quote ? quote(r, qa, qp) : null;
        if (ev0 === false) continue;
        pending.push({ at: qa, ev: ev0 || stdQuote(r, qa, qp, venueOf(c, qa)) });
      }
    }
  }
  return { e, S: e.state(), log };
}
// piecewise-linear path through [minute, value] points (flat before the first and after the last)
function path(pts) {
  return t => {
    const x = (t - T0) / 60000;
    if (x <= pts[0][0]) return pts[0][1];
    for (let i = 1; i < pts.length; i++) if (x <= pts[i][0]) { const [a, va] = pts[i - 1], [b, vb] = pts[i]; return va + (vb - va) * (x - a) / (b - a); }
    return pts[pts.length - 1][1];
  };
}
// a step function through [minute, value] points
function steps(pts) { return t => { const x = (t - T0) / 60000; let v = pts[0][1]; for (const [a, va] of pts) if (x >= a) v = va; return v; }; }

module.exports = { T0, min, SOL_USD, M, M2, BC, HI, TRIG, harness, stdQuote, ordersOf, candles, market, path, steps, GOOD_AUDIT };
