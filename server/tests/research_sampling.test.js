'use strict';
/* The legacy research recorder samples without looking at outcomes (protocol Amendment 5), and the ablation tool's
   day-level statistics behave. */
const test = require('node:test');
const assert = require('node:assert');
const R = require('../research.js');
const AB = require('../tools/v11_ablation.js');

test('research sampling: every coin that passed a check, 1 in 24 of the rest, decided by the mint alone', () => {
  const mints = Array.from({ length: 4800 }, (_, i) => 'Mint' + i.toString(36).padStart(8, '0') + 'pump');
  const failed = mints.map(m => ({ m, ok: { U: false, STR: false } }));
  const kept = failed.filter(R.sampled).length;
  assert.ok(kept > 4800 / 24 * 0.75 && kept < 4800 / 24 * 1.25, `about 1 in 24 kept: ${kept}`);
  assert.ok(mints.every(m => R.sampled({ m, ok: { U: true, STR: false } })), 'a coin that passed any bot is always kept');
  // the same coin gets the same answer whatever happened to it later
  for (const k of failed.slice(0, 200)) assert.strictEqual(R.sampled(Object.assign({}, k, { status: 'fail', score: 99 })), R.sampled(k));
});

test('ablation statistics: daily P&L by Toronto day with empty days counted, bootstrap interval brackets the mean', () => {
  const day = Date.UTC(2026, 9, 21, 16, 0, 0);
  const trades = [{ closeAt: day, net: 0.3 }, { closeAt: day + 3600e3, net: -0.1 }, { closeAt: day + 2 * 86400e3, net: 0.2 }];
  const d = AB.daily(trades, day - 3600e3, day + 3 * 86400e3);
  assert.deepStrictEqual(d.map(x => x[0]), ['2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24']);
  assert.ok(Math.abs(d[0][1] - 0.2) < 1e-12 && d[1][1] === 0 && Math.abs(d[2][1] - 0.2) < 1e-12, 'a day without trades counts as 0');
  const ci = AB.bootstrap(d.map(x => x[1]));
  const mean = d.reduce((s, x) => s + x[1], 0) / d.length;
  assert.ok(ci.lo <= mean && mean <= ci.hi, `${ci.lo} <= ${mean} <= ${ci.hi}`);
  assert.strictEqual(AB.bootstrap([0.1]), null, 'one day is too few for an interval');
});
