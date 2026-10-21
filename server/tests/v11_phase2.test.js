'use strict';
/* Phase 2 (survival controls and execution realism): audit tests T04, T07, T13, T17, T18 and T20 (payload validation). */
const test = require('node:test');
const assert = require('node:assert');
const E = require('../sniper.js');
const R = require('../v11/risk.js');
const X = require('../v11/model.js');
const RT = require('../v11/runtime.js');
const { createEngine } = require('../v11/engine.js');
const { T0, min, SOL_USD, M, harness, ordersOf } = require('./helpers.js');

test('T04: a low-cap entry whose stop sits under the curve floor is rejected, or gets an explicit plan without it', () => {
  const at = T0, ps = 7000 / SOL_USD / 1e9;     // $7K market cap on the curve
  const legacyStop = { venue: 'curve', ps, size: 1, stopPs: 0.1 * ps, horizonMs: 0, riskBudget: 0.5, at };
  assert.strictEqual(R.checkPlan(legacyStop).ok, false, 'no horizon: rejected');
  const r = R.checkPlan(Object.assign({}, legacyStop, { horizonMs: 3600e3 }));
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /under the curve floor: it can never trigger/);
  const c = R.checkPlan(Object.assign({}, legacyStop, { horizonMs: 3600e3, riskBudget: 0.7, allowConvert: true }));
  assert.strictEqual(c.ok, true);
  assert.strictEqual(c.plan.stopPs, null, 'the fictional stop is gone');
  assert.ok(c.plan.horizonMs <= 30 * 60000, 'a finite horizon carries the risk instead');
  assert.ok(c.plan.maxLoss > 0.55 && c.plan.maxLoss < 0.65, `worst case shown honestly: ${c.plan.maxLoss.toFixed(3)} SOL at the curve floor`);
  const tight = R.checkPlan(Object.assign({}, legacyStop, { stopPs: 0.8 * ps, horizonMs: 600e3, riskBudget: 0.3 }));
  assert.strictEqual(tight.ok, true, 'a reachable stop within budget passes');
  assert.ok(tight.plan.roundTripCost > 0.05, 'round-trip cost at size is reported before the trade');
});

test('T07: the sell route disappears -> distressed mark, unfilled exit logged, nothing sold at a fictional price', () => {
  // E0-U30 buys the 12:06:30 dip; from 12:10 every sell quote answers "no route"
  const price = t => t < min(6.5) ? 0.8e-5 : 0.56e-5;
  const noRoute = (r, at) => (r.side === 'sell' && at >= min(10)) ? { id: `nr:${r.orderId || r.m}:${at}`, type: 'quote', at, orderId: r.orderId, m: r.m, side: 'sell', inAmount: r.amount, ok: false, err: 'no route (HTTP 400)', noRoute: true, valid: true } : null;
  const { S } = harness({ price, stopAt: min(40), quote: noRoute });
  assert.ok(S.log.some(e => e.type === 'SellRouteLost'), 'route loss detected from failed sell quotes');
  const A = S.accts['E0-U30'];
  assert.ok(A.pos, 'still holding: nothing could be sold');
  assert.strictEqual(A.pos.mark.src, 'route-lost');
  assert.strictEqual(A.pos.mark.value, null);
  assert.strictEqual(A.pos.mark.distressed, true);
  assert.strictEqual(A.pos.state, 'exit_unavailable');
  const tries = ordersOf(S, 'E0-U30', 'sell');
  assert.ok(tries.length >= 1 && tries.every(o => o.status === 'failed' && /no executable route/.test(o.reason)), 'the 30-minute exit was attempted and logged unfilled');
  assert.strictEqual(A.trades.length, 0);
  const eq = createEngine(); eq.load(JSON.parse(JSON.stringify(S)));
  assert.strictEqual(eq.equityNow(eq.state().accts['E0-U30']).known, false, 'equity unknown, not stable');
});

test('T13: the coin graduates between curve and pool -> fills pause while the venue is uncertain, then use the pool', () => {
  // dip at 12:06:30 is bought on the curve; at 12:08 the curve nears completion (migrating), from 12:12 the pool trades
  const ps0 = 0.97 * E.GRAD_MC_SOL / 1e9;      // SOL/token where the curve is 97% complete
  const price = t => t < min(6.5) ? 0.8e-5 : t < min(8) ? 0.56e-5 : t < min(12) ? ps0 * SOL_USD * 1.01 : ps0 * SOL_USD * 1.2;
  const venue = t => t < min(12) ? 'curve' : 'pool';
  const { S } = harness({ price, venue, stopAt: min(16) });
  const reviews = S.log.filter(e => e.type === 'PositionReviewed' && e.acct === 'E0-U');
  assert.ok(reviews.some(e => e.state === 'paused' && /graduating/.test(e.why)), 'paused while migrating');
  const sells = ordersOf(S, 'E0-U', 'sell');
  assert.ok(!sells.some(o => o.status === 'filled' && o.doneAt < min(12)), 'no fill while the venue was uncertain');
  const t = S.accts['E0-U'].trades[0];
  assert.ok(t, 'sold once the pool traded');
  assert.ok(t.closeAt >= min(12), 'after graduation');
  assert.deepStrictEqual(t.exitRoute, ['Pump.fun Amm'], 'filled on the pool');
  assert.strictEqual(S.coins[M].stage, 'pool');
});

