'use strict';
/* Scripted v11 inputs for the Python E0 re-check (v11_e0_ref.py): the paths the busy simulator never reaches.
   A miniature runtime drives the live engine exactly as server/v11/runtime.js does (every input recorded first, ticks,
   saves, restarts from the last committed save) through a hand-made market of "Frog" coins:
     failed buys (no route, transport error, invalid answer, no answer at all, price moved, coin graduating), a fill
     that lands after the 30 s limit with no tick in between, an answer older than its order, a second answer, failed
     exits and their retries, lost and restored sell routes, a pool coin hit by its stop, a coin that graduates while
     held, invalid snapshots, Jupiter prices without a SOL price, a stale price at the edge of 20 s, a repeated high,
     failed checks (danger flag, no audit, no RugCheck report, the stricter checks), a dead coin, a market-data halt,
     a restart with orders in flight, a failed save, a 27-minute outage, and 5.7 quiet days (equity thinning, pruning).
   Writes OUTDIR/v11-inputs/... and OUTDIR/v11.json like the server does, plus every save (OUTDIR/v11-saves.jsonl.gz:
   [run, n, at, ok, state] per line) so the re-check can compare at every save, not only at restarts and the end; prints what was covered and exits 1 if an
   intended path did not happen.  Usage: node v11_e0_scenarios.js OUTDIR */
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const REPO = path.resolve(__dirname, '../..');
const REC = require(path.join(REPO, 'server/v11/record.js'));
const { createEngine } = require(path.join(REPO, 'server/v11/engine.js'));
const X = require(path.join(REPO, 'server/v11/model.js'));

const OUT = process.argv[2];
if (!OUT) { console.log('usage: node v11_e0_scenarios.js OUTDIR'); process.exit(2); }
const T0 = Date.UTC(2026, 9, 21, 12, 0, 0), SOL = 100;
const min = n => T0 + Math.round(n * 60000);

