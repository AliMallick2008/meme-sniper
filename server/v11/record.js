'use strict';
/* v11 input recording and exact replay.

   Everything the runtime feeds the engine (crossings, checks, price and flow snapshots, quotes, SOL prices, run starts),
   every decision tick, every state save and every load is written, in the order it happened, as gzipped JSON lines
   (`v11-inputs/` on the research branch). Replaying those lines through a fresh engine rebuilds the live state exactly
   (checked by the server sim). Replaying them with other strategy settings is the ablation tool: same inputs, different
   logic, and orders the live run never made fill from the model (labeled as such).

   Line formats (one JSON array per line; NaN and Infinity are written as "~NaN", "~Inf", "~-Inf"):
     ['M', i, mint]        dictionary: mint number i in this file
     ['K', k, [paths]]     dictionary: object shape k = these key paths ('liq/usd' is liq.usd), in order
     ['t', at]             decision tick at `at`
     ['s', at, n]          state save n taken (the runtime trims it with trimSave)
     ['S', at, n, ok]      save n reached the data branch (ok) or failed
     ['L', at, state]      a run loaded this state (null: fresh start)
     ['e', event]          crossing, audit, rugcheck, sol, quote or run_start event, as ingested
     ['d'|'j', i, k, vals] DexScreener / Jupiter snapshot of mint i (without m, id, type) as the values of shape k
     ['=', i, src, at]     the previous snapshot from src for mint i, unchanged, received again at `at` */
const zlib = require('zlib');

const NUM = (k, v) => typeof v === 'number' && !isFinite(v) ? (Number.isNaN(v) ? '~NaN' : v > 0 ? '~Inf' : '~-Inf') : v;
const REV = (k, v) => v === '~NaN' ? NaN : v === '~Inf' ? Infinity : v === '~-Inf' ? -Infinity : v;
const enc = x => JSON.stringify(x, NUM);
const dec = s => JSON.parse(s, REV);

// ------------------------------------------------------------------------------------------------ saved-state trimming
// the copy of the engine state saved on the data branch: recent snapshots, the last 20 one-minute bars (features look
// back 15 minutes; the high and the low since it are tracked separately), the last 200 log events
const r6 = v => typeof v === 'number' ? +v.toPrecision(6) : v;
function trimSave(s) {
  for (const c of Object.values(s.coins)) {
    // the last two price snapshots and the last three Jupiter flow snapshots (features compare against them)
    const jup = c.snaps.filter(x => x.src === 'jup').slice(-3), other = c.snaps.filter(x => x.src !== 'jup').slice(-2);
    c.snaps = c.snaps.filter(x => jup.includes(x) || other.includes(x)).map(x => Object.assign({}, x, { audit: undefined, st1h: undefined }));
    c.bars = c.bars.slice(-20).map(b => [b.t, r6(b.o), r6(b.h), r6(b.l), r6(b.c), b.n]);
  }
  for (const A of Object.values(s.accts)) for (const k of Object.keys(A.seen)) A.seen[k] = { at: A.seen[k].at, pass: A.seen[k].pass };
  s.log = s.log.slice(-200);
  return s;
}
function unpack(saved) {
  for (const c of Object.values(saved.coins || {})) c.bars = (c.bars || []).map(b => Array.isArray(b) ? { t: b[0], o: b[1], h: b[2], l: b[3], c: b[4], n: b[5] } : b);
  return saved;
}
// what a save looks like after the trip through the data branch (JSON: NaN becomes null)
const roundTrip = s => JSON.parse(JSON.stringify(s));

// ------------------------------------------------------------------------------------------------ recorder
// an object as key paths and leaf values (non-empty plain objects are walked; arrays, null and {} are leaves)
function flat(obj, pre, keys, vals) {
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (v === undefined) continue;
    if (v !== null && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length) flat(v, pre + k + '/', keys, vals);
    else { keys.push(pre + k); vals.push(v); }
  }
  return { keys, vals };
}
function unflat(keys, vals) {
  const o = {};
  keys.forEach((k, i) => { const ps = k.split('/'); let x = o; for (let j = 0; j < ps.length - 1; j++) x = x[ps[j]] || (x[ps[j]] = {}); x[ps[ps.length - 1]] = vals[i]; });
  return o;
}
function recorder() {
  let lines = [], mints = new Map(), shapes = new Map(), prev = new Map(), bytes = 0;
  const push = x => { const l = enc(x); lines.push(l); bytes += l.length + 1; };
  function mi(m) { let i = mints.get(m); if (i == null) { i = mints.size; mints.set(m, i); push(['M', i, m]); } return i; }
  function shape(keys) { const key = keys.join(','); let k = shapes.get(key); if (k == null) { k = shapes.size; shapes.set(key, k); push(['K', k, keys]); } return k; }
  function event(ev) {
    if (ev.type !== 'snapshot') { push(['e', ev]); return; }
    const src = ev.src === 'jup' ? 'j' : 'd', i = mi(ev.m), key = i + src, p = prev.get(key);
    const body = Object.assign({}, ev); delete body.m; delete body.id; delete body.type;
    const audit = body.audit ? enc(body.audit) : null;
    if (src === 'j' && p && audit && audit === p.audit) body.audit = '=';
    const { keys, vals } = flat(body, '', [], []);
    const k = shape(keys);
    const sig = k + enc(vals.map((v, n) => keys[n] === 'at' ? 0 : v));
    if (p && p.sig === sig) { push(['=', i, src, ev.at]); return; }
    prev.set(key, { sig, audit: audit || (p && body.audit === '=' ? p.audit : null) });
    push([src, i, k, vals]);
  }
  return {
    event,
    tick: at => push(['t', at]),
    save: (at, n) => push(['s', at, n]),
    committed: (at, n, ok) => push(['S', at, n, ok]),
    load: (at, state) => push(['L', at, state || null]),
    size: () => ({ lines: lines.length, bytes }),
    // hand over the buffered lines as one self-contained file (the dictionaries start again)
    take() { const out = lines; lines = []; mints = new Map(); shapes = new Map(); prev = new Map(); bytes = 0; return out; },
    // put lines back after a failed upload: they are complete on their own, so they simply go first
    putBack(old) { lines = old.concat(lines); bytes += old.reduce((s, l) => s + l.length + 1, 0); },
  };
}

