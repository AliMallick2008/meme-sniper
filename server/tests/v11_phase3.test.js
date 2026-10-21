'use strict';
/* Phase 3 (market intelligence, V2 strategies): audit tests T05, T06, T16, the phase exit criterion (a confirmed
   recovery and a collapse at the same drawdown are told apart), entry contracts, ranking at one decision time, and the
   RugCheck report as the second source for the dev wallet share. */
const test = require('node:test');
const assert = require('node:assert');
const RT = require('../v11/runtime.js');
const V2 = require('../v11/v2.js');
const { T0, min, M, market, path, steps, ordersOf, GOOD_AUDIT } = require('./helpers.js');

const M3 = 'Te5tCatMint111111111111111111111111111111pump';
const v2only = () => V2.accounts();                    // these scenarios look at the V2 accounts alone
const buyFlow = { bv: 7000, sv: 3000, tr: 40, nnb: 12, hc: 3 };
const sells = (S, acct) => ordersOf(S, acct, 'sell');
const buys = (S, acct) => ordersOf(S, acct, 'buy');

// Launch momentum on M: $7K at the crossing, $8K three minutes later with broad buying
function launch(after, flowAfter, opt = {}) {
  return { m: M, sym: 'FROGT', crossAt: T0, mcX: 7000, hiMc: 7000, mc: path([[0, 7000], [3, 8000]].concat(after)), flow: steps([[-1, buyFlow]].concat(flowAfter)), ...opt };
}

test('A enters on launch momentum with a complete entry contract', () => {
  const { S } = market({ coins: [launch([[5, 8300]], [])], stopAt: min(6), accounts: v2only });
  const o = buys(S, 'A')[0];
  assert.ok(o, 'A bought');
  assert.ok(o.reqAt >= min(3) && o.reqAt <= min(3.5), 'right when the setup and the demand were both confirmed');
  const k = o.contract;
  for (const key of ['strat', 'setup', 'at', 'm', 'venue', 'stage', 'crossedAt', 'firstSeenAt', 'gates', 'confirmed', 'f', 'plan', 'rank', 'social']) assert.ok(k[key] !== undefined, 'contract has ' + key);
  assert.ok(k.gates.every(g => g[1] === 'pass'), 'every gate passed, none unknown');
  assert.ok(k.f.priceAt <= o.reqAt && k.f.jupAt <= o.reqAt, 'every feature was received before the decision');
  assert.ok(k.plan.horizonMin === 20 && k.plan.lossAtLimit <= 0.25 + 1e-9 && k.plan.worstCase <= 0.8 + 1e-9, 'finite horizon, loss at the limit within the risk budget, worst case shown');
  assert.ok(k.plan.roundTripCost > 0.02 && k.plan.roundTripCost <= 0.06, `round-trip cost known before the trade: ${(k.plan.roundTripCost * 100).toFixed(2)}%`);
  assert.match(k.social, /unavailable/);
  assert.ok(k.confirmed.length >= 7, 'what confirmed the setup and the demand is listed');
  assert.strictEqual(S.accts.A.pos && S.accts.A.pos.contract.strat, 'A');
});

test('T05: the coin falls, buyers vanish -> a thesis exit, corroborated, before the loss limit', () => {
  // from 5:00 sellers take over (20% of volume), wallets net-sell, traders and holders leave; price slides 8300 -> 5500
  const coin = launch([[5, 8300], [9, 5500]], [[5, { bv: 1500, sv: 6000, tr: 14, nnb: -6, hc: -8 }]]);
  const { S } = market({ coins: [coin], stopAt: min(12), accounts: v2only });
  const t = S.accts.A.trades[0];
  assert.ok(t, 'A bought and sold');
  assert.strictEqual(t.exitReason, 'thesis');
  assert.ok(t.exitDecidedAt - min(5) <= 60000, `exit decided ${((t.exitDecidedAt - min(5)) / 1000).toFixed(0)} s after the flow turned`);
  const fam = t.v2.thesis.families;
  assert.ok(Object.values(fam).filter(x => x === 'confirmed').length >= 2, 'at least two families confirmed: ' + JSON.stringify(fam));
  assert.ok(t.ret > -0.15, `sold before the 15% loss limit (${(t.ret * 100).toFixed(1)}%)`);
  // the first flagged snapshot alone did not sell: one observation is never enough
  const firstFlag = min(5);
  assert.ok(t.exitDecidedAt >= firstFlag + 10000, 'waited for a second observation');
});