// ------------------------------------------------------------------------------------------------ the market
// price paths in USD per token, linear between points; null = no answer for that coin
function path_(pts) {
  const f = t => {
    const x = (t - T0) / 60000;
    if (x < pts[0][0] || x > pts[pts.length - 1][0]) return null;
    for (let i = 1; i < pts.length; i++) if (x <= pts[i][0]) {
      const [a, pa] = pts[i - 1], [b, pb] = pts[i];
      if (pa == null || pb == null) return null;
      return +(pa + (pb - pa) * (x - a) / (b - a)).toPrecision(7);
    }
    return null;
  };
  f.end = pts[pts.length - 1][1];   // quotes after the scripted window still get an answer at the last price
  return f;
}
const good = { mintAuthorityDisabled: true, freezeAuthorityDisabled: true, devBalancePercentage: 1, topHoldersPercentage: 12, devMints: 2 };
const mint = s => (s + '1111111111111111111111111111111111111111').slice(0, 40) + 'pump';
const COINS = [
  // A: the busy one. Failed buys of every kind, failed exits, lost and restored sell routes, NaN impact
  { k: 'A', name: 'Frog Alpha', x: 0, checks: 0.5, hiMc: 10000, off: 0, jup: true,
    price: path_([[0, 0.9e-5], [2, 0.8e-5], [4, 0.62e-5], [5, 0.55e-5], [6, 0.52e-5], [6.9, 0.56e-5], [12, 0.61e-5], [16, 0.66e-5], [22, 0.6e-5], [30, 0.5e-5], [50, 0.42e-5], [70, 0.55e-5], [80, 0.62e-5], [105, 0.6e-5], [240, 0.5e-5]]) },
  // B: a PumpSwap pool coin (stop reachable): bought on the dip, then crashes 94% through the stop
  { k: 'B', name: 'Frog Bravo', x: 14, checks: 14.5, hiMc: 120000, off: 1000, venue: () => 'pool',
    price: path_([[14, 1e-4], [16, 0.7e-4], [17, 0.69e-4], [19, 0.6e-4], [20, 0.04e-4], [40, 0.04e-4]]) },
  // C: bought on the dip, then races to graduation: held positions pause, a slow buy fails, then it trades on the pool
  { k: 'C', name: 'Frog Charlie', x: 22, checks: 22.5, hiMc: 10000, off: 0,
    venue: t => t >= min(27) ? 'pool' : 'curve',
    price: path_([[22, 0.9e-5], [23.9, 0.6e-5], [24, 0.58e-5], [24.05, 4.1e-5], [27, 4.3e-5], [30, 4.5e-5], [60, 4.4e-5]]) },
  // D: snapshots 0.5 s before each tick. Its checks finish when the last price is 20.5 s old (too old to arm the watch);
  // later an invalid DexScreener answer blocks entries for 20 s while Jupiter (no SOL price) keeps the price fresh
  { k: 'D', name: 'Frog Delta', x: 30, checks: 33 + 20 / 60, hiMc: 10000, off: 4500, jupNoSol: true,
    gaps: [[min(33), min(33) + 24000]], invalidAt: [min(34) - 500], dexGaps: [[min(34) + 4000, min(34) + 30000]],
    price: path_([[30, 0.9e-5], [32.99, 0.62e-5], [33.38, 0.56e-5], [33.7, 0.56e-5], [33.85, 0.7e-5], [33.95, 0.7e-5], [34.05, 0.55e-5], [36, 0.5e-5], [45, 0.58e-5], [60, 0.62e-5]]) },
  // E: a high seen again at exactly the same price (the high's time must not move)
  { k: 'E', name: 'Frog Echo', x: 36, checks: 36.5, hiMc: 8000, off: 2000,
    price: path_([[36, 0.9e-5], [36.1, 0.9e-5], [36.15, 0.9e-5], [38, 0.85e-5], [44, 0.9e-5], [60, 0.8e-5]]) },
  // K: dips deep just before run 1 ends: its buys are in flight at the last save and are cancelled when run 2 starts
  { k: 'K', name: 'Frog Kilo', x: 37, checks: 37.5, hiMc: 10000, off: 0,
    price: path_([[37, 0.9e-5], [39.7, 0.5e-5], [39.85, 0.42e-5], [45, 0.42e-5], [55, 0.6e-5], [80, 0.66e-5]]) },
  // F: danger flag (fails every account), then under $5K for 5 minutes: dead, forgotten, a repeated audit is ignored
  { k: 'F', name: 'Frog Foxtrot', x: 41, checks: 41.5, hiMc: 9000, off: 3000, rc: { valid: true, risks: [['Mutable metadata', 'danger', 'yes']], score: 9000, sn: 80 },
    price: path_([[41, 0.8e-5], [43, 0.4e-5], [52, 0.38e-5], [60, 0.3e-5]]) },
  // G: Jupiter had no audit, RugCheck had no report
  { k: 'G', name: 'Frog Golf', x: 42, checks: 42.5, hiMc: 9000, off: 1000, audit: null, rc: { valid: false },
    price: path_([[42, 0.8e-5], [50, 0.45e-5], [60, 0.5e-5]]) },
  // H: passes the v10 checks (dev share as a string, top holders missing) but not the stricter ones
  { k: 'H', name: 'Frog Hotel', x: 44, checks: 44.5, hiMc: 9000, off: 2000,
    audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true, devBalancePercentage: '5', devMints: 30 }, holders: 20, soc: { tw: false, web: false, tg: false },
    rc: { valid: true, risks: [['Low liquidity', 'warn', '1']], score: 700, sn: 70 },
    price: path_([[44, 0.85e-5], [47, 0.5e-5], [48, 0.48e-5], [52, 0.6e-5], [80, 0.7e-5]]) },
  // L: dips after the last committed save of run 2: what run 2 did with it is lost, run 3 decides again
  { k: 'L', name: 'Frog Lima', x: 70, checks: 70.5, hiMc: 10000, off: 3000,
    price: path_([[70, 0.9e-5], [78.2, 0.62e-5], [78.5, 0.55e-5], [80, 0.54e-5], [105, 0.53e-5], [130, 0.6e-5], [240, 0.58e-5]]) },
  // M: its buys are in flight at run 2's last committed save, then a 27-minute outage
  { k: 'M', name: 'Frog Mike', x: 72, checks: 72.5, hiMc: 10000, off: 2000,
    price: path_([[72, 0.9e-5], [77.6, 0.62e-5], [77.95, 0.55e-5], [80, 0.5e-5], [105, 0.5e-5], [110, 0.56e-5], [240, 0.62e-5]]) },
  // I: a dev share reported as text above the limit
  { k: 'I', name: 'Frog India', x: 46, checks: 46.5, hiMc: 9000, off: 3000, audit: Object.assign({}, good, { devBalancePercentage: '15.5' }),
    price: path_([[46, 0.85e-5], [50, 0.5e-5], [60, 0.55e-5]]) },
  // N: a coin of run 3 for the time limits and take-profits after the outage
  { k: 'N', name: 'Frog November', x: 110, checks: 110.5, hiMc: 10000, off: 1000,
    price: path_([[110, 0.9e-5], [130, 0.62e-5], [132, 0.55e-5], [170, 0.565e-5], [200, 0.62e-5], [240, 0.64e-5]]) },
];
const DECOY = { k: 'Z', name: 'Frog Decoy', x: -15 };   // an earlier "frog" crossing: the meme check passes for the others
for (const c of COINS.concat(DECOY)) { c.m = mint('Frog' + c.k + c.name.replace(/ /g, '')); c.sym = c.name.split(' ')[1].toUpperCase().slice(0, 5); }
const byM = Object.fromEntries(COINS.map(c => [c.m, c]));
const SILENT = [[min(57), min(58.5)]];          // no price answers at all: entries halt after 60 s
const silent = t => SILENT.some(([a, b]) => t >= a && t < b);
const priceAt = (c, t) => (c.gaps || []).some(([a, b]) => t >= a && t < b) || silent(t) ? null : c.price(t);
const venueAt = (c, t) => (c.venue ? c.venue(t) : 'curve');

