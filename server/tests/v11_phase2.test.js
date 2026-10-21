'use strict';
/* v11 Phase 2 (survival controls and execution realism): audit tests T04, T07, T11, T13, T17, T18. */
const test = require('node:test');
const assert = require('node:assert');
const { World, SOLUSD, MODEL, ST } = require('./v11_world.js');
const LEGACY = require('../sniper.js');
const RISK = require('../v11/risk.js');

const BOT = id => LEGACY.RULES.BOTS.find(b => b.id === id);
const path = pts => t => { if (t <= pts[0][0]) return pts[0][1]; for (let i = 1; i < pts.length; i++) if (t <= pts[i][0]) { const [a, x] = pts[i - 1], [b, y] = pts[i]; return x + (y - x) * (t - a) / (b - a); } return pts[pts.length - 1][1]; };
const costs = { prioSol: 0.0002, netFeeSol: 0.000005, latency: 0.005 };
const mcSol = usd => usd / SOLUSD / 1e9;   // market cap in USD -> SOL per token

test('T04: a stop below the curve floor is never planned; it becomes the curve worst case, or the trade is refused', () => {
  const at = 1792500000;
  // the legacy 90% stop at a $4.4K entry: 10% of the entry price is far under the floor (~$2.9K market cap)
  const p = RISK.plan({ pSol: mcSol(4400), stage: 'curve', liq: null, at, stake: 1, stopFrac: 0.9, costs, riskBudget: 0.6 });
  assert.strictEqual(p.ok, true);
  assert.strictEqual(p.stopPx, null, 'no unreachable price stop');
  assert.match(p.stopNote, /below the curve floor/);
  assert.ok(p.worstLoss > 0 && p.worstLoss < p.cost, `bounded worst case ${p.worstLoss.toFixed(3)} SOL`);
  // the same entry with a budget smaller than the curve worst case even at the minimum size: refused
  const r = RISK.plan({ pSol: mcSol(4400), stage: 'curve', liq: null, at, stake: 1, stopFrac: 0.9, costs, riskBudget: 0.01 });
  assert.strictEqual(r.ok, false); assert.match(r.why, /over the 0.01 SOL budget/);
  // property: across entries and stop depths, a planned curve stop is always reachable
  for (const mc of [3200, 4400, 7000, 12000, 30000]) for (const sf of [0.1, 0.25, 0.5, 0.75, 0.9]) {
    const q = RISK.plan({ pSol: mcSol(mc), stage: 'curve', liq: null, at, stake: 1, stopFrac: sf, costs, riskBudget: 5, maxBreakEven: 1 });
    if (q.ok && q.stopPx != null) assert.ok(q.stopPx > MODEL.CURVE_FLOOR, `mc ${mc} stop ${sf}`);
  }
  // E0 keeps the legacy stop for measurement but flags it at entry
  const w = new World({ strategies: [ST.E0(BOT('U'))] });
  const T = w.t0 + 1000;
  const c = w.coin({ created: T - 600, price: path([[T - 600, 3000], [T, 7100], [T + 60, 7400], [T + 200, 4400], [T + 3000, 4300]]) }); w.partner(c, T - 120);
  w.checks(c, T + 20, T + 25).run(T + 400);
  const pos = w.acct('E0-U').pos;
  assert.ok(pos && pos.flags.some(f => /below the curve floor/.test(f)), 'legacy stop flagged as unreachable');
  assert.ok(pos.mark.worst > 0, 'its worst case is shown');
});

test('T07: the sell route disappears: the exit is logged unfilled and the position is marked distressed, not at its old price', () => {
  const w = new World({ strategies: [ST.E0(BOT('U30'))] });
  const T = w.t0 + 1000, lost = T + 900;
  const c = w.coin({ created: T - 600, price: path([[T - 600, 3000], [T, 7100], [T + 60, 10000], [T + 200, 5800], [T + 3000, 5600]]), quote: t => t >= lost ? 'noroute' : 'ok' });
  w.partner(c, T - 120);
  w.feed = t => t < lost;   // the pool and its prices vanish together
  w.checks(c, T + 20, T + 25).run(T + 2600);
  const A = w.acct('E0-U30'), pos = A.pos, S = w.eng.state();
  assert.ok(pos, 'still holding: nothing could be sold');
  assert.strictEqual(A.trades.length, 0);
  assert.strictEqual(pos.state, 'exit_unavailable');
  assert.ok(pos.exitFails >= 2, 'repeated exit attempts');
  assert.strictEqual(pos.mark.v, null, 'no current value');
  assert.strictEqual(pos.mark.src, 'u');
  assert.ok(pos.mark.last > 0 && pos.mark.lastAt < lost + 60, 'last known value kept with its age');
  assert.ok(pos.mark.worst > 0 && pos.mark.worst < pos.mark.last, 'worst case shown separately');
  assert.ok(S.dec.some(d => d.k === 'exit-fail' && /no route/.test(d.t)));
  const last = A.eq[A.eq.length - 1];
  assert.strictEqual(last[3], 'u', 'equity ledger flags the unpriceable minute');
  assert.ok(last[2] < last[1], 'with its worst-case band');
});