test('T06: a healthy pullback with renewed buying is not sold just because a candle is red', () => {
  // up to $9.2K, a red minute down to $8.5K (-7.6% from the high) while buying stays strong, then up again
  const coin = launch([[5, 9200], [6, 8500], [10, 9800]], [[5, { bv: 6200, sv: 3800, tr: 35, nnb: 5, hc: 2 }]]);
  const { S } = market({ coins: [coin], stopAt: min(10), accounts: v2only });
  assert.ok(S.accts.A.pos, 'still holding after the pullback');
  assert.strictEqual(sells(S, 'A').length, 0, 'no sell order at all');
  const reviews = S.log.filter(e => e.type === 'PositionReviewed' && e.acct === 'A');
  assert.ok(!reviews.some(e => e.exit), 'no exit decided');
  assert.ok(!reviews.some(e => e.thesis && Object.values(e.thesis).filter(x => x === 'confirmed').length >= 2), 'thesis never broken');
});

test('T16: a strong winner runs past a fixed target; the trailing exit is decided live and compared with that target', () => {
  // $8K -> $20K by 15:00 with steady buying, then back to $14K by 17:00 (buying merely neutral)
  const coin = launch([[15, 20000], [17, 14000], [20, 13500]], [[15, { bv: 5000, sv: 5000, tr: 30, nnb: 0, hc: 0 }]]);
  const { S } = market({ coins: [coin], stopAt: min(21), accounts: v2only });
  const t = S.accts.A.trades[0];
  assert.ok(t, 'sold');
  assert.strictEqual(t.exitReason, 'trail');
  assert.ok(t.exitDecidedAt > min(15), 'only after the top was seen');
  assert.ok(t.proceeds > t.cost * 1.5, `kept most of the run: ${(t.ret * 100).toFixed(0)}%`);
  const alt = t.v2.alt;
  assert.ok(alt && alt.tp === 0.2, 'the fixed +20% target was assessed as it happened');
  assert.ok(alt.at < min(7) && alt.value < t.proceeds, `a +20% target would have sold at ${new Date(alt.at).toISOString().slice(14, 19)} for ${alt.value.toFixed(3)} SOL vs ${t.proceeds.toFixed(3)}`);
  assert.ok(t.v2.peakRet > t.ret, 'gave back part of the best mark, as designed (no hindsight top)');
});

// the phase 3 exit criterion: same 40% drawdown, opposite evidence
function pullback(after, flowAfter) {
  return { m: M, sym: 'FROGT', crossAt: T0, mcX: 7000, hiMc: 7000, mc: path([[0, 7000], [8, 14000], [14, 8400]].concat(after)),
    flow: steps([[-1, buyFlow], [8, { bv: 3000, sv: 6000, tr: 30, nnb: -2, hc: -1 }]].concat(flowAfter)) };
}
test('Phase 3 exit criterion: a confirmed recovery and a collapse at the same 40% drawdown are told apart', () => {
  const rec = pullback([[15, 8400], [18, 9600], [22, 10200]], [[14, { bv: 4000, sv: 4500, tr: 20, nnb: 1, hc: 0 }], [15, { bv: 6000, sv: 3500, tr: 22, nnb: 4, hc: 1 }]]);
  const col = pullback([[18, 7000], [22, 6200]], [[14, { bv: 2000, sv: 8000, tr: 18, nnb: -5, hc: -6 }]]);
  const R = market({ coins: [rec], stopAt: min(20), accounts: v2only }).S;
  const C = market({ coins: [col], stopAt: min(20), accounts: v2only }).S;
  const ob = buys(R, 'B')[0];
  assert.ok(ob, 'B buys the confirmed recovery');
  assert.ok(ob.reqAt >= min(16.5), 'only once the bounce, the higher low and the eased selling were all seen');
  const conf = Object.fromEntries(ob.contract.confirmed);
  assert.ok(conf['pullback of 25-60% from the high'] === '40%', 'same 40% pullback');
  assert.ok(/of the peak/.test(conf['selling eased: 5-minute sells at most 75% of their heaviest since the high']), 'selling eased, with the evidence');
  assert.strictEqual(ob.contract.plan.invalidWhy, 'failed reclaim: back under the pullback low');
  assert.ok(Math.abs(ob.contract.plan.invalidP / (8400 / 1e9) - 0.97) < 1e-6, 'invalid under the pullback low');
  assert.strictEqual(buys(C, 'B').length, 0, 'B does not buy the collapse');
  assert.ok(C.accts.B.funnel.gates >= 1 && C.accts.B.funnel.setup === 0, 'the collapse was seen and rejected at the setup stage');
});