// quote answers per (account, coin, side) attempt; anything not listed is a normal fill 1 s later
const PLAN = {
  'E0-U:A:buy': ['400'], 'E0-U2:A:buy': ['transport'], 'E0-U30:A:buy': ['invalid'], 'E0-T25:A:buy': ['silent'],
  'E0-GRN:A:buy': ['moved'], 'E0-STR:A:buy': ['late'], 'E0-D55:A:buy': ['empty'],
  'E0-U:A:sell': ['400', 'transport'], 'E0-U2:A:sell': ['errbody', 'early'], 'E0-U30:A:sell': ['nan'], 'E0-STR:A:sell': ['twice'],
  'mark:A': ['ok', '400', 'invalid', 'ok', 'transport'],
  'E0-U:C:buy': ['slow'], 'E0-U2:C:buy': ['slow'], 'E0-U30:C:buy': ['slow'], 'E0-T25:C:buy': ['slow'], 'E0-GRN:C:buy': ['slow'], 'E0-D55:C:buy': ['slow'],
  'E0-U:K:buy': ['silent'], 'E0-U2:K:buy': ['silent'], 'E0-U30:K:buy': ['silent'], 'E0-T25:K:buy': ['silent'], 'E0-GRN:K:buy': ['silent'], 'E0-STR:K:buy': ['silent'], 'E0-D55:K:buy': ['silent', 'empty'],
  'E0-U:N:buy': ['nan'], 'E0-U30:N:buy': ['tick'], 'mark:N': ['400dup', 'transport', 'transport', 'transport', 'transport', 'transport', 'transport'],
  'E0-U:M:buy': ['silent'], 'E0-U2:M:buy': ['silent'], 'E0-U30:M:buy': ['silent'], 'E0-T25:M:buy': ['silent'], 'E0-GRN:M:buy': ['silent'], 'E0-STR:M:buy': ['silent'], 'E0-D55:M:buy': ['silent'],
};
const tries = {};
function answer(r, t) {
  const c = byM[r.m], key = r.orderId ? `${r.orderId.split(':')[0]}:${c.k}:${r.side}` : `mark:${c.k}`;
  const n = tries[key] = (tries[key] || 0) + 1, kind = (PLAN[key] || [])[n - 1] || 'ok';
  const at = t + (kind === 'late' ? 31000 : kind === 'slow' ? 12000 : kind === 'tick' ? 5000 : 1000);   // 'tick': lands exactly on the next tick
  const base = { id: `q:${r.orderId || r.m}:${at}`, type: 'quote', at, reqAt: t, orderId: r.orderId || null, m: r.m, side: r.side, inAmount: r.amount };
  const fill = (at2, k2) => {
    const p = c.price(at2) || c.price(t) || c.price.end, ps = p / SOL, v = venueAt(c, at2);
    let out = r.side === 'buy' ? X.buyOut(r.amount / 1e9, ps, v, at2).tokens * 1e6 : X.sellOut(r.amount / 1e6, ps, v, at2).sol * 1e9;
    if (k2 === 'moved') out *= 0.85;
    return Object.assign({}, base, { id: `q:${r.orderId || r.m}:${at2}`, at: at2, valid: true, ok: true, inAmount: r.amount, outAmount: Math.floor(out),
      impactPct: k2 === 'nan' ? NaN : 0.031, route: [v === 'pool' ? 'Pump.fun Amm' : 'Pump.fun'], venue: v, slot: Math.floor(at2 / 1000) });
  };
  switch (kind) {
    case 'silent': return [];
    case '400': return [Object.assign(base, { valid: true, ok: false, err: 'no route (HTTP 400)', noRoute: true })];
    case 'transport': return [Object.assign(base, { valid: true, ok: false, err: 'HTTP 502', transport: true })];
    case 'errbody': return [Object.assign(base, { valid: true, ok: false, err: 'Could not find any route' })];
    case 'invalid': return [Object.assign(base, { valid: false, reason: 'quote: inAmount/outAmount/routePlan missing (schema change?)' })];
    case 'empty': return [Object.assign(base, { valid: false, reason: 'quote: empty response' })];
    case 'early': return [Object.assign(fill(t + 1000), { at: t - 1000, id: `q:${r.orderId}:${t - 1000}x` }), fill(t + 2000)];
    case '400dup': { const e = Object.assign(base, { valid: true, ok: false, err: 'no route (HTTP 400)', noRoute: true }); return [e, Object.assign({}, e)]; }   // delivered twice
    case 'twice': return [fill(t + 1000), fill(t + 1500), fill(t + 1000)];   // a second answer, then the first one again (same id)
    default: return [fill(at, kind)];
  }
}

