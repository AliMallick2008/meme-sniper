'use strict';
/* Phase 1 (causal correctness): audit tests T01, T02, T03, T10, T11, T12, T14, T15, T20 (engine side).
   Each test drives the v11 engine with an exact event sequence; where the audit asks for it, the same market is also
   run through the legacy v10 engine to show the old behaviour the fix removes. */
const test = require('node:test');
const assert = require('node:assert');
const E = require('../sniper.js');
const { createEngine } = require('../v11/engine.js');
const MK = require('../v11/market.js');
const G = require('../v11/gates.js');
const X = require('../v11/model.js');

const { T0, min, SOL_USD, M, M2, BC, HI, TRIG, harness, stdQuote, ordersOf, candles } = require('./helpers.js');

test('T01: check received five minutes after a historical dip -> no retroactive entry; a fresh dip after it can be bought', () => {
  // high $10K, dips under the 40% level 12:02-12:04, recovers by 12:04, checks finish 12:05, dips again at 12:06:30
  const price = t => t < min(2) ? 0.9e-5 : t < min(4) ? 0.55e-5 : t < min(6.5) ? 0.8e-5 : 0.56e-5;
  // v10: the watch started at the crossing, so the 12:02 dip is bought (from final candles, after the fact)
  const cs = candles(price, min(-5), min(10)).map((c, i) => i === 0 ? [c[0], c[1], HI, c[3], c[4], c[5], 0] : c);
  const old = E.findEntry(cs, () => SOL_USD, T0 / 1000, min(10) / 1000, Object.assign({}, E.RULES.BASE));
  assert.ok(old.pos && old.pos.entryT === min(2) / 1000, 'v10 books the 12:02 dip');
  // v11
  const { S } = harness({ price, stopAt: min(8) });
  const buys = ordersOf(S, 'E0-U', 'buy');
  assert.ok(buys.every(o => o.reqAt >= min(5)), 'no buy decided before the checks were in');
  assert.ok(!buys.some(o => o.reqAt < min(6.5)), 'nothing bought for the 12:02 dip');
  assert.ok(buys.length >= 1 && buys[0].reqAt >= min(6.5), 'the fresh 12:06:30 dip is bought');
  assert.strictEqual(buys[0].status, 'filled');
  assert.ok(S.accts['E0-U'].watch[M].from === min(5), 'watch starts at eligible_at (12:05), not at the crossing');
});

test('T02: a green candle is known only at its close -> the fill is the next quote, not that close', () => {
  // armed above the level at 12:05, dips at 12:10:10, the 12:11 minute is green (5.5 -> 6.5), price jumps to 7.2 at 12:12
  const price = t => t < min(10) ? 0.8e-5 : t < min(11) ? 0.55e-5 : t < min(12) ? 0.55e-5 + (t - min(11)) / 60000 * 0.1e-5 : 0.72e-5;
  const cs = candles(price, min(-5), min(14)).map((c, i) => i === 0 ? [c[0], c[1], HI, c[3], c[4], c[5], 0] : c);
  const old = E.findEntry(cs, () => SOL_USD, min(5) / 1000, min(14) / 1000, Object.assign({}, E.RULES.BASE, { entry: 'green' }));
  assert.ok(old.pos && old.pos.entryUsd === cs.find(c => c[0] === old.pos.entryT)[4], 'v10 fills at the close of the very candle that made the signal');
  const { S } = harness({ price, stopAt: min(14) });
  const b = ordersOf(S, 'E0-GRN', 'buy')[0];
  assert.ok(b, 'GRN decided a buy');
  assert.ok(b.reqAt >= min(12), `decision only after the green minute ended (got ${(b.reqAt - T0) / 1000} s)`);
  assert.strictEqual(b.status, 'filled');
  assert.ok(b.fill.at > b.reqAt, 'filled by a later quote');
  const paid = b.size / (b.fill.out);                 // SOL per token actually paid
  assert.ok(paid > 0.65e-5 / SOL_USD, 'paid the later (higher) price, not the 6.5 close');
});

