'use strict';
/* v11 accounts. E0-*: the seven legacy rule sets under causal timing (audit experiment E0). HOLD: keep the 10 SOL.
   The V2 strategies (A, B, C) are added in phase 3. A strategy answers two questions on every tick, using only what the
   engine has observed by then: which watched coin, if any, to buy now (entry), and whether to sell the held coin now (review). */
const E = require('../sniper.js');
const MK = require('./market.js');
const G = require('./gates.js');
const X = require('./model.js');
const FEES = require('./fees.js');
const { WATCH_S, BOTS, START_SOL } = E.RULES;

const FRESH_MS = 20000;   // a price older than this is not used for a decision

function accounts() {
  const out = BOTS.map(b => ({ id: 'E0-' + b.id, exp: 'v11-e0/' + b.id, kind: 'e0', legacy: b.id, name: 'E0 ' + b.name, P: b.P, C: b.C, stake: b.P.stake,
    desc: `Legacy "${b.name}" rules with honest timing: watch starts when its checks finish, buys and sells only on prices seen live, filled at the next quote.` }));
  out.push({ id: 'HOLD', exp: 'v11-hold', kind: 'hold', name: 'Hold SOL', desc: 'Never trades: the 10 SOL baseline every strategy has to beat.' });
  return out;
}

// --------------------------------------------------------------------------------------------------- E0 (legacy rules)
// admit a coin to an E0 watchlist once both legacy checks are in: the watch starts at eligible_at, never earlier
function e0Admit(A, c, crosses) {
  if (!c.audit || !c.rc || A.watch[c.m] || A.seen[c.m]) return null;
  const gates = G.legacy(c, A.C, crosses);
  const eligibleAt = Math.max(c.xAt, c.audit.at, c.rc.at);
  A.seen[c.m] = { at: eligibleAt, pass: G.allPass(gates), why: G.fails(gates).map(x => x.label) };
  if (!G.allPass(gates)) return { m: c.m, at: eligibleAt, pass: false, gates };
  A.watch[c.m] = { m: c.m, from: eligibleAt, to: eligibleAt + WATCH_S * 1000, armed: null, dipAt: null, done: null, failUntil: 0 };
  return { m: c.m, at: eligibleAt, pass: true, gates };
}
// the buy signal of one watched coin at time `at` (or null), from live observations only
function e0Signal(A, w, c, at) {
  if (w.done || at < w.from) return null;
  if (at >= w.to) { w.done = 'nodip'; return null; }
  const last = MK.fresh(c, at, FRESH_MS);
  if (!last || !c.hi || c.stage === 'migrating' || (c.invalid && at - c.invalid.at < FRESH_MS)) return null;
  const trig = (1 - A.P.dip) * c.hi.p;
  w.trig = trig; w.H = c.hi.p;
  if (w.armed === null) w.armed = last.p > trig;           // rearm: a coin already under its buy level must first trade back above it
  if (!w.armed) { if (last.p > trig) w.armed = true; return null; }
  if (at < w.failUntil) return null;
  if (A.P.entry === 'green') {
    if (!w.dipAt && last.p <= trig) w.dipAt = last.at;
    if (!w.dipAt) return null;
    // first green 1-minute bar that started after the dip, known only once its minute is over
    const b = MK.doneBars(c, at).find(x => x.t * 1000 >= Math.floor(w.dipAt / 60000) * 60000 && x.c > x.o && (x.t + 60) * 1000 > w.dipAt);
    return b ? { m: c.m, w, sigAt: (b.t + 60) * 1000, p: last.p, ps: last.ps, why: `first green minute after the ${Math.round(A.P.dip * 100)}% dip closed at ${new Date((b.t + 60) * 1000).toISOString().slice(11, 16)} UTC` } : null;
  }
  return last.p <= trig ? { m: c.m, w, sigAt: last.at, p: last.p, ps: last.ps, why: `price seen ${((1 - last.p / c.hi.p) * 100).toFixed(1)}% under its high (buy zone ${Math.round(A.P.dip * 100)}%)` } : null;
}
function e0Entry(A, at, coins) {
  let best = null;
  for (const w of Object.values(A.watch)) {
    const c = coins[w.m]; if (!c) continue;
    const s = e0Signal(A, w, c, at);
    if (s && (!best || s.sigAt < best.sigAt)) best = s;   // legacy order: the first coin to dip
  }
  return best;
}
// sell decision for a held position (legacy targets, stop and time limit), on live data only
function e0Review(A, pos, c, at) {
  if (c.stage === 'migrating') return { hold: true, state: 'paused', why: 'coin is graduating: venue uncertain, no fills' };
  const last = MK.fresh(c, at, FRESH_MS);
  if (last && last.ps > 0) {
    const venue = c.stage === 'pool' ? 'pool' : 'curve';
    if (A.P.sl && last.ps <= (1 - A.P.sl) * pos.entrySpot) return { exit: 'sl', why: `price ${((last.ps / pos.entrySpot - 1) * 100).toFixed(0)}% from the buy: stop` };
    const est = X.sellOut(pos.qty, last.ps, venue, at).sol * (1 - FEES.COSTS.landingDrift) - FEES.COSTS.networkFeeSol;
    if (est >= pos.cost * (1 + A.P.tp)) return { exit: 'tp', why: `selling now should return ${est.toFixed(3)} SOL, at least the ${(A.P.tp * 100).toFixed(0)}% target after costs` };
  }
  // a time limit needs no price: the sell quote itself is the price
  if (A.P.maxHold && at >= pos.openAt + A.P.maxHold * 60000) return { exit: 'time', why: `${A.P.maxHold} minute limit reached` };
  if (!last) return { hold: true, state: 'unpriceable', why: 'no fresh price: no decision possible' };
  return { hold: true, state: 'holding', why: pos.stopUnreachable ? 'no exit rule met (its stop is under the curve floor and can never trigger)' : 'no exit rule met' };
}
module.exports = { accounts, e0Admit, e0Entry, e0Review, e0Signal, FRESH_MS, START_SOL };