// ------------------------------------------------------------------------------------------------ a miniature runtime
const rec = REC.recorder(), files = [], seenLog = [], errors = [], saves = [];
let eng = null, saveN = 0, committed = null, run = 0, fileStart = null, part = 0;
const pending = [];
const ingest = ev => { rec.event(ev); try { eng.ingest(ev); } catch (e) { errors.push('v11 ingest: ' + e.message); } };
function cut(at) {
  const lines = rec.take(); if (!lines.length) return;
  const iso = new Date(fileStart).toISOString();
  files.push({ name: `v11-inputs/${iso.slice(0, 10)}/${iso.slice(11, 19).replace(/:/g, '')}-run${run}-p${String(++part).padStart(3, '0')}.jsonl.gz`, lines });
  fileStart = at;
}
function start(at) {
  run++; part = 0; saveN = 0; fileStart = at;
  rec.version(at, { sha: 'scenario', engine: '11.0', run: String(run) });
  rec.load(at, committed);
  eng = createEngine();
  if (committed) eng.load(REC.unpack(JSON.parse(JSON.stringify(committed)))); else eng.init(at);
  ingest({ type: 'run_start', at, run: String(run) });
  pending.length = 0;     // answers to the old process are lost with it
}
function save(at, ok) {
  const s = REC.trimSave(eng.save());
  rec.save(at, ++saveN);
  const json = JSON.stringify(s);
  rec.committed(at, saveN, ok);
  saves.push(JSON.stringify([run, saveN, at, ok, s]));      // every save, so the check can compare between restarts too
  if (ok) committed = JSON.parse(json);
}
function tick(at, first) {
  if (first) ingest({ type: 'sol', at, usd: SOL });
  rec.tick(at);
  let reqs = [];
  try { reqs = eng.tick(at); } catch (e) { errors.push('v11 tick: ' + e.message); }
  for (const r of reqs) for (const ev of answer(r, at)) pending.push(ev);
  pending.sort((a, b) => a.at - b.at);
  for (const e of eng.drain()) seenLog.push(e);
}
const checksEv = c => {
  const at = min(c.checks), au = c.audit === undefined ? good : c.audit, rc = c.rc || { valid: true, risks: [], score: 1, sn: 1 };
  const a = { id: 'a:' + c.m, type: 'audit', at, reqAt: at - 1500, m: c.m, valid: !!au, reason: au ? null : 'Jupiter had no audit for this coin after 4 tries',
    fields: au ? Object.assign({}, au, { holders: c.holders || 150, socials: c.soc || { tw: true, web: false, tg: false }, dev: null }) : {} };
  const r = { id: 'r:' + c.m, type: 'rugcheck', at, reqAt: at - 800, m: c.m, valid: rc.valid !== false, reason: rc.valid === false ? 'no RugCheck report' : null, risks: rc.risks || [] };
  if (rc.valid !== false) Object.assign(r, { score: rc.score, sn: rc.sn });
  return [a, r];
};
function step(from, to, opts = {}) {
  let first = true;
  for (let t = from; t <= to; t += 500) {
    while (pending.length && pending[0].at <= t) ingest(pending.shift());
    for (const c of COINS.concat(DECOY)) {
      if (t === min(c.x)) ingest({ id: 'x:' + c.m, type: 'crossing', at: t, m: c.m, sym: c.sym, name: c.name, t0: (min(c.x) - 600000) / 1000, mcX: 7012.5,
        hiMc: c.hiMc || 7100, bc: 'Bc' + c.m.slice(2), links: c.k === 'A' ? { web: 1, soc: ['twitter'] } : null });
      if (c.checks != null && t === min(c.checks)) for (const ev of checksEv(c)) ingest(ev);
    }
    if (t === min(42)) ingest(checksEv(COINS.find(c => c.k === 'F'))[0]);     // the same audit again: ignored
    for (const c of COINS) {
      if (t < min(c.x) || (t - T0 - c.off) % 5000 !== 0) continue;
      const p = priceAt(c, t), v = venueAt(c, t);
      if ((c.invalidAt || []).includes(t)) ingest({ m: c.m, at: t, src: 'dex', valid: false, reason: 'DexScreener: no pump.fun or PumpSwap pair', id: `d:${c.m}:${t}`, type: 'snapshot' });
      else if (p != null && !(c.dexGaps || []).some(([a, b]) => t >= a && t < b))
        ingest({ m: c.m, at: t, src: 'dex', valid: true, p, ps: +(p / SOL).toPrecision(7), mc: +(p * 1e9).toPrecision(7), venue: v, pool: v === 'pool' ? 'Pool' + c.k : null,
          liq: { usd: 9000, base: null, quote: 40 }, dx: { b5: (t / 5000) % 7, s5: NaN, v5: 1200, v1h: 9000 }, id: `d:${c.m}:${t}`, type: 'snapshot' });
      if (p != null && (c.jup || c.jupNoSol) && ((t - T0 - c.off) / 5000) % 4 === 0) {
        const pj = +(p * 1.0004).toPrecision(7);
        ingest({ m: c.m, at: t, src: 'jup', valid: true, p: pj, ps: c.jupNoSol ? null : +(pj / SOL).toPrecision(7), mc: +(pj * 1e9).toPrecision(7), liqUsd: 9100, holders: 150, org: NaN,
          asOf: t - 3000, dev: null, st: { bv: 800, sv: NaN, nb: 9, ns: 4 }, st1h: { bv: 9000 }, audit: { mintAuthorityDisabled: true, topHoldersPercentage: 12 }, id: `j:${c.m}:${t}`, type: 'snapshot' });
      }
    }
    if ((t - T0) % 5000 === 0) { tick(t, first); first = false; }
    if (opts.cutAt && t === opts.cutAt) cut(t);
    if ((t - T0) % 120000 === 2500 && t < to) save(t, !(opts.failAt || []).includes(t));
  }
}