test('T03: a one-tick wick at the level with no executable quote does not fill', () => {
  const price = t => (t >= min(8) && t < min(8) + 1000) ? 0.59e-5 : 0.8e-5;   // one observation under the level, then back
  const cs = candles(price, min(-5), min(12)).map((c, i) => i === 0 ? [c[0], c[1], HI, c[3], c[4], c[5], 0] : c);
  const old = E.findEntry(cs, () => SOL_USD, min(5) / 1000, min(12) / 1000, Object.assign({}, E.RULES.BASE));
  assert.ok(old.pos, 'v10 books a fill at the wick');
  // (a) the next quote is back at the normal price: more than 10% worse than the decision estimate -> failed order
  const a = harness({ price, stopAt: min(12) });
  const ba = ordersOf(a.S, 'E0-U', 'buy');
  assert.ok(ba.length >= 1 && ba.every(o => o.status === 'failed'), 'order failed');
  assert.ok(!a.S.accts['E0-U'].pos && a.S.accts['E0-U'].trades.length === 0, 'no position');
  // (b) no route at all
  const b = harness({ price, stopAt: min(12), quote: (r, at) => ({ id: 'q' + r.orderId, type: 'quote', at, orderId: r.orderId, m: r.m, side: r.side, ok: false, err: 'COULD_NOT_FIND_ANY_ROUTE', valid: true }) });
  assert.ok(ordersOf(b.S, 'E0-U', 'buy').every(o => o.status === 'failed' && /route/.test(o.reason)));
  assert.ok(!b.S.accts['E0-U'].pos);
});

test('T10: missing dev balance and top-holder fields are unknown, never a fake 0% or pass', () => {
  const c = MK.newCoin({ m: M, at: T0, sym: 'X', name: 'X' });
  c.audit = { at: T0, valid: true, fields: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true } };
  c.rc = { at: T0, valid: true, risks: [] };
  const gs = G.strict(c, T0, { devMax: 10, topMax: 30 });
  const by = Object.fromEntries(gs.map(x => [x.id, x]));
  assert.strictEqual(by.dev.status, 'unknown'); assert.strictEqual(by.dev.value, null);
  assert.strictEqual(by.top.status, 'unknown');
  assert.strictEqual(G.allPass(gs), false, 'not eligible while unknown');
  // the legacy set really did treat them as passing (kept only for the E0 replicas)
  const lg = Object.fromEntries(G.legacy(c, { devMax: 10, topMax: 30, needMeme: 0 }, []).map(x => [x.id, x]));
  assert.strictEqual(lg.dev.status, 'pass'); assert.strictEqual(lg.top.status, 'pass');
});

test('T11: stale price feed -> new entries halt and the held position is marked unpriceable, not "sell now"', () => {
  // bought at 12:06:30, then the feed stops at 12:08 for 90 s, then returns
  const price = t => (t >= min(8) && t < min(9.5)) ? null : t < min(6.5) ? 0.8e-5 : 0.56e-5;
  const h = harness({ price, stopAt: min(9.6), quote: (r, at) => at >= min(8) && at < min(9.5) ? false : null });   // quotes get no answer while the feed is down
  const A = h.S.accts['E0-U'];
  assert.ok(A.pos, 'holding');
  const stale = h.S.log.filter(x => x.type === 'PositionReviewed' && x.acct === 'E0-U' && x.state === 'unpriceable');
  assert.ok(stale.length >= 1, 'the position was reviewed as unpriceable during the outage');
  // replay the moment inside the outage: mark it again at 12:09:20
  const e2 = require('../v11/engine.js').createEngine(); e2.load(JSON.parse(JSON.stringify(h.S)));
  const A2 = e2.state().accts['E0-U']; const c2 = e2.state().coins[A2.pos.m];
  c2.last = Object.assign({}, c2.last, { at: min(7.9) }); A2.pos.quote = Object.assign({}, A2.pos.quote, { at: min(7.8) });
  e2.mark(A2, min(9) + 20000);
  assert.strictEqual(A2.pos.mark.src, 'unpriceable');
  assert.strictEqual(A2.pos.mark.value, null, 'no sell-now value while stale');
  assert.ok(A2.pos.mark.last && A2.pos.mark.last.value > 0, 'last known value kept separately, with its time');
  assert.ok(h.S.log.some(x => x.type === 'EntriesHalted' && x.at >= min(9)), 'entries halted once nothing was fresh for 60 s');
  assert.ok(h.S.log.some(x => x.type === 'EntriesResumed' && x.at >= min(9.5)), 'and resumed when data came back');
  const eq = e2.equityNow(A2);
  assert.strictEqual(eq.known, false, 'equity is unknown while the position cannot be priced');
  assert.strictEqual(eq.value, null);
});