// ------------------------------------------------------------------------------------------------ decoding
// files: gzip buffers (or arrays of line strings) in time order. Yields decoded items:
//   { k: 'tick', at } | { k: 'save', at, n } | { k: 'commit', at, n, ok } | { k: 'load', at, state } | { k: 'event', ev }
function* decode(files) {
  const mints = [], shapes = [], prev = new Map();
  for (const f of files) {
    const ls = Array.isArray(f) ? f : zlib.gunzipSync(f).toString().split('\n');
    for (const l of ls) {
      if (!l) continue;
      const x = dec(l);
      switch (x[0]) {
        case 'M': mints[x[1]] = x[2]; break;
        case 'K': shapes[x[1]] = x[2]; break;
        case 't': yield { k: 'tick', at: x[1] }; break;
        case 's': yield { k: 'save', at: x[1], n: x[2] }; break;
        case 'S': yield { k: 'commit', at: x[1], n: x[2], ok: x[3] }; break;
        case 'L': yield { k: 'load', at: x[1], state: x[2] }; break;
        case 'e': yield { k: 'event', ev: x[1] }; break;
        case 'd': case 'j': {
          const m = mints[x[1]], key = x[1] + x[0], p = prev.get(key);
          if (!m || !shapes[x[2]]) break;                       // a damaged file: the replay check will show the gap
          const ev = Object.assign({ m }, unflat(shapes[x[2]], x[3]));
          if (ev.audit === '=') ev.audit = p && p.ev.audit ? JSON.parse(JSON.stringify(p.ev.audit)) : null;
          prev.set(key, { m, ev: JSON.parse(enc(ev), REV) });
          yield { k: 'event', ev: Object.assign(ev, { id: `${x[0]}:${m}:${ev.at}`, type: 'snapshot' }) };
          break;
        }
        case '=': {
          const key = x[1] + x[2], p = prev.get(key);
          if (!p) break;
          const ev = JSON.parse(enc(p.ev), REV);
          ev.at = x[3];
          yield { k: 'event', ev: Object.assign(ev, { id: `${x[2]}:${p.m}:${x[3]}`, type: 'snapshot' }) };
          break;
        }
        default: break;
      }
    }
  }
}

/* Exact replay of recorded runs with the live code. The first load starts the engine from the recorded state; each later
   load (a new server run) restarts it from the last save that reached the data branch, trimmed exactly as the runtime
   trims it, and checks that this equals the state the live run loaded. Returns the engine and the checks. */
function replayExact(files, { createEngine, onTick } = {}) {
  createEngine = createEngine || require('./engine.js').createEngine;
  let eng = null, snaps = new Map(), committed = null, loads = 0, ticks = 0, events = 0;
  const checks = [];
  for (const it of decode(files)) {
    if (it.k === 'load') {
      loads++;
      if (!eng) {
        eng = createEngine();
        if (it.state && it.state.v && it.state.accts) eng.load(unpack(roundTrip(it.state)));
        else eng.init(it.at);
      } else {
        const want = it.state ? roundTrip(it.state) : null;
        const got = committed ? roundTrip(committed) : null;
        checks.push({ at: it.at, same: sameJSON(got, want), detail: got && want ? firstDiff(got, want) : (got ? 'live run loaded nothing' : 'no committed save') });
        eng = createEngine();
        if (got && got.v && got.accts) eng.load(unpack(got)); else eng.init(it.at);
      }
      continue;
    }
    if (!eng) continue;   // lines before the first load cannot be replayed exactly
    if (it.k === 'event') { events++; try { eng.ingest(it.ev); } catch (e) { /* the runtime notes and continues */ } }
    else if (it.k === 'tick') { ticks++; try { eng.tick(it.at); } catch (e) { /* the runtime notes and continues */ } eng.drain(); if (onTick) onTick(eng, it.at); }
    else if (it.k === 'save') snaps.set(it.n, roundTrip(trimSave(eng.save())));
    else if (it.k === 'commit') { if (it.ok && snaps.has(it.n)) committed = snaps.get(it.n); snaps.delete(it.n); }
  }
  return { eng, checks, loads, ticks, events, lastSave: committed };
}
function sameJSON(a, b) { return firstDiff(a, b) === null; }
// path of the first difference between two JSON values (key order ignored), or null
function firstDiff(a, b, path = '') {
  if (a === b) return null;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') {
    if (typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b)) return null;
    return `${path || '.'}: ${JSON.stringify(a)?.slice(0, 80)} vs ${JSON.stringify(b)?.slice(0, 80)}`;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return `${path}: array vs object`;
  const ks = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of ks) {
    if (a[k] === undefined && b[k] === undefined) continue;
    const d = firstDiff(a[k], b[k], `${path}.${k}`); if (d) return d;
  }
  return null;
}
module.exports = { recorder, decode, replayExact, trimSave, unpack, roundTrip, firstDiff, enc, dec };
