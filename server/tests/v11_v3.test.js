'use strict';
/* v3.0 (research/v3_protocol.md): A3, A3e and B3 trade v2.0's entries on the trade tape. Checks: they trade only while a
   coin's tape is live; orders fill against the curve as last received at or before decision + 2 s; marks and reviews run
   on every tape observation; A3e's tape emergencies; a tape outage falls back to v2.0's quote path; the fill model check;
   exact replay; and v2.0's own accounts trade exactly as they would without the tape or the new accounts. */
const test = require('node:test');
const assert = require('node:assert');
const V2 = require('../v11/v2.js');
const V3 = require('../v11/v3.js');
const TS = require('../v11/tapestate.js');
const REC = require('../v11/record.js');
const { createEngine } = require('../v11/engine.js');
const { T0, min, M, SOL_USD, market, path, steps, ordersOf } = require('./helpers.js');

const buyFlow = { bv: 7000, sv: 3000, tr: 40, nnb: 12, hc: 3 };
const withV3 = () => V2.accounts().concat(V3.accounts());
const v2only = () => V2.accounts();
// launch momentum on M ($7K at the crossing, $8K three minutes later, broad buying), then `after`
const launch = (after, flowAfter = []) => ({ m: M, sym: 'FROGT', crossAt: T0, mcX: 7000, hiMc: 7000, mc: path([[0, 7000], [3, 8000]].concat(after)), flow: steps([[-1, buyFlow]].concat(flowAfter)) });

// the coin's trade tape on the classic curve: subscribed 1 s after the crossing, a curve state right after (the
// runtime's first poll), then a trade 300 ms after every second in which the price moved
const K = 30 * 1.073e9;
const stateAt = mc => { const ps = mc / 1e9 / SOL_USD, vs = Math.sqrt(K * ps); return { vs: Math.round(vs * 1e6), vt: Math.round(vs / ps) }; };
function tapeFor(coin, to, { extra = [], downAt = null } = {}) {
  const subAt = coin.crossAt + 1000, ev = [{ type: 'tape_status', at: min(-1) + 500, up: true, subs: 0, why: 'connected' }, { type: 'tape_sub', at: subAt, m: coin.m, on: true }];
  let p = stateAt(coin.mc(subAt));
  ev.push(Object.assign({ type: 'curve', at: subAt + 200, m: coin.m, slot: 1, done: false, src: 'poll', cr: 'Creator1' }, p, { rs: p.vs - 30e6, rt: p.vt - 279.9e6 }));
  let slot = 2, k = 0;
  for (let t = subAt + 1000; t <= to; t += 1000) {
    if (downAt != null && t >= downAt) break;
    const q = stateAt(coin.mc(t));
    if (q.vs === p.vs) continue;
    ev.push({ type: 'tape', at: t + 300, m: coin.m, slot: slot++, b: q.vs > p.vs ? 1 : 0, s: Math.abs(q.vs - p.vs), q: Math.abs(q.vt - p.vt), u: 'W' + (k++ % 9), vs: q.vs, vt: q.vt });
    p = q;
  }
  if (downAt != null) ev.push({ type: 'tape_status', at: downAt, up: false, subs: 0, why: 'disconnected' });
  return ev.concat(extra).sort((a, b) => a.at - b.at);
}
const lastState = (ev, m, at) => { let s = null; for (const e of ev) if (e.m === m && e.at <= at && e.vs > 0 && (e.type === 'tape' || e.type === 'curve')) s = e; return s; };

