'use strict';
/* Execution model for marks and pre-trade estimates when no fresh Jupiter quote is at hand (audit Findings 03, 13, 14).
   Prices are SOL per whole token. Bonding curve: pump.fun's fixed virtual-reserve invariant, so a price pins the reserves
   exactly. PumpSwap pool: reserves observed by DexScreener when they agree with the price (within 15%), otherwise the
   post-graduation invariant, flagged `assumed`. Fees from fees.js by date and market cap. */
const FEES = require('./fees.js');

const SUPPLY = 1e9;
const CURVE_VSOL0 = 30, CURVE_VTOK0 = 1.073e9, CURVE_K = CURVE_VSOL0 * CURVE_VTOK0;
const POOL_K = 85 * 206.9e6;
const GRAD_MC_SOL = 410.9;
const CURVE_FLOOR = CURVE_VSOL0 / CURVE_VTOK0;   // lowest curve price (SOL per token): nobody holds bought tokens

/* Reserves { R (SOL), T (tokens), K, src } of the market a swap would hit at price pSol. */
function reserves(pSol, stage, liq) {
  if (stage === 'pool') {
    if (liq && liq.quote > 0 && liq.base > 0) {
      const p0 = liq.quote / liq.base;
      if (Math.abs(p0 / pSol - 1) < 0.15) { const K = liq.quote * liq.base, R = Math.sqrt(K * pSol); return { R, T: R / pSol, K, src: 'observed' }; }
    }
    const R = Math.sqrt(POOL_K * pSol);
    return { R, T: R / pSol, K: POOL_K, src: 'assumed' };
  }
  const R = Math.sqrt(CURVE_K * pSol);
  return { R, T: R / pSol, K: CURVE_K, src: 'curve' };
}
/* Spend solIn SOL (venue fee taken from it) at market price pSol: tokens received. */
function buyOut(solIn, pSol, stage, liq, at) {
  const f = FEES.feeFor(pSol * SUPPLY, stage, at), fee = solIn * f.rate, net = solIn - fee;
  const r = reserves(pSol, stage, liq), tokens = r.T - r.K / (r.R + net);
  return { tokens, fee, rate: f.rate, feeId: f.id, bounded: f.bounded, avg: solIn / tokens, impact: (net / tokens) / pSol - 1, res: r.src };
}
/* Sell qty tokens at market price pSol: SOL received after the venue fee. */
function sellOut(qty, pSol, stage, liq, at) {
  const r = reserves(pSol, stage, liq), gross = r.R - r.K / (r.T + qty);
  const f = FEES.feeFor(pSol * SUPPLY, stage, at);
  return { sol: gross * (1 - f.rate), gross, fee: gross * f.rate, rate: f.rate, feeId: f.id, bounded: f.bounded, impact: 1 - (gross / qty) / pSol, res: r.src };
}
/* Worst case for qty tokens: on the curve, everyone else has sold (the curve is back to launch plus our tokens); in a pool
   there is no floor. */
function worstOut(qty, stage, at) {
  if (stage !== 'curve') return 0;
  const T = CURVE_VTOK0 - qty;
  if (!(T > 0)) return 0;
  const gross = CURVE_K / T - CURVE_VSOL0;
  return Math.max(0, gross * (1 - FEES.feeFor(CURVE_VSOL0 / T * SUPPLY, 'curve', at).rate));
}
/* Bonding-curve progress 0..1 from a market cap in SOL (85 real SOL completes the curve). */
function curveProgress(mcSol) { const R = Math.sqrt(CURVE_K * mcSol / SUPPLY); return Math.max(0, Math.min(1, (R - CURVE_VSOL0) / 85)); }
/* Lowest market price at which selling qty returns at least targetSol (Infinity if none below 10 SOL/token). */
function priceFor(qty, targetSol, stage, liq, at) {
  let lo = 1e-15, hi = 10;
  if (sellOut(qty, hi, stage, liq, at).sol < targetSol) return Infinity;
  for (let i = 0; i < 90; i++) { const m = Math.sqrt(lo * hi); if (sellOut(qty, m, stage, liq, at).sol >= targetSol) hi = m; else lo = m; }
  return hi;
}
/* Round trip of `stake` SOL bought and sold at the same price, plus fixed costs: what comes back and the price rise needed
   to break even (audit Finding 14). costs: { prioSol, netFeeSol, latency } */
function roundTrip(stake, pSol, stage, liq, at, costs) {
  const c = Object.assign({ prioSol: 0, netFeeSol: 0, latency: 0 }, costs || {});
  const b = buyOut(stake, pSol, stage, liq, at), qty = b.tokens * (1 - c.latency);
  const fixed = 2 * (c.prioSol + c.netFeeSol);
  const back = sellOut(qty, pSol * (1 - c.latency), stage, liq, at).sol - fixed;
  const be = priceFor(qty, stake + fixed, stage, liq, at) / (1 - c.latency);
  return { back, ret: back / stake - 1, qty, breakEvenMove: be / pSol - 1, buyImpact: b.impact };
}
module.exports = { SUPPLY, CURVE_K, CURVE_VSOL0, CURVE_VTOK0, POOL_K, GRAD_MC_SOL, CURVE_FLOOR, reserves, buyOut, sellOut, worstOut, curveProgress, priceFor, roundTrip };