// run 1: 11:40 to 12:40 (a file cut at 12:00, one failed save), orders in flight at its last save
start(min(-20));
step(min(-20), min(39.9), { cutAt: min(0), failAt: [min(30) + 2500] });
save(min(39.9) + 600, true);
cut(min(40));
// run 2: 50 s later (no coverage gap); its last save fails, so run 3 starts from the one before
start(min(40) + 50000);
step(min(40) + 50000, min(79.9));
save(min(79.9) + 600, false);
cut(min(80));
// run 3: after a 27-minute outage, then 5.7 quiet days with a tick every 2 minutes
start(min(105));
step(min(105), min(240));
for (let t = min(240) + 120000, i = 0; i < 4100; t += 120000, i++) {
  while (pending.length && pending[0].at <= t) ingest(pending.shift());
  tick(t, false);
  if (i % 60 === 59) save(t + 500, true);
}
save(min(240) + 4101 * 120000, true);
cut(min(240) + 4101 * 120000);

// ------------------------------------------------------------------------------------------------ write and report
fs.rmSync(OUT, { recursive: true, force: true });
for (const f of files) {
  const p = path.join(OUT, f.name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, zlib.gzipSync(f.lines.join('\n') + '\n', { level: 9 }));
}
fs.writeFileSync(path.join(OUT, 'v11.json'), JSON.stringify(committed));
fs.writeFileSync(path.join(OUT, 'v11-saves.jsonl.gz'), zlib.gzipSync(saves.join('\n') + '\n'));
fs.writeFileSync(path.join(OUT, 'sim_out_scenarios.json'), JSON.stringify({ errors }));