test('T11: stale prices are labeled and halt entries; the old close is not shown as a live value', () => {
  // (a) the price feed stops while a position is open
  const w = new World({ strategies: [ST.E0(BOT('U2'))] });
  const T = w.t0 + 1000, stop = T + 600;
  // the whole data plane is down: no prices and no quotes
  const c = w.coin({ created: T - 600, price: path([[T - 600, 3000], [T, 7100], [T + 60, 10000], [T + 200, 5800], [T + 3000, 5700]]), quote: t => t >= stop && t < stop + 180 ? 'none' : 'ok' });
  w.partner(c, T - 120);
  w.feed = t => t < stop || t >= stop + 180;
  w.checks(c, T + 20, T + 25).run(stop + 100);
  const S = w.eng.state(), A = w.acct('E0-U2');
  assert.strictEqual(S.status.state, 'incomplete');
  assert.match(S.status.why.join(), /no prices for \d+ s/);
  assert.ok(A.pos && A.pos.mark.v === null && A.pos.mark.src === 'u', 'held coin unpriced');
  assert.match(A.pos.mark.why, /price \d+ s old/);
  w.run(stop + 240);
  assert.strictEqual(S.status.state, 'forward');
  assert.ok(A.pos.mark.v > 0, 'priced again once fresh data arrives');
  // (b) SOL/USD goes stale: entries halt even though coin prices are fresh
  const w2 = new World({ strategies: [ST.E0(BOT('U'))] });
  const T2 = w2.t0 + 1000;
  const c2 = w2.coin({ created: T2 - 600, price: path([[T2 - 600, 3000], [T2, 7100], [T2 + 60, 10000], [T2 + 900, 9500], [T2 + 1000, 5800], [T2 + 3000, 5800]]) });
  w2.partner(c2, T2 - 120);
  w2.solOn = t => t < T2 + 200 || t >= T2 + 1300;
  w2.checks(c2, T2 + 20, T2 + 25).run(T2 + 1250);
  assert.strictEqual(w2.eng.state().status.state, 'incomplete');
  assert.strictEqual(w2.acct('E0-U').pos, null, 'no entry while SOL/USD is stale');
  w2.run(T2 + 1400);
  assert.ok(w2.acct('E0-U').pos, 'entry once the data is complete again');
});

test('T13: graduation: no fills and no marks while the curve is complete and the pool is unconfirmed; pool fees after', () => {
  const T = 1792500000 + 1000, full = T + 300, grad = T + 480;
  const addr = require('./v11_world.js').addr;
  // a coin late on the curve; the curve completes at `full` and its PumpSwap pool shows up 3 minutes later
  const mk = () => ({ created: T - 1200, grad, pool: addr(), price: path([[T - 1200, 3000], [T - 60, 37000], [T + 30, 38000], [full, 43500], [grad + 3000, 46000]]),
    quote: t => t >= full && t < grad ? 'noroute' : 'ok' });
  // X buys late on the curve and wants out during the migration; Y tries to buy during it
  const X = { id: 'X', kind: 'test', gate: null, label: 'X', entry(ctx, A, now) { const k = ctx.coin(c.m); if (!A.b && k && now > T + 30) { A.b = 1; ctx.buy(A, { m: c.m, stake: 1, sigPx: k.last.sol, why: 'test' }, now); } },
    review(ctx, A, pos, now) { return now >= full + 60 ? { exit: true, reason: 'test', why: 'test exit' } : null; } };
  const Y = { id: 'Y', kind: 'test', gate: null, label: 'Y', entry(ctx, A, now) { const k = ctx.coin(c.m); if (!A.b && k && now > full + 30) { A.b = 1; ctx.buy(A, { m: c.m, stake: 1, sigPx: k.last.sol || 1, why: 'test' }, now); } }, review() { return null; } };
  const w = new World({ strategies: [X, Y] });
  const c = w.coin(mk());
  // crossing needs the coin to be followed: it is young (pair created 20 min before) and above $7K
  w.run(full + 120);
  const S = w.eng.state(), A = w.acct('X'), k = S.coins[c.m];
  assert.strictEqual(k.stage, 'migrating');
  assert.ok(A.pos, 'X holds through the graduation');
  assert.strictEqual(A.pos.mark.v, null); assert.strictEqual(A.pos.mark.why, 'graduating');
  assert.strictEqual(A.trades.length, 0, 'no exit while no venue can fill it');
  assert.ok(A.pos.exitFails >= 1, 'the exit was tried and logged unfilled');
  assert.strictEqual(w.acct('Y').pos, null, 'no entry during the migration');
  w.run(grad + 120);
  assert.strictEqual(k.stage, 'pool');
  const tr = A.trades[0];
  assert.ok(tr && tr.exitQuoteAt >= grad, 'exit only after the pool is confirmed');
  assert.deepStrictEqual(tr.exitRoute, ['Pump.fun Amm']);
  assert.ok(A.pos === null && !S.dec.some(d => (d.k === 'win' || d.k === 'loss') && d.at >= full && d.at < grad));
  // marks after graduation use the pool's fee tiers, not the curve's flat rate (first tier, under 420 SOL, is also 1.25%)
  assert.strictEqual(MODEL.sellOut(1e6, mcSol(44000), 'pool', null, grad).rate, 0.0125);
  assert.strictEqual(MODEL.sellOut(1e6, mcSol(60000), 'pool', null, grad).rate, 0.012);
  assert.strictEqual(MODEL.sellOut(1e6, mcSol(60000), 'curve', null, grad).rate, 0.0125);
});

