'use strict';
/* What the engine keeps from the tape lane (tape.js), per coin, in c.tp. Data only: no v2.0 or E0 rule reads it, so
   their decisions are exactly what they were before the lane existed (their prices still come from market.js).

   c.tp = { first (ms), n (trades seen), cr (creator, 8 chars), last: { at, slot, vs, vt, ps, src }, done, doneAt,
            tr: [[at, slot, b, s, q, u, ps], ...] (the last 15 minutes, newest last), crSold (micro-SOL the creator sold),
            crSellAt, sub (subscription confirmed and not ended), subAt }
   Units: s, vs in micro-SOL; q, vt in whole tokens; ps = SOL per token. */
const TR_KEEP_MS = 15 * 60000, TR_MAX = 4000;
const r7 = v => +v.toPrecision(7);
const psOf = (vs, vt) => (vs > 0 && vt > 0 ? r7((vs / 1e6) / vt) : null);

function tp(c, at) { return c.tp || (c.tp = { first: at, n: 0, cr: null, last: null, done: false, doneAt: null, tr: [], crSold: 0, crSellAt: null }); }
function newer(t, slot) { return !t.last || slot == null || t.last.slot == null || slot >= t.last.slot; }

function onTape(c, ev) {
  const t = tp(c, ev.at);
  if (ev.cr && !t.cr) t.cr = ev.cr;
  const ps = psOf(ev.vs, ev.vt);
  t.n++;
  t.tr.push([ev.at, ev.slot, ev.b, ev.s, ev.q, ev.u, ps]);
  if (t.tr.length > TR_MAX) t.tr.splice(0, t.tr.length - TR_MAX);
  if (newer(t, ev.slot)) t.last = { at: ev.at, slot: ev.slot, vs: ev.vs, vt: ev.vt, ps, src: 'tape' };
  if (t.cr && ev.u === t.cr && !ev.b) { t.crSold += ev.s; t.crSellAt = ev.at; }
}
function onCurve(c, ev) {
  const t = tp(c, ev.at);
  if (ev.cr && !t.cr) t.cr = ev.cr;
  if (ev.done && !t.done) { t.done = true; t.doneAt = ev.at; }
  if (ev.vs > 0 && ev.vt > 0 && newer(t, ev.slot)) t.last = { at: ev.at, slot: ev.slot, vs: ev.vs, vt: ev.vt, ps: psOf(ev.vs, ev.vt), src: ev.src || 'poll' };
}
// a coin's subscription was confirmed (on) or ended; the connection going down ends them all (engine.js)
function onSub(c, ev) {
  const t = tp(c, ev.at);
  t.sub = !!ev.on;
  if (ev.on) t.subAt = ev.at;
}
/* the coin's tape can be trusted right now: the connection is up, its subscription is confirmed, a curve state was
   received since then (so trades in between were not missed), and the curve is not complete */
function live(S, c) {
  const t = c && c.tp;
  return !!(S.tape && S.tape.up && t && t.sub && t.last && t.subAt != null && t.last.at >= t.subAt && !t.done);
}
// drop trades older than 15 minutes (called from the engine's prune)
function trim(c, at) {
  const t = c.tp; if (!t || !t.tr.length) return;
  let k = 0; while (k < t.tr.length && at - t.tr[k][0] > TR_KEEP_MS) k++;
  if (k) t.tr.splice(0, k);
}
// for the saved copy (record.js trimSave, every 2 minutes for up to ~60 coins): the last 15 s of trades, at most 30
// (A3e's 10 s window survives a restart; the tape itself starts again with the next run)
function trimForSave(c, at) {
  const t = c.tp; if (!t) return;
  c.tp = Object.assign({}, t, { tr: t.tr.filter(x => at - x[0] <= 15000).slice(-30) });
}

/* Tape features over the last `win` ms at time `at` (only trades received by then). null when the coin has no tape.
   Returns { age (ms since the last state), ps, n, nb, ns, buySol, sellSol, buyers, sellers, maxSell (SOL), topBuyShare
   (largest single wallet's share of the window's buy SOL), crSold (SOL the creator sold since the tape began),
   ret (price change over the window, from the last state before it) } */
function features(c, at, win = 60000) {
  const t = c.tp; if (!t || !t.last) return null;
  const f = { age: at - t.last.at, ps: t.last.ps, n: 0, nb: 0, ns: 0, buySol: 0, sellSol: 0, buyers: 0, sellers: 0, maxSell: 0, topBuyShare: null, crSold: t.crSold / 1e6, ret: null, done: t.done };
  const by = new Map(), sellers = new Set();
  let p0 = null;
  for (const x of t.tr) {
    if (x[0] > at) break;
    if (at - x[0] > win) { p0 = x[6]; continue; }
    f.n++;
    const sol = x[3] / 1e6;
    if (x[2]) { f.nb++; f.buySol += sol; by.set(x[5], (by.get(x[5]) || 0) + sol); }
    else { f.ns++; f.sellSol += sol; sellers.add(x[5]); if (sol > f.maxSell) f.maxSell = sol; }
  }
  f.buyers = by.size; f.sellers = sellers.size;
  if (f.buySol > 0) f.topBuyShare = Math.max(...by.values()) / f.buySol;
  if (p0 && f.ps) f.ret = f.ps / p0 - 1;
  return f;
}
/* exact constant-product trades on the curve's virtual reserves (vs in micro-SOL, vt in tokens), venue fee `fee` taken
   from the SOL side: buy S SOL -> tokens; sell Q tokens -> SOL. impact: shortfall against the spot price. */
function curveBuy(st, S, fee) {
  const vs = st.vs / 1e6, vt = st.vt, net = S * (1 - fee);
  const out = vt - (vs * vt) / (vs + net);
  return { tokens: out, impact: 1 - out / (net / (vs / vt)) };
}
function curveSell(st, Q, fee) {
  const vs = st.vs / 1e6, vt = st.vt;
  const gross = vs - (vs * vt) / (vt + Q);
  return { sol: gross * (1 - fee), impact: 1 - gross / (Q * (vs / vt)) };
}
module.exports = { onTape, onCurve, onSub, live, trim, trimForSave, features, psOf, curveBuy, curveSell, TR_KEEP_MS };
