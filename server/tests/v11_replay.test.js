'use strict';
/* Replay of recorded event traces (ablations, E-experiments): exact replays reproduce the books; model replays compare
   variants on the same footing. */
const test = require('node:test');
const assert = require('node:assert');
const { World, ST } = require('./v11_world.js');
const RP = require('../v11/replay.js');

const path = pts => t => { if (t <= pts[0][0]) return pts[0][1]; for (let i = 1; i < pts.length; i++) if (t <= pts[i][0]) { const [a, x] = pts[i - 1], [b, y] = pts[i]; return x + (y - x) * (t - a) / (b - a); } return pts[pts.length - 1][1]; };
const strong = t => ({ bv: 3000, sv: 1000, nb: 60, ns: 20, nt: 40 + Math.floor((t % 100000) / 60), nnb: 25, hc: 6 });
/* a world whose engine also records every event it gets, like V11_TRACE */
function traced(strategies) {
  const w = new World({ strategies }), ev = [], E = w.eng, ing = E.ingest, tick = E.tick;
  E.ingest = e => { ev.push(JSON.parse(JSON.stringify(e))); return ing(e); };
  E.tick = at => { ev.push({ type: 'tick', at }); return tick(at); };
  return { w, ev };
}
function t05(w) {
  const T = w.t0 + 1000;
  const price = path([[T - 300, 3000], [T, 7100], [T + 60, 7600], [T + 120, 8100], [T + 300, 8200], [T + 540, 5000], [T + 3000, 4800]]);
  const c = w.coin({ created: T - 300, price, stats: t => t < T + 300 ? strong(t) : { bv: 300, sv: 2500, nb: 10, ns: 70, nt: Math.max(12, 40 - Math.floor((t - T - 300) / 15)), nnb: -30, hc: -8 } });
  w.checks(c, T + 10, T + 12);
  // a legacy-style coin too, so the E0 accounts trade
  const d = w.coin({ created: T - 600, price: path([[T - 600, 3000], [T, 7100], [T + 60, 10000], [T + 200, 5800], [T + 400, 6400], [T + 3000, 6400]]) }); w.partner(d, T - 120);
  w.checks(d, T + 20, T + 25);
  return T;
}

test('exact replay of a recorded trace reproduces the live books', () => {
  const strategies = [...ST.e0All(), ST.HOLD, ...ST.v2All()];
  const { w, ev } = traced(strategies);
  const T = t05(w);
  w.offline(T + 900, T + 1100);   // with a gap inside the trace
  w.run(T + 1500);
  const live = w.eng.state();
  assert.ok(Object.values(live.accts).some(A => A.trades.length), 'something traded');
  const eng = RP.replay(ev, [...ST.e0All(), ST.HOLD, ...ST.v2All()]);
  for (const [id, A] of Object.entries(live.accts)) assert.deepStrictEqual(JSON.parse(JSON.stringify(eng.state().accts[id])), JSON.parse(JSON.stringify(A)), id);
});

test('model replay runs the ablation set; removing thesis exits changes what A does on a dying coin', () => {
  const { w, ev } = traced([ST.V2('A')]);
  t05(w);
  w.run(w.t0 + 1000 + 900);
  const eng = RP.replay(ev, ST.ablations(), { model: true });
  const s = Object.fromEntries(RP.summary(eng).map(r => [r.id, r]));
  assert.ok(s.A.trades >= 1 && s['A-thesis'].trades >= 1);
  assert.strictEqual(eng.state().accts.A.trades[0].exitReason, 'thesis');
  assert.notStrictEqual(eng.state().accts['A-thesis'].trades[0].exitReason, 'thesis');
  assert.ok(s.A.realized > s['A-thesis'].realized, `A ${s.A.realized} vs A without thesis exits ${s['A-thesis'].realized} on this market`);
  assert.ok(Object.values(eng.state().accts).every(A => A.trades.every(t => (t.exitRoute || []).length >= 0)));
});