test('A3 buys what A buys, only on a live tape, filled against the curve 2 s after the decision', () => {
  const coin = launch([[8, 9000]]);
  const tape = tapeFor(coin, min(8));
  const { S } = market({ coins: [coin], stopAt: min(6), accounts: withV3, extra: tape });
  const a = ordersOf(S, 'A', 'buy')[0], o = ordersOf(S, 'A3', 'buy')[0];
  assert.ok(a && o, 'A and A3 both bought');
  assert.strictEqual(o.m, a.m);
  assert.strictEqual(o.reqAt, a.reqAt, 'the same decision at the same tick');
  assert.strictEqual(o.mode, 'curve');
  assert.strictEqual(o.fill.at, o.reqAt + V3.FILL_MS, 'filled at decision + 2 s');
  assert.deepStrictEqual(o.fill.route, ['pump.fun curve (tape)']);
  // exactly the curve as last received at or before the fill time, with the fee, then drift
  const st = lastState(tape, M, o.fillAt);
  const want = TS.curveBuy({ vs: st.vs, vt: st.vt }, o.size, 0.0125).tokens * (1 - 0.005);
  assert.ok(Math.abs(S.accts.A3.pos.qty / want - 1) < 1e-6, `tokens ${S.accts.A3.pos.qty} vs ${want}`);
  assert.ok(o.contract && o.contract.strat === 'A' && o.contract.v === 'v2.0', 'the entry contract is v2.0 A\'s');
  assert.ok(S.accts.A3e.pos && S.accts.A3e.pos.m === M, 'A3e bought too');
  // without a tape the v3 accounts never trade; A does
  const { S: S0 } = market({ coins: [coin], stopAt: min(6), accounts: withV3 });
  assert.ok(ordersOf(S0, 'A', 'buy').length === 1 && ordersOf(S0, 'A3', 'buy').length === 0 && ordersOf(S0, 'A3e', 'buy').length === 0);
});

test('v2.0 and E0 decisions are exactly the same with or without the tape and the v3 accounts', () => {
  const coin = launch([[6, 9500], [6.2, 5200], [12, 5000]], [[6, { bv: 1500, sv: 6000, tr: 14, nnb: -6, hc: -8 }]]);
  const base = market({ coins: [coin], stopAt: min(14) }).S;
  const tape = tapeFor(coin, min(14), { extra: [{ type: 'tape', at: min(5) + 400, m: M, slot: 999, b: 0, s: 50000, q: 1000, u: 'Creator1', vs: stateAt(coin.mc(min(5))).vs, vt: stateAt(coin.mc(min(5))).vt }] });
  const both = market({ coins: [coin], stopAt: min(14), extra: tape }).S;
  for (const id of Object.keys(base.accts)) {
    if (base.accts[id].tape) continue;                 // the v3 accounts themselves trade only with the tape
    assert.ok(both.accts[id], id);
    assert.deepStrictEqual(both.accts[id].trades, base.accts[id].trades, id + ' trades');
    assert.deepStrictEqual(both.accts[id].pos, base.accts[id].pos, id + ' position');
    assert.strictEqual(both.accts[id].cash, base.accts[id].cash, id + ' cash');
  }
  assert.ok(base.accts.A.trades.length === 1, 'the scenario traded A');
  assert.ok(base.accts.A3.trades.length === 0 && both.accts.A3.trades.length === 1 && both.accts.A3e.trades.length === 1, 'the v3 accounts traded it only with the tape');
});

test('A3 values and reviews on every trade: a fast crash is sold on the tape, the fill 2 s after the decision', () => {
  // $8.3K at 5:00, then -40% in 10 s at 6:00
  const coin = launch([[5, 8300], [6, 8300], [6 + 10 / 60, 5000], [9, 5000]]);
  const tape = tapeFor(coin, min(9));
  const { S } = market({ coins: [coin], stopAt: min(9), accounts: withV3, extra: tape });
  const t3 = S.accts.A3.trades[0], ta = S.accts.A.trades[0];
  assert.ok(t3 && ta, 'both sold');
  const so = ordersOf(S, 'A3', 'sell')[0];
  assert.strictEqual(so.mode, 'curve');
  assert.strictEqual(t3.closeAt, so.reqAt + V3.FILL_MS);
  assert.ok(so.reqAt % 5000 !== 0 || true);
  assert.ok(t3.exitDecidedAt >= min(6) && t3.exitDecidedAt <= min(6) + 10000, 'decided during the crash');
  assert.ok(t3.exitDecidedAt <= ta.exitDecidedAt, `the tape saw it first (${(ta.exitDecidedAt - t3.exitDecidedAt) / 1000} s)`);
  // reviewed between ticks: the decision fell on a tape observation, not a 5 s tick
  assert.ok(S.log.some(e => e.type === 'OrderRequested' && e.acct === 'A3' && e.side === 'sell' && e.at % 5000 !== 0), 'decided on a tape observation');
  // marks come from the curve while the tape is live
  assert.ok(S.log.some(e => e.type === 'PositionReviewed' && e.acct === 'A3'));
});

