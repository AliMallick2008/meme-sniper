'use strict';
/* v11 Phase 3 (market intelligence): audit tests T05, T06, T16, plus Findings 07 (same dip, opposite demand), 08 (best
   candidate at a common decision time, not the first dip) and 15 (a dead coin cannot hold a strategy forever). */
const test = require('node:test');
const assert = require('node:assert');
const { World, SOLUSD, ST } = require('./v11_world.js');
const LEGACY = require('../sniper.js');

const path = pts => t => { if (t <= pts[0][0]) return pts[0][1]; for (let i = 1; i < pts.length; i++) if (t <= pts[i][0]) { const [a, x] = pts[i - 1], [b, y] = pts[i]; return x + (y - x) * (t - a) / (b - a); } return pts[pts.length - 1][1]; };
const strong = t => ({ bv: 3000, sv: 1000, nb: 60, ns: 20, nt: 40 + Math.floor((t % 100000) / 60), nnb: 25, hc: 6 });
const neutral = () => ({ bv: 1100, sv: 900, nb: 40, ns: 35, nt: 30, nnb: 3, hc: 0 });
function candles(price, from, to) {
  const out = [];
  for (let m = Math.floor(from / 60) * 60; m < to; m += 60) { const xs = []; for (let s = 0; s < 60; s++) xs.push(price(m + s) / 1e9); out.push([m, xs[0], Math.max(...xs), Math.min(...xs), xs[59], 100, 0]); }
  return out;
}
/* a young coin that ignites right after its $7K crossing (strategy A buys it ~20-30 s after its checks) */
function launch(w, T, after, stats) {
  const price = path([[T - 300, 3000], [T, 7100], [T + 60, 7600], [T + 120, 8100]].concat(after));
  const c = w.coin({ created: T - 300, price, stats });
  w.checks(c, T + 10, T + 12);
  return c;
}

test('T05: falling price, vanishing buyers and a failing trend: a thesis exit well before any 90% stop', () => {
  const w = new World({ strategies: [ST.V2('A')] });
  const T = w.t0 + 1000;
  const c = launch(w, T, [[T + 300, 8200], [T + 540, 5000], [T + 3000, 4800]],
    t => t < T + 300 ? strong(t) : { bv: 300, sv: 2500, nb: 10, ns: 70, nt: Math.max(12, 40 - Math.floor((t - T - 300) / 15)), nnb: -30, hc: -8 });
  w.run(T + 700);
  const A = w.acct('A'), tr = A.trades[0];
  assert.ok(tr, 'bought and sold');
  assert.strictEqual(tr.exitReason, 'thesis', `exit: ${tr.exitReason} ${tr.exitWhy}`);
  assert.match(tr.exitWhy, /thesis broken: .*off the 15-min high.*sellers/);
  const exitMc = c.price(tr.exitAt), entryMc = tr.mkt * SOLUSD * 1e9;
  assert.ok(exitMc > entryMc * 0.8, `left at $${exitMc.toFixed(0)} vs entry $${entryMc.toFixed(0)}: before the 25% protective level, far before -90%`);
  assert.ok(tr.states.some(s => s[1] === 'broken'), 'thesis went broken before the exit');
  assert.ok(tr.thesis && tr.thesis.invalidation.length && tr.thesis.why, 'entry thesis recorded');
});

test('T06: a healthy pullback with renewed buying is not sold just because the candle is red', () => {
  const w = new World({ strategies: [ST.V2('A')] });
  const T = w.t0 + 1000;
  launch(w, T, [[T + 240, 8700], [T + 270, 8000], [T + 330, 8700], [T + 500, 9300], [T + 3000, 9300]], strong);
  w.run(T + 500);
  const A = w.acct('A');
  assert.strictEqual(A.trades.length, 0, 'still holding');
  assert.ok(A.pos);
  assert.ok(!A.pos.states.some(s => s[1] === 'broken'), 'never judged broken: ' + JSON.stringify(A.pos.states));
  const obs = w.eng.state().coins[A.pos.m].obs.filter(o => o[0] > T + 240 && o[0] < T + 330);
  assert.ok(Math.min(...obs.map(o => o[1])) * 1e9 <= 8000 * 1.01, 'it really pulled back ~8%');
  assert.ok(w.eng.state().coins[A.pos.m].bars.some(b => b[4] < b[1]), 'with a red minute');
});

