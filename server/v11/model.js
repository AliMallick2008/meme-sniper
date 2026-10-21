'use strict';
/* Price-impact model, used only where no executable quote exists yet (decision estimates, marks between quotes).
   Bonding curve: exact constant product of virtual reserves (k = 30 SOL x 1.073e9 tokens), so a spot price fixes the
   curve state. PumpSwap pool: constant product of the pool's own reserves when a snapshot reports them, else a rough
   post-graduation pool (flagged approx). Fees come from the versioned schedule in fees.js. */
const E = require('../sniper.js');
const FEES = require('./fees.js');

function reserves(ps, venue, liq) {
  if (venue === 'pool') {
    if (liq && liq.base > 0 && liq.quote > 0) return { R: liq.quote, T: liq.base, approx: false };
    const R = Math.sqrt(E.POOL_K * ps); return { R, T: R / ps, approx: true };
  }
  const R = Math.sqrt(E.CURVE_K * ps); return { R, T: R / ps, approx: false };
}
// tokens received for S SOL (venue fee taken from the SOL in)
function buyOut(S, ps, venue, at, liq) {
  const fee = FEES.feeRate(at / 1000, venue, ps * E.SUPPLY), net = S * (1 - fee), { R, T, approx } = reserves(ps, venue, liq);
  return { tokens: T - (R * T) / (R + net), fee: S * fee, approx };
}
// SOL received for Q tokens (venue fee taken from the SOL out)
function sellOut(Q, ps, venue, at, liq) {
  const fee = FEES.feeRate(at / 1000, venue, ps * E.SUPPLY), { R, T, approx } = reserves(ps, venue, liq);
  const gross = R - (R * T) / (T + Q);
  return { sol: gross * (1 - fee), fee: gross * fee, approx };
}
// the curve can never trade below its launch price: proceeds for Q tokens at that floor (a hard lower bound on the curve)
const curveFloorValue = (Q, at) => sellOut(Q, E.CURVE_FLOOR, 'curve', at).sol;
module.exports = { reserves, buyOut, sellOut, curveFloorValue };