test('T17: doubling the size in a thin pool raises the impact; the plan cuts the size or refuses it', () => {
  const at = 1792500000, pSol = mcSol(60000), liq = { base: 4e7, quote: 4e7 * pSol };   // a thin PumpSwap pool (~23 SOL)
  const one = MODEL.buyOut(1, pSol, 'pool', liq, at), two = MODEL.buyOut(2, pSol, 'pool', liq, at);
  assert.ok(two.impact > one.impact * 1.7, `impact ${(one.impact * 100).toFixed(1)}% -> ${(two.impact * 100).toFixed(1)}%`);
  const a = RISK.plan({ pSol, stage: 'pool', liq, at, stake: 2, stopFrac: 0.3, costs, maxImpact: 0.06, riskBudget: 5, maxBreakEven: 1 });
  assert.ok(a.ok && a.stake <= 1, `cut to ${a.stake} SOL`); assert.match(a.notes.join(), /size cut/);
  const b = RISK.plan({ pSol, stage: 'pool', liq: { base: 1e6, quote: 1e6 * pSol }, at, stake: 2, stopFrac: 0.3, costs, maxImpact: 0.06, riskBudget: 5 });
  assert.strictEqual(b.ok, false); assert.match(b.why, /too thin/);
  // and an order whose quote comes back with more impact than allowed is not filled
  const w = new World({ strategies: [] });
  const T = w.t0 + 1000;
  const c = w.coin({ created: T - 600, price: path([[T - 600, 3000], [T, 7100], [T + 3000, 7200]]) });
  const strat = { id: 'X', kind: 'test', gate: null, label: 'X', entry(ctx, A, now) { if (!A.done && now > T + 30 && ctx.coin(c.m)) { A.done = 1; ctx.buy(A, { m: c.m, stake: 2, sigPx: ctx.coin(c.m).last.sol, maxImpact: 0.02, why: 'test' }, now); } }, review() { return null; } };
  const w2 = new World({ strategies: [strat] }); w2.coins = w.coins;
  w2.run(T + 80);
  assert.strictEqual(w2.acct('X').pos, null);
  assert.ok(w2.eng.state().dec.some(d => /price impact .* over the 2% limit/.test(d.t)));
});

test('T18: a winning trade that first went deep under water records its adverse excursion and the drawdown', () => {
  const w = new World({ strategies: [ST.E0(BOT('U2'))] });
  const T = w.t0 + 1000;
  const c = w.coin({ created: T - 600, price: path([[T - 600, 3000], [T, 7100], [T + 60, 10000], [T + 200, 5800], [T + 600, 3600], [T + 900, 3600], [T + 1500, 7000], [T + 4000, 7000]]) });
  w.partner(c, T - 120);
  w.checks(c, T + 20, T + 25).run(T + 1600);
  const A = w.acct('E0-U2'), tr = A.trades[0];
  assert.ok(tr && tr.net > 0, 'closed with a profit');
  assert.ok(tr.mae < -0.25, `adverse excursion ${(tr.mae * 100).toFixed(1)}% recorded`);
  assert.ok(tr.mfe >= tr.ret - 0.02);
  assert.ok(A.mdd < -0.02, `account drawdown ${(A.mdd * 100).toFixed(2)}% from the minute marks, though every closed trade won`);
  assert.ok(A.trades.every(t => t.net > 0));
});