test('T17: doubling the size in thin liquidity raises the quoted impact; the engine cuts or rejects the size', () => {
  const ps = 5000 / SOL_USD / 1e9;
  const i1 = 1 - X.buyOut(1, ps, 'curve', T0).tokens / (1 * 0.9875 / ps), i2 = 1 - X.buyOut(2, ps, 'curve', T0).tokens / (2 * 0.9875 / ps);
  assert.ok(i2 > i1 * 1.8, `impact rises with size: ${(i1 * 100).toFixed(1)}% -> ${(i2 * 100).toFixed(1)}%`);
  // an account limited to 8% impact: the first 1 SOL quote shows 12% -> failed, size halved; the 0.5 SOL quote fills
  const price = t => t < min(6.5) ? 0.8e-5 : 0.56e-5;
  const thin = (r, at, p) => r.side === 'buy' ? { id: `t:${r.orderId}:${at}`, type: 'quote', at, orderId: r.orderId, m: r.m, side: 'buy', inAmount: r.amount,
    outAmount: Math.floor(X.buyOut(r.amount / 1e9, p / SOL_USD, 'curve', at).tokens * 1e6 * (r.amount > 0.6e9 ? 0.9 : 1)), impactPct: r.amount > 0.6e9 ? 0.12 : 0.06, route: ['Pump.fun'], venue: 'curve', ok: true, valid: true } : null;
  const setup = S => { Object.assign(S.accts['E0-U'], { maxImpact: 0.08, minStake: 0.3 }); };
  const { S } = harness({ price, stopAt: min(9), quote: thin, setup });
  const buys = ordersOf(S, 'E0-U', 'buy');
  assert.ok(buys[0].status === 'failed' && /too thin/.test(buys[0].reason), 'the 1 SOL order is refused for its impact');
  const filled = buys.find(o => o.status === 'filled');
  assert.ok(filled && Math.abs(filled.size - 0.5) < 1e-9, 'the next order is half the size and fills');
  // and a coin too thin even at the minimum is skipped with a reason
  const { S: S2 } = harness({ price, stopAt: min(10), quote: (r, at, p) => r.side === 'buy' ? Object.assign(thin(r, at, p), { impactPct: 0.2 }) : null, setup });
  assert.ok(ordersOf(S2, 'E0-U', 'buy').every(o => o.status === 'failed'));
  assert.ok(S2.log.some(e => e.type === 'EntrySkipped' && e.acct === 'E0-U') || ordersOf(S2, 'E0-U', 'buy').length <= 3, 'stops trying once under the minimum');
});

test('T18: a winning trade that first went well under water records its adverse and favorable excursions', () => {
  // bought on the dip at 0.56, falls to 0.45 (-20%), then rallies to the target
  const price = t => t < min(6.5) ? 0.8e-5 : t < min(8) ? 0.56e-5 : t < min(11) ? 0.45e-5 : t < min(13) ? 0.62e-5 : 0.7e-5;
  const { S } = harness({ price, stopAt: min(16) });
  const t = S.accts['E0-U'].trades[0];
  assert.ok(t && t.net > 0, 'closed as a win');
  assert.ok(t.mae < -0.15, `max adverse excursion recorded: ${(t.mae * 100).toFixed(1)}%`);
  assert.ok(t.mfe > 0, `max favorable excursion recorded: ${(t.mfe * 100).toFixed(1)}%`);
  assert.ok(S.accts['E0-U'].mdd < -0.01, 'account drawdown counts the open loss, not only closed trades');
});

