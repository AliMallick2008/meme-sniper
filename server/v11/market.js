'use strict';
/* What the v11 engine knows about each coin, built only from observations, in the order they were received.
   Nothing here can look forward: every value carries the time it was received (`at`, ms). */
const E = require('../sniper.js');

const MAX_SNAPS = 150, MAX_BARS = 240;
const GRAD_NEAR = 0.97;                       // curve this close to completion and no pool seen yet: "migrating"
const DEAD_MC_USD = 5000, DEAD_AFTER_MS = 5 * 60000;   // under $5K market cap for 5 minutes straight: stop following

function newCoin(ev) {
  return {
    m: ev.m, sym: ev.sym || '', name: ev.name || '', t0: ev.t0 || null, xAt: ev.at, mcX: ev.mcX || null, bc: ev.bc || null,
    words: ev.words || E.words(ev.name, ev.sym), links: ev.links || null,
    hi: ev.hiMc > 0 ? { p: ev.hiMc / E.SUPPLY, at: ev.at, src: 'follow' } : null,  // highest price seen so far (USD)
    audit: null, rc: null,                     // point-in-time check results: { reqAt, at, valid, fields }
    snaps: [], bars: [], last: null, jup: null, quote: null,
    stage: 'curve', stageAt: ev.at, pool: null, invalid: null, firstAt: ev.at,
  };
}

// one observation: { at, src: 'dex'|'jup'|'quote', valid, reason, p (USD/token), ps (SOL/token), mc (USD), liq, venue, pool, st, asOf }
function observe(c, o) {
  if (!o.valid) { c.invalid = { at: o.at, reason: o.reason || 'invalid data', src: o.src }; return; }
  if (c.invalid && c.invalid.src === o.src) c.invalid = null;
  c.snaps.push(o); if (c.snaps.length > MAX_SNAPS) c.snaps.splice(0, c.snaps.length - MAX_SNAPS);
  if (o.src === 'jup') c.jup = o;
  if (o.p > 0 && (!c.hi || o.p > c.hi.p)) { c.hi = { p: o.p, at: o.at, src: o.src }; c.lo = null; }
  // the heaviest 5-minute selling Jupiter reported since the current high (to tell whether selling has eased since)
  if (o.src === 'jup' && o.st && isFinite(o.st.sv) && c.hi) {
    if (!c.svPk || c.svPk.since !== c.hi.at) c.svPk = { v: o.st.sv, at: o.at, since: c.hi.at };
    else if (o.st.sv > c.svPk.v) { c.svPk.v = o.st.sv; c.svPk.at = o.at; }
  }
  if (o.p > 0) {
    c.last = { at: o.at, p: o.p, ps: o.ps > 0 ? o.ps : (c.last && c.last.ps > 0 && c.last.p > 0 ? c.last.ps * o.p / c.last.p : null), mc: o.mc, src: o.src };
    if (o.p < c.hi.p && (!c.lo || o.p < c.lo.p)) c.lo = { p: o.p, at: o.at };      // lowest price since the current high
    bar(c, o.at, o.p);
    const mc = o.mc > 0 ? o.mc : o.p * E.SUPPLY;
    if (mc >= DEAD_MC_USD) c.lowSince = null;
    else if (!c.lowSince) c.lowSince = o.at;
    else if (!c.deadAt && o.at - c.lowSince >= DEAD_AFTER_MS) c.deadAt = o.at;
  }
  if (o.venue === 'pool') { if (c.stage !== 'pool') { c.stage = 'pool'; c.stageAt = o.at; } if (o.pool) c.pool = o.pool; }
  else if (o.venue === 'curve' && c.stage !== 'pool') {
    const ms = c.last && c.last.ps > 0 ? c.last.ps * E.SUPPLY : null;   // market cap in SOL
    const st = ms != null && ms >= GRAD_NEAR * E.GRAD_MC_SOL ? 'migrating' : 'curve';
    if (st !== c.stage) { c.stage = st; c.stageAt = o.at; }
  }
}
// 1-minute bars from the prices this server observed (not GeckoTerminal's): a bar is known only once its minute ended
function bar(c, at, p) {
  const t = Math.floor(at / 60000) * 60;
  const b = c.bars[c.bars.length - 1];
  if (b && b.t === t) { b.h = Math.max(b.h, p); b.l = Math.min(b.l, p); b.c = p; b.n++; }
  else if (!b || t > b.t) { c.bars.push({ t, o: p, h: p, l: p, c: p, n: 1 }); if (c.bars.length > MAX_BARS) c.bars.splice(0, c.bars.length - MAX_BARS); }
}
const doneBars = (c, at) => c.bars.filter(b => (b.t + 60) * 1000 <= at);
const fresh = (c, at, maxMs) => c.last && at - c.last.at <= maxMs ? c.last : null;

// SOL/USD at time t from prices already observed at or before t (never a later one); null if none within maxMs
function solAt(sol, t, maxMs = 5 * 60000) {
  let best = null;
  for (const x of sol) if (x.at <= t && (!best || x.at > best.at)) best = x;
  return best && t - best.at <= maxMs ? best.usd : null;
}
// price at time t, from observations received at or before t: the latest snapshot within a minute of t, else the
// close of the last 1-minute bar that ended by t (bars survive restarts, snapshots mostly do not), else null
function priceAt(c, t) {
  let best = null;
  for (const s of c.snaps) if (s.p > 0 && s.at <= t && (!best || s.at > best.at)) best = s;
  if (best && t - best.at <= 60000) return best.p;
  for (let i = c.bars.length - 1; i >= 0; i--) { const b = c.bars[i]; if ((b.t + 60) * 1000 <= t) return b.c; }
  return best ? best.p : null;
}
module.exports = { newCoin, observe, doneBars, fresh, solAt, priceAt, MAX_SNAPS, DEAD_MC_USD };