test('ranking: two coins qualify at the same tick; the stronger evidence wins and the other is recorded', () => {
  const weak = launch([[5, 8300]], [[-1, { bv: 6200, sv: 3800, tr: 30, nnb: 5, hc: 1 }]]);
  const strong = { m: M3, sym: 'CATT', crossAt: T0, mcX: 7000, hiMc: 7000, mc: path([[0, 7000], [3, 8000], [5, 8300]]), flow: steps([[-1, { bv: 8500, sv: 1500, tr: 50, nnb: 18, hc: 4 }]]) };
  const { S } = market({ coins: [weak, strong], stopAt: min(4), accounts: v2only });
  const o = buys(S, 'A')[0];
  assert.strictEqual(o.m, M3, 'the coin with more buying and more buyers');
  assert.strictEqual(o.contract.rank.n, 2);
  assert.strictEqual(o.contract.rank.alternatives[0].m, M);
  assert.ok(o.contract.rank.alternatives[0].behind > 0);
  assert.match(o.why, /ranked first of 2/);
});

test('an unknown dev wallet share blocks entry until the RugCheck report supplies it', () => {
  const noDev = Object.assign({}, GOOD_AUDIT); delete noDev.devBalancePercentage;
  const coin = launch([[8, 9800]], [], { audit: noDev });
  const rep = { id: 'rr1', type: 'rcreport', at: min(4.5), reqAt: min(4.4), m: M, valid: true, creatorPct: 0, devWallet: 'D', devWalletPct: 0, devHow: 'not among the holders', devBound: false, devPct: 0, top10: 14, risks: [] };
  const { S: before } = market({ coins: [coin], stopAt: min(4.4), accounts: v2only });
  assert.strictEqual(buys(before, 'A').length, 0, 'no buy while the dev share is unknown');
  assert.ok(before.log.some(e => e.type === 'EligibilityDecided' && e.acct === 'A' && e.state === 'unknown' && /Dev wallet.*unknown/.test(e.why)), 'logged as unknown, not as 0%');
  const { S } = market({ coins: [coin], stopAt: min(6), accounts: v2only, setup: null, extra: [rep] });
  const o = buys(S, 'A')[0];
  assert.ok(o && o.reqAt >= min(4.5), 'eligible once the report arrived');
  assert.deepStrictEqual(o.contract.gates.find(g => g[0] === 'dev').slice(0, 2), ['dev', 'pass']);
});