test('T12: a missing SOL/USD minute never searches the future', () => {
  const sol = [{ at: min(0), usd: 100 }, { at: min(10), usd: 120 }];
  assert.strictEqual(MK.solAt(sol, min(5.5)), null, 'nothing within 5 min before 12:05:30 -> unknown, never the 12:10 price');
  assert.strictEqual(MK.solAt(sol, min(3)), 100, '12:03 uses the 12:00 price');
  assert.strictEqual(MK.solAt(sol, min(-1)), null, 'before any observation -> unknown, never the 12:00 value');
  assert.strictEqual(MK.solAt(sol, min(12)), 120);
});

test('T14: server offline during the target -> nothing credited; any replay is kept as hypothetical', () => {
  // bought on the 12:06:30 dip, below target until 12:08; the target is reached only while the server is off (12:08-12:22)
  const price = t => t < min(6.5) ? 0.8e-5 : t < min(7) ? 0.56e-5 : t <= min(8) ? 0.58e-5 : t < min(20) ? 0.9e-5 : 0.57e-5;
  // run until 12:08 (bought ~12:06:30), then the server is off 12:08 -> 12:22 while the price is at the target
  const h = harness({ price, stopAt: min(8) });
  const e = h.e, A = () => e.state().accts['E0-U'];
  assert.ok(A().pos && !A().pending, 'holding before the outage, no sell in flight');
  const saved = e.save();
  const e2 = createEngine(); e2.load(saved);
  e2.ingest({ type: 'run_start', at: min(22), run: 'test-2' });
  e2.ingest({ id: 's-back', type: 'snapshot', m: M, at: min(22), src: 'dex', valid: true, p: 0.57e-5, ps: 0.57e-5 / SOL_USD, mc: 5700, venue: 'curve' });
  e2.tick(min(22));
  const S2 = e2.state();
  assert.strictEqual(S2.gaps.length, 1);
  assert.deepStrictEqual([S2.gaps[0].from, S2.gaps[0].to], [min(8), min(22)]);
  assert.strictEqual(S2.accts['E0-U'].trades.length, 0, 'no exit credited inside the gap');
  assert.ok(S2.accts['E0-U'].pos, 'still holding, reviewed on live data');
  e2.addHypothetical(0, { acct: 'E0-U', m: M, exit: 'tp', note: 'a candle replay would have sold at the target around 12:10' });
  assert.strictEqual(S2.gaps[0].hypo.length, 1);
  assert.strictEqual(S2.accts['E0-U'].trades.length, 0, 'hypothetical results never touch the ledger');
});