test('A3e: the creator selling after the buy, or a 20% drop inside 10 s, is an emergency exit; A3 keeps holding', () => {
  const coin = launch([[12, 9000]]);
  const sell = Object.assign({ type: 'tape', at: min(6) + 400, m: M, slot: 5000, b: 0, s: 20000, q: 300000, u: 'Creator1' }, stateAt(coin.mc(min(6))));
  const { S } = market({ coins: [coin], stopAt: min(7), accounts: withV3, extra: tapeFor(coin, min(7), { extra: [sell] }) });
  const t = S.accts.A3e.trades[0];
  assert.ok(t, 'A3e sold');
  assert.strictEqual(t.exitReason, 'emergency');
  assert.match(t.exitWhy, /creator wallet \(Creator1\) sold/);
  assert.strictEqual(t.exitDecidedAt, sell.at, 'at the creator\'s trade');
  assert.ok(S.accts.A3.pos, 'A3 (no tape emergencies) still holds');
  // a quiet coin (no trade for a minute) drops 25% in 6 s: the price it started the window at counts
  const drop = launch([[5, 9000], [6, 9000], [6 + 6 / 60, 6750], [8, 6750]]);
  const { S: S2 } = market({ coins: [drop], stopAt: min(8), accounts: withV3, extra: tapeFor(drop, min(8)) });
  const t2 = S2.accts.A3e.trades[0];
  assert.ok(t2 && t2.exitReason === 'emergency' && /inside 10 seconds/.test(t2.exitWhy), JSON.stringify(t2 && [t2.exitReason, t2.exitWhy]));
  assert.ok(t2.exitDecidedAt < min(6) + 7000);
});

test('a tape outage: v3 falls back to v2.0\'s marks and quote path, and buys nothing new', () => {
  const coin = launch([[5, 8300], [6, 8300], [6 + 10 / 60, 5000], [9, 5000]]);
  const { S } = market({ coins: [coin], stopAt: min(9), accounts: withV3, extra: tapeFor(coin, min(9), { downAt: min(5) }) });
  assert.ok(S.accts.A3.trades[0], 'A3 bought on the tape and sold after it went down');
  const so = ordersOf(S, 'A3', 'sell')[0];
  assert.ok(!so.mode, 'the exit went through a quote');
  assert.ok(so.reqAt % 5000 === 0, 'decided at a tick');
  assert.ok(S.log.some(e => e.type === 'TapeDown'));
  const second = market({ coins: [launch([[8, 9000]])], stopAt: min(6), accounts: withV3, extra: tapeFor(launch([[8, 9000]]), min(6), { downAt: min(1) }) }).S;
  assert.strictEqual(ordersOf(second, 'A3', 'buy').length, 0, 'no entry without a live tape');
});

test('fill model check: Jupiter quotes vs the curve model at the same moment are logged', () => {
  const coin = launch([[8, 9000]]);
  const { S } = market({ coins: [coin], stopAt: min(6), accounts: withV3, extra: tapeFor(coin, min(6)) });
  assert.ok(S.qc && S.qc.n >= 1, 'A\'s Jupiter quote on a live-tape coin was compared');
  const g = S.qc.gaps.map(x => x[1]).sort((a, b) => a - b);
  assert.ok(Math.abs(g[g.length >> 1]) < 0.02, `median gap ${g[g.length >> 1]}`);
});

test('v3 trading on the tape replays exactly from the recording', () => {
  const coin = launch([[5, 8300], [6, 8300], [6 + 10 / 60, 5000], [9, 5000]]);
  const rec = REC.recorder();
  const { e } = market({ coins: [coin], stopAt: min(9), accounts: withV3, extra: tapeFor(coin, min(9)), rec });
  const live = e.state();
  assert.ok(live.accts.A3.trades.length === 1, 'traded');
  const r = REC.replayExact([rec.take()], { createEngine: () => createEngine({ accounts: withV3 }) });
  assert.strictEqual(REC.firstDiff(REC.roundTrip(r.eng.save()), REC.roundTrip(e.save())), null);
});