test('RugCheck report parsing (probed Oct 21 2026): dev share from the creator balance and the holder list', () => {
  const a = require('./fixtures/rugcheck_report_ALPEN.json').response, b = require('./fixtures/rugcheck_report_FKED.json').response;
  const r = RT.fromRcReport(a, a.mint, 1, '3vYwPy9ksuq6gUWRGR84tifJmetpWsTzKtPKtRL1xK2D');
  assert.strictEqual(r.valid, true);
  assert.strictEqual(r.creatorPct, 0, 'creator balance 0 -> 0%');
  assert.ok(r.devBound && r.devWalletPct < 0.5, `Jupiter's dev wallet is not in the top 20: at most ${r.devWalletPct}%`);
  assert.ok(r.top10 > 10 && r.top10 < 25, `top 10 without the curve: ${r.top10.toFixed(1)}%`);
  assert.ok(r.risks.some(x => x[0] === 'Low Liquidity' && x[1] === 'danger'));
  const r2 = RT.fromRcReport(b, b.mint, 1, null);
  assert.strictEqual(r2.devPct, 0);
  assert.strictEqual(RT.fromRcReport(Object.assign({}, a, { token: {} }), a.mint, 1, null).valid, false, 'missing supply fails safe');
  assert.strictEqual(RT.fromRcReport(a, b.mint, 1, null).valid, false, 'a report for another mint is rejected');
  // Jupiter leaves fields out instead of sending zero: they stay unknown
  const j = require('./fixtures/jupiter_search_FKED_ALPEN.json').response.find(x => x.id === a.mint);
  const s = RT.fromJup(j, 1, 108);
  assert.ok(Number.isNaN(s.st.bov) && s.st.sov > 0, 'missing organic buy volume is unknown, not 0');
  assert.strictEqual(s.dev, '3vYwPy9ksuq6gUWRGR84tifJmetpWsTzKtPKtRL1xK2D');
});

test('engine 11.1: a lagging DexScreener price never overwrites a fresh Jupiter price; it is only a fallback', () => {
  const MK = require('../v11/market.js');
  const c = MK.newCoin({ m: M, at: T0, mcX: 7000, hiMc: 7000 });
  const obs = (src, at, p, asOf) => Object.assign({ m: M, at, src, valid: true, p, ps: p / 100, mc: p * 1e9 }, src === 'jup' ? { asOf, st: {} } : { venue: 'curve' });
  MK.observe(c, obs('dex', T0 + 1000, 7e-6));
  assert.strictEqual(c.last.src, 'dex', 'no Jupiter price yet: DexScreener is used');
  MK.observe(c, obs('jup', T0 + 5000, 9e-6, T0 + 4000));
  assert.strictEqual(c.last.p, 9e-6, 'Jupiter takes over');
  MK.observe(c, obs('dex', T0 + 6000, 7.2e-6));
  assert.strictEqual(c.last.p, 9e-6, 'the lagging DexScreener price is ignored while Jupiter is recent');
  assert.strictEqual(c.bars[c.bars.length - 1].l, 7e-6, 'and it does not enter the bars either');
  MK.observe(c, obs('jup', T0 + 15000, 8e-6, T0 + 2000));
  assert.strictEqual(c.last.p, 9e-6, 'an answer with older Jupiter data does not replace newer data');
  MK.observe(c, obs('jup', T0 + 25000, 9e-6, T0 + 4000));
  assert.strictEqual(c.last.at, T0 + 25000, 'the same data received again counts as confirmed now');
  MK.observe(c, obs('dex', T0 + 25000 + MK.JUP_PRIMARY_MS + 1000, 6e-6));
  assert.strictEqual(c.last.src, 'dex', 'after a minute without Jupiter, DexScreener is the fallback again');
  assert.strictEqual(MK.priceAt(c, T0 + 6500), 9e-6, 'price history uses only accepted observations');
});

test('engine 11.1 upgrade: 11.0 accounts are archived with their marks and restart with 10 SOL', () => {
  const { createEngine } = require('../v11/engine.js');
  const old = createEngine(); old.init(T0); const S0 = old.state();
  S0.v = '11.0'; S0.accts['A'].cash = 9.5; S0.accts['A'].trades.push({ net: -0.5 });
  S0.orders.x = { id: 'x', acct: 'A', status: 'requested', reqAt: T0 };
  const e = createEngine(); e.load(JSON.parse(JSON.stringify(S0)));
  const S = e.state();
  assert.strictEqual(S.v, '11.1');
  assert.strictEqual(S.accts.A.cash, 10, 'fresh start');
  const a = S.archive.find(x => x.acct === 'A');
  assert.ok(a && a.engine === '11.0' && a.net === -0.5 && a.trades === 1, 'old result archived');
  assert.strictEqual(S.orders.x.status, 'cancelled');
  assert.ok(e.drain().some(x => x.type === 'EngineUpgraded'));
});