const has = (type, f = () => true) => seenLog.some(e => e.type === type && f(e));
const isE0 = e => String(e.acct || e.id || '').startsWith('E0-');
const want = {
  'buy failed: no route': has('OrderFailed', e => isE0(e) && e.side === 'buy' && e.why.startsWith('no executable route: no route')),
  'buy failed: transport': has('OrderFailed', e => isE0(e) && e.side === 'buy' && e.why.startsWith('quote unavailable')),
  'buy failed: invalid answer': has('OrderFailed', e => isE0(e) && e.why.startsWith('quote failed validation: quote: inAmount')),
  'buy failed: empty answer': has('OrderFailed', e => isE0(e) && e.why === 'quote failed validation: quote: empty response'),
  'buy failed: no answer in 30 s': has('OrderFailed', e => isE0(e) && e.why === 'no quote within 30 s'),
  'buy failed: price moved': has('OrderFailed', e => isE0(e) && e.why.startsWith('price moved')),
  'buy failed: graduating': has('OrderFailed', e => isE0(e) && e.why === 'coin is graduating: venue uncertain'),
  'fill after 30 s, no tick between': has('OrderFilled', e => isE0(e) && e.delayMs > 30000),
  'answer older than its order': has('QuoteIgnored', e => e.why === 'quote older than the order'),
  'second answer ignored': has('QuoteIgnored', e => /^order already/.test(e.why)),
  'exit failed: no route': has('OrderFailed', e => isE0(e) && e.side === 'sell' && e.why.startsWith('no executable route: no route')),
  'exit failed: error body': has('OrderFailed', e => isE0(e) && e.side === 'sell' && e.why === 'no executable route: Could not find any route'),
  'exit failed: transport': has('OrderFailed', e => isE0(e) && e.side === 'sell' && e.why.startsWith('quote unavailable')),
  'sell route lost': has('SellRouteLost'), 'sell route restored': has('SellRouteRestored'),
  'take profit': has('PositionClosed', e => isE0(e) && e.reason === 'tp'), 'stop loss': has('PositionClosed', e => isE0(e) && e.reason === 'sl'),
  'time limit': has('PositionClosed', e => isE0(e) && e.reason === 'time'),
  'time limit on the exact ms': has('OrderRequested', e => e.acct === 'E0-U30' && e.side === 'sell' && /minute limit/.test(e.why) && seenLog.some(f => f.type === 'OrderFilled' && f.acct === 'E0-U30' && f.side === 'buy' && e.at - (f.at) === 30 * 60000)),
  'NaN impact on a buy': has('OrderFilled', e => isE0(e) && e.side === 'buy' && Number.isNaN(e.impact)),
  'route quote delivered twice': (tries['mark:N'] || 0) >= 1,
  'held through graduation (paused)': has('PositionReviewed', e => isE0(e) && e.state === 'paused'),
  'exit unavailable': has('PositionReviewed', e => isE0(e) && e.state === 'exit_unavailable'),
  'unpriceable': has('PositionReviewed', e => isE0(e) && e.state === 'unpriceable'),
  'invalid snapshot': has('DataInvalid'), 'entries halted': has('EntriesHalted'), 'entries resumed': has('EntriesResumed'),
  'checks failed': has('EligibilityDecided', e => !e.pass && isE0(e)), 'stricter checks failed only': has('EligibilityDecided', e => !e.pass && e.acct === 'E0-STR' && e.m === COINS.find(c => c.k === 'H').m),
  'cancelled: restarted': has('OrderCancelled', e => isE0(e) && e.why === 'server restarted'), 'cancelled: offline': has('OrderCancelled', e => isE0(e) && e.why === 'server offline'),
  'coverage gap': has('CoverageGap'),
  'equity thinned': Object.values(committed.accts).some(A => A.eq.length < 4100 && A.eq.length > 2000),
  'no engine errors': errors.length === 0,
};
const missing = Object.entries(want).filter(([, v]) => !v).map(([k]) => k);
const S = committed;
console.log(`   scenarios: ${files.length} input files, ${files.reduce((n, f) => n + f.lines.length, 0)} lines, ${Object.keys(want).length - missing.length}/${Object.keys(want).length} paths covered` +
  `; E0 trades ${Object.values(S.accts).filter(A => A.kind === 'e0').reduce((n, A) => n + A.trades.length, 0)}, fails ${Object.values(S.accts).filter(A => A.kind === 'e0').reduce((n, A) => n + A.n.fails, 0)}`);
for (const k of missing) console.log('   NOT COVERED: ' + k);
if (process.env.SCN_DEBUG) {
  const K = Object.fromEntries(COINS.map(c => [c.m, c.k]));
  for (const e of seenLog) if (['OrderRequested', 'OrderFilled', 'OrderFailed', 'OrderCancelled', 'PositionClosed', 'CoverageGap', 'EntriesHalted', 'EntriesResumed'].includes(e.type) && (!e.acct || isE0(e) || String(e.id).startsWith('E0')))
    console.log(((e.at - T0) / 60000).toFixed(3).padStart(8), e.type.padEnd(15), String(e.acct || e.id || '').split(':')[0].padEnd(7), K[e.m] || K[String(e.id || '').split(':')[1]] || '', e.side || '', e.why || e.reason || '');
}
process.exit(missing.length ? 1 : 0);