test('T16: a strong winner far above any fixed target: a trailing exit from marks seen so far, never later ones', () => {
  const run = afterPeak => {
    const w = new World({ strategies: [ST.V2('A')] });
    const T = w.t0 + 1000;
    launch(w, T, [[T + 540, 15000]].concat(afterPeak(T)), t => t < T + 540 ? strong(t) : neutral());
    return { w, T };
  };
  const { w, T } = run(T => [[T + 660, 12000], [T + 3000, 12000]]);
  w.run(T + 800);
  const tr = w.acct('A').trades[0];
  assert.ok(tr && tr.exitReason === 'trail', `exit ${tr && tr.exitReason}: ${tr && tr.exitWhy}`);
  assert.ok(tr.exitAt > T + 540, 'decided after the peak');
  assert.ok(tr.ret > 0.4, `kept ${(tr.ret * 100).toFixed(0)}% (a +1% target would have sold minutes into the run)`);
  assert.ok(tr.mfe > tr.ret, 'gave back part of the best mark, as a trailing exit must');
  // no hindsight: the same market up to the decision, then a moonshot instead: the same decision at the same time
  const t1 = tr.exitAt;
  const b = run(T => [[T + 660, 12000], [t1 + 1, 12000 + 0 * T], [t1 + 2, 30000], [T + 3000, 30000]].filter((x, i, a) => i === 0 || x[0] > a[i - 1][0]));
  // up to t1 both paths are identical (the second only diverges after it)
  for (let t = T; t <= t1; t += 7) assert.strictEqual(b.w.coins.values().next().value.price(t), w.coins.values().next().value.price(t));
  b.w.run(T + 800);
  const tr2 = b.w.acct('A').trades[0];
  assert.ok(tr2 && tr2.exitAt === t1 && tr2.exitReason === 'trail', 'identical decision without knowing what came next');
});

test('F07 + F08: same dip, opposite demand; the best confirmed setup at a common decision time, not the earliest dip', () => {
  const w = new World({ strategies: [ST.V2('B')] });
  const T = w.t0 + 1000;
  const mk = (pts, stats) => { const c = w.coin({ created: T - 600, price: path([[T - 600, 3000], [T, 7100]].concat(pts)), stats }); w.checks(c, T + 10, T + 12); return c; };
  const sellers = () => ({ bv: 600, sv: 1600, nb: 20, ns: 50, nt: 35, nnb: -10, hc: -2 });
  const late = (good) => t => t < T + 640 ? { bv: 1000, sv: 1000, nb: 30, ns: 30, nt: 30, nnb: 0, hc: 0 } : good;
  const W = mk([[T + 300, 14000], [T + 500, 8000], [T + 600, 9000], [T + 3000, 9100]], () => ({ bv: 950, sv: 1150, nb: 30, ns: 34, nt: 33, nnb: -2, hc: 0 }));
  const S = mk([[T + 300, 15000], [T + 600, 8500], [T + 720, 10600], [T + 3000, 11000]], late({ bv: 4000, sv: 1000, nb: 70, ns: 20, nt: 55, nnb: 30, hc: 8 }));
  const S2 = mk([[T + 300, 15000], [T + 600, 8500], [T + 720, 10200], [T + 3000, 10300]], late({ bv: 1500, sv: 1000, nb: 40, ns: 30, nt: 40, nnb: 6, hc: 2 }));
  const Q = mk([[T + 300, 15000], [T + 600, 8500], [T + 720, 10600], [T + 3000, 11000]], sellers);
  w.run(T + 760);
  const A = w.acct('B'), pos = A.pos || A.trades[0];
  assert.ok(pos, 'B bought something');
  assert.strictEqual(pos.m, S.m, 'the strongest confirmed setup');
  const alt = Object.fromEntries(pos.thesis.alternatives);
  assert.match(alt[S2.sym], /ranked lower/, 'S2 qualified at the same moment and was compared');
  assert.match(alt[Q.sym], /selling not absorbed/, 'same price path as S, sellers in control: refused');
  assert.match(alt[W.sym], /selling not absorbed|not recovering|no reclaim/, 'the earlier dip, without demand: refused');
  // the legacy rule (first 40% dip wins) would have bought W, whose dip came first
  const old = [W, S].map(c => ({ c, e: LEGACY.findEntry(candles(c.price, T - 600, T + 760), () => SOLUSD, T + 12, T + 760, LEGACY.RULES.BASE) }));
  const first = old.filter(x => x.e.pos).sort((a, b) => a.e.pos.entryT - b.e.pos.entryT)[0];
  assert.strictEqual(first.c, W, 'legacy: earliest dip');
});

test('F15: a stagnant coin cannot hold a strategy forever: the horizon ends it', () => {
  const w = new World({ strategies: [ST.V2('A')] });
  const T = w.t0 + 1000;
  launch(w, T, [[T + 180, 8200], [T + 4000, 8250]], t => t < T + 120 ? strong(t) : { bv: 1100, sv: 900, nb: 35, ns: 30, nt: 30, nnb: 2, hc: 0 });
  w.run(T + 1500);
  const tr = w.acct('A').trades[0];
  assert.ok(tr && tr.exitReason === 'time', `exit ${tr && tr.exitReason}`);
  assert.ok(Math.abs(tr.exitAt - (tr.fillAt + 1200)) < 3, 'at its 20 min horizon');
});