test('T20: schema changes or missing fields fail safe with a logged reason', () => {
  const at = T0;
  const okPair = { baseToken: { address: M }, quoteToken: { symbol: 'SOL' }, dexId: 'pumpfun', pairAddress: 'P', priceUsd: '0.000007', priceNative: '0.00000007', marketCap: 7000, txns: { m5: { buys: 3, sells: 2 } }, volume: { m5: 100 } };
  assert.strictEqual(RT.fromDex([okPair], M, at).valid, true);
  const noPrice = RT.fromDex([Object.assign({}, okPair, { priceUsd: undefined })], M, at);
  assert.strictEqual(noPrice.valid, false); assert.match(noPrice.reason, /priceUsd/);
  const renamed = RT.fromDex([Object.assign({}, okPair, { priceUsd: undefined, price_usd: '0.000007' })], M, at);
  assert.strictEqual(renamed.valid, false, 'a renamed field is not silently read as zero');
  assert.strictEqual(RT.fromDex({ pairs: [] }, M, at).valid, false, 'a changed envelope fails');
  assert.strictEqual(RT.fromDex([], M, at), null, 'not listed yet: no observation');
  const j = RT.fromJup({ id: M, usdPrice: 'abc' }, at, 100);
  assert.strictEqual(j.valid, false); assert.match(j.reason, /usdPrice/);
  const jok = RT.fromJup({ id: M, usdPrice: 7e-6, mcap: 7000, stats5m: { buyVolume: 10 } }, at, 100);
  assert.ok(jok.valid && Number.isNaN(jok.st.sv), 'a missing sell volume stays NaN (unknown), never 0');
  assert.strictEqual(RT.fromQuote({ inAmount: '1', routePlan: [] }).valid, false, 'quote without outAmount fails validation');
  const nr = RT.fromQuote({ error: 'Could not find any route', errorCode: 'COULD_NOT_FIND_ANY_ROUTE' });
  assert.strictEqual(nr.valid, true); assert.strictEqual(nr.ok, false);
  const q = RT.fromQuote({ inAmount: '1000', outAmount: '5', priceImpactPct: '0.01', routePlan: [{ swapInfo: { label: 'Pump.fun' } }] });
  assert.strictEqual(q.venue, 'curve');
  // the engine refuses to fill from an invalid quote
  const price = t => t < min(6.5) ? 0.8e-5 : 0.56e-5;
  const bad = (r, at2) => ({ id: `b:${r.orderId || r.m}:${at2}`, type: 'quote', at: at2, orderId: r.orderId, m: r.m, side: r.side, inAmount: r.amount, valid: false, reason: 'quote: inAmount/outAmount/routePlan missing (schema change?)' });
  const { S } = harness({ price, stopAt: min(8), quote: bad });
  const buys = ordersOf(S, 'E0-U', 'buy');
  assert.ok(buys.length && buys.every(o => o.status === 'failed' && /validation/.test(o.reason)));
  assert.ok(!S.accts['E0-U'].pos);
});

test('E0 follows the legacy watchlist: a coin the legacy bot skipped (full slots) or swapped out is not bought', () => {
  // the 40% dip comes at 12:06:30; the legacy decision says only U2 and STR watch the coin, and at 12:06:00 U2 swaps it out
  const price = t => t < min(6.5) ? 0.8e-5 : 0.56e-5;
  const drop = { id: 'lw-other', type: 'legacy_watch', at: min(6), m: 'OtherCoinpump', bots: ['U2'], dropped: [['U2', M]] };
  const { S } = harness({ price, stopAt: min(8), legacyBots: ['U2', 'STR'], extraEvents: [drop] });
  assert.ok(!S.accts['E0-U'].pos && ordersOf(S, 'E0-U', 'buy').length === 0, 'E0-U: its legacy bot never watched it (watchlist full)');
  const seen = S.accts['E0-U'].seen[M];
  assert.ok(seen && !seen.pass && seen.why.some(w => /free watch slot/.test(w)), 'logged as a full watchlist');
  assert.strictEqual(ordersOf(S, 'E0-U2', 'buy').length, 0, 'E0-U2: swapped out before the dip, so no buy');
  assert.ok(S.log.some(e => e.type === 'WatchDropped' && e.acct === 'E0-U2'));
  assert.ok(ordersOf(S, 'E0-STR', 'buy').length >= 1, 'E0-STR still watches it and buys the dip');
});

test('per-account revision: only the revised accounts restart, the others keep their ledgers', () => {
  const e0 = createEngine(); e0.init(T0); const S0 = e0.state();
  S0.accts['E0-U'].rev = 1; S0.accts['E0-U'].cash = 9; S0.accts['A'].cash = 9.5;
  const e = createEngine(); e.load(JSON.parse(JSON.stringify(S0)));
  const S = e.state();
  assert.strictEqual(S.accts['E0-U'].cash, 10, 'E0 (rev 2 now) restarted');
  assert.strictEqual(S.accts['A'].cash, 9.5, 'V2 kept its ledger');
  assert.ok(S.archive.some(x => x.acct === 'E0-U' && x.engine === 'rev 1'));
});