test('T15: the same event twice and a restart -> one order, one fill, no duplicate trades', () => {
  const price = t => t < min(6.5) ? 0.8e-5 : 0.56e-5;
  const e = createEngine(); e.init(min(-1)); e.ingest({ type: 'run_start', at: min(-1), run: 'a' });
  e.ingest({ id: 'x2', type: 'crossing', at: min(-0.5), m: M2, sym: 'FROGO', name: 'Frog Other' });
  e.ingest({ id: 'x1', type: 'crossing', at: T0, m: M, sym: 'FROGT', name: 'Frog Test', hiMc: HI * 1e9, bc: BC });
  e.ingest({ id: 'x1', type: 'crossing', at: T0, m: M, sym: 'FROGT', name: 'Frog Test', hiMc: HI * 1e9, bc: BC });   // duplicate
  assert.strictEqual(e.state().crosses.filter(x => x[1] === M).length, 1);
  e.ingest({ id: 'a1', type: 'audit', at: min(5), m: M, valid: true, fields: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true } });
  e.ingest({ id: 'r1', type: 'rugcheck', at: min(5), m: M, valid: true, risks: [] });
  let reqs = [];
  for (let t = min(5); t <= min(7); t += 5000) { e.ingest({ id: 's' + t, type: 'snapshot', m: M, at: t, src: 'dex', valid: true, p: price(t), ps: price(t) / SOL_USD, venue: 'curve' }); reqs = reqs.concat(e.tick(t).filter(r => r.side === 'buy')); }
  const r = reqs.find(x => x.orderId.startsWith('E0-U:'));
  assert.ok(r, 'E0-U asked for a buy quote');
  const q = stdQuote(r, min(7) + 1000, price(min(7)));
  e.ingest(q); e.ingest(q);                                   // the same quote delivered twice
  assert.strictEqual(e.state().accts['E0-U'].n.fills, 1);
  // restart with another order in flight: it is cancelled, and its late quote is ignored
  const other = reqs.find(x => x.orderId.startsWith('E0-U2:'));
  const e2 = createEngine(); e2.load(e.save());
  e2.ingest({ type: 'run_start', at: min(7) + 20000, run: 'b' });
  assert.strictEqual(e2.state().orders[other.orderId].status, 'cancelled');
  e2.ingest(stdQuote(other, min(7) + 21000, price(min(7))));
  assert.ok(!e2.state().accts['E0-U2'].pos, 'late quote for a cancelled order does not fill');
  assert.strictEqual(e2.state().accts['E0-U'].n.fills, 1);
});

test('T20 (engine side): a snapshot that failed validation blocks entries on that coin with a logged reason', () => {
  const e = createEngine(); e.init(min(-1)); e.ingest({ type: 'run_start', at: min(-1), run: 'a' });
  e.ingest({ id: 'x2', type: 'crossing', at: min(-0.5), m: M2, sym: 'FROGO', name: 'Frog Other' });
  e.ingest({ id: 'x1', type: 'crossing', at: T0, m: M, sym: 'FROGT', name: 'Frog Test', hiMc: HI * 1e9, bc: BC });
  e.ingest({ id: 'a1', type: 'audit', at: min(1), m: M, valid: true, fields: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true } });
  e.ingest({ id: 'r1', type: 'rugcheck', at: min(1), m: M, valid: true, risks: [] });
  e.ingest({ id: 's1', type: 'snapshot', m: M, at: min(2), src: 'dex', valid: true, p: 0.8e-5, ps: 0.8e-7, venue: 'curve' });
  e.tick(min(2));
  e.ingest({ id: 's2', type: 'snapshot', m: M, at: min(3), src: 'dex', valid: false, reason: 'priceUsd missing (schema change?)' });
  e.ingest({ id: 's3', type: 'snapshot', m: M, at: min(3) + 1, src: 'jup', valid: true, p: 0.5e-5, ps: 0.5e-7 });
  const reqs = e.tick(min(3) + 2);
  assert.strictEqual(reqs.filter(r => r.side === 'buy').length, 0, 'no entry while the dex feed for this coin is invalid');
  assert.ok(e.state().log.some(x => x.type === 'DataInvalid' && /schema/.test(x.reason)));
});
