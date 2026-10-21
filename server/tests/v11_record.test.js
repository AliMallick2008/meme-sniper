'use strict';
/* The v11 input recording replays exactly: same inputs, same ticks, same saves -> the same engine state, across a restart
   that reloads a trimmed save (as the server does between GitHub Actions runs). */
const test = require('node:test');
const assert = require('node:assert');
const REC = require('../v11/record.js');
const { createEngine } = require('../v11/engine.js');
const { T0, min, SOL_USD, M, M2, BC, stdQuote } = require('./helpers.js');

function liveRun() {
  // a miniature runtime: everything the engine gets is recorded first, exactly as runtime.js does
  const rec = REC.recorder();
  let eng = createEngine(), saveN = 0, committed = null;
  const ingest = ev => { rec.event(ev); try { eng.ingest(ev); } catch (e) { /* noted */ } };
  const files = [];
  const price = t => t < min(6.5) ? 0.8e-5 : t < min(9) ? 0.56e-5 : t < min(30) ? 0.7e-5 : 0.66e-5;
  function load(at, saved) {
    rec.load(at, saved);
    eng = createEngine();
    if (saved) eng.load(REC.unpack(JSON.parse(JSON.stringify(saved)))); else eng.init(at);
    ingest({ type: 'run_start', at, run: 'r' + at });
  }
  function save(at, ok) { const s = REC.trimSave(eng.save()); rec.save(at, ++saveN); rec.committed(at + 500, saveN, ok); if (ok) committed = JSON.parse(JSON.stringify(s)); }
  load(min(-20), null);
  ingest({ id: 'x2', type: 'crossing', at: min(-10), m: M2, sym: 'FROGO', name: 'Frog Other', mcX: 7000, bc: BC });
  ingest({ id: 'x1', type: 'crossing', at: T0, m: M, sym: 'FROGT', name: 'Frog Test', mcX: 7000, hiMc: 1e4, bc: BC });
  const pending = [];
  let stopAt = min(20);
  const step = (from, to) => {
    for (let t = from; t <= to; t += 1000) {
      if (t === min(5)) {
        ingest({ id: 'a1', type: 'audit', at: t, reqAt: T0 + 1000, m: M, valid: true, fields: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true, devBalancePercentage: 1, topHoldersPercentage: 10, holders: 120, socials: { tw: true }, devMints: 1 } });
        ingest({ id: 'lw1', type: 'legacy_watch', at: t, m: M, bots: ['U', 'U2', 'U30', 'T25', 'D55', 'GRN', 'STR'], dropped: [] });
        ingest({ id: 'r1', type: 'rugcheck', at: t, reqAt: T0 + 2000, m: M, valid: true, risks: [], sn: 1 });
      }
      for (const q of pending.filter(q => q.at <= t)) { pending.splice(pending.indexOf(q), 1); ingest(q.ev); }
      if ((t - T0) % 5000 === 0) {
        const p = price(t);
        // the same DexScreener answer twice in a row is recorded as a repeat
        ingest({ id: `d:${M}:${t}`, type: 'snapshot', m: M, at: t, src: 'dex', valid: true, p, ps: p / SOL_USD, mc: p * 1e9, venue: 'curve', pool: null, liq: null, dx: { b5: NaN, s5: 3, v5: 100, v1h: NaN } });
        if ((t - T0) % 20000 === 0) ingest({ id: `j:${M}:${t}`, type: 'snapshot', m: M, at: t, src: 'jup', valid: true, p, ps: p / SOL_USD, mc: p * 1e9, liqUsd: 9000, holders: 120,
          st: { bv: 500 + (t % 7), sv: NaN, tr: 30 }, st1h: { bv: 9000 }, audit: { mintAuthorityDisabled: true, topHoldersPercentage: 10 + (t > min(15) ? 1 : 0) } });
        if ((t - T0) % 30000 === 0) ingest({ type: 'sol', at: t, usd: SOL_USD + (t % 3) });
        rec.tick(t);
        for (const r of eng.tick(t)) pending.push({ at: t + 1000, ev: stdQuote(r, t + 1000, price(t + 1000)) });
        eng.drain();
      }
      if (t === min(12)) save(t, true);
      if (t === min(14)) save(t, false);     // a save that never reached the data branch
    }
  };
  step(T0, stopAt);
  files.push(rec.take());                // an hourly file boundary: dictionaries restart
  // the run ends; the next run loads the last committed save (min 12), not the failed one
  load(min(22), committed);
  step(min(22), min(40));
  save(min(40), true);
  files.push(rec.take());
  return { files, eng, committed };
}

test('recorded v11 inputs replay to the same state, across a restart from a trimmed save', () => {
  const live = liveRun();
  const lines = live.files.reduce((n, f) => n + f.length, 0);
  assert.ok(live.files[0].some(l => l.startsWith('["="')), 'unchanged snapshots are recorded as repeats');
  assert.ok(live.files[0].some(l => l.startsWith('["j"') && l.includes('"="')), 'an unchanged audit is not written again');
  assert.ok(live.files[0].some(l => l.startsWith('["K"')), 'object shapes are written once per file');
  assert.ok(live.files.join('\n').includes('~NaN'), 'unknown values (NaN) survive the recording');
  const r = REC.replayExact(live.files);
  assert.strictEqual(r.loads, 2);
  assert.strictEqual(r.checks.length, 1);
  assert.ok(r.checks[0].same, 'the second run loaded what the replay rebuilt: ' + r.checks[0].detail);
  const d = REC.firstDiff(REC.roundTrip(r.lastSave), live.committed);
  assert.strictEqual(d, null, 'final save matches: ' + d);
  const A = live.eng.state().accts['E0-U'];
  assert.ok(A.trades.length + (A.pos ? 1 : 0) >= 1, `the scenario traded (${lines} lines recorded)`);
  // a lost file is detected rather than silently replayed
  const broken = [live.files[0].filter((l, i) => i % 50 !== 7), live.files[1]];
  const rb = REC.replayExact(broken);
  assert.ok(!rb.checks[0].same || REC.firstDiff(REC.roundTrip(rb.lastSave), live.committed) !== null, 'missing input lines show up as a mismatch');
});
