'use strict';
/* Pre-trade plan for the v11 strategies (audit Findings 03, 14, 17, C3, C6): how much to buy given the depth it would
   hit, what a round trip costs at that size and the price rise needed to break even, a protective level that can
   actually trigger (or, on the bonding curve below the floor, the curve's worst case instead), the worst loss, and
   whether all of that fits the position's risk budget. The answer is often a smaller size, or no trade. */
const MODEL = require('./model.js');

const DEF = {
  minStake: 0.1,        // below this a trade is not worth its fixed costs
  maxImpact: 0.06,      // modeled buy impact at the chosen size
  riskBudget: 0.30,     // SOL a position may lose at its protective level (or worst case), exit costs included
  stopGap: 0.15,        // a stop in a thin market fills this much below its level (assumed, sweepable)
  maxBreakEven: 0.12,   // a setup needing more than this rise just to break even is rejected
};

/* o: { pSol, stage ('curve'|'pool'), liq, at, stake, stopFrac (fraction under the entry, or null), costs: { prioSol,
   netFeeSol, latency, rentSol } } plus overrides of DEF. Returns { ok, why, stake, qty, impact, rt, be, stopPx, stopNote,
   worstLoss, notes } */
function plan(o) {
  const P = Object.assign({}, DEF, o);
  const c = Object.assign({ prioSol: 0, netFeeSol: 0, latency: 0 }, o.costs || {});
  const notes = [];
  if (o.stage === 'migrating') return { ok: false, why: 'graduating: no entries until the pool is confirmed', notes };
  let stake = Math.max(0, o.stake);
  // 1. depth: halve the size until the modeled impact fits
  let b = MODEL.buyOut(stake, o.pSol, o.stage, o.liq, o.at);
  while (b.impact > P.maxImpact && stake / 2 >= P.minStake) { stake /= 2; b = MODEL.buyOut(stake, o.pSol, o.stage, o.liq, o.at); }
  if (stake < o.stake) notes.push(`size cut to ${stake.toFixed(2)} SOL: ${(MODEL.buyOut(o.stake, o.pSol, o.stage, o.liq, o.at).impact * 100).toFixed(1)}% impact at ${o.stake} SOL`);
  if (b.impact > P.maxImpact) return { ok: false, why: `too thin: ${(b.impact * 100).toFixed(1)}% impact even at ${stake.toFixed(2)} SOL`, stake, impact: b.impact, notes };
  // 2. round trip and break-even
  const fixed = c.prioSol + c.netFeeSol;
  const evalAt = s => {
    const bb = MODEL.buyOut(s, o.pSol, o.stage, o.liq, o.at), qty = bb.tokens * (1 - c.latency), cost = s + fixed;
    const rt = MODEL.roundTrip(s, o.pSol, o.stage, o.liq, o.at, c);
    // 3. protective level: a price stop that the market can reach, else the curve worst case
    let stopPx = null, stopNote = null, lossAtStop;
    if (o.stopFrac != null) {
      const px = o.pSol * (1 - o.stopFrac);
      if (o.stage === 'curve' && px <= MODEL.CURVE_FLOOR * 1.02) stopNote = `stop ${(o.stopFrac * 100).toFixed(0)}% under the entry is below the curve floor: replaced by the curve worst case and the time limit`;
      else { stopPx = px; lossAtStop = cost - (MODEL.sellOut(qty, px * (1 - P.stopGap), o.stage, o.liq, o.at).sol * (1 - c.latency) - fixed); }
    }
    const worst = o.stage === 'curve' ? cost - (MODEL.worstOut(qty, 'curve', o.at) * (1 - c.latency) - fixed) : cost;
    const loss = lossAtStop != null ? lossAtStop : worst;
    return { qty, cost, rt, stopPx, stopNote, loss, worst, impact: bb.impact };
  };
  let e = evalAt(stake);
  // 4. risk budget: shrink until the loss at the protective level fits
  while (e.loss > P.riskBudget && stake / 2 >= P.minStake) { stake /= 2; e = evalAt(stake); }
  if (e.loss > P.riskBudget) return { ok: false, why: `loss at the protective level ${e.loss.toFixed(3)} SOL is over the ${P.riskBudget} SOL budget even at ${stake.toFixed(2)} SOL`, stake, notes };
  if (e.stopNote) notes.push(e.stopNote);
  if (e.rt.breakEvenMove > P.maxBreakEven) return { ok: false, why: `needs a ${(e.rt.breakEvenMove * 100).toFixed(1)}% rise just to break even`, stake, rt: e.rt, notes };
  return { ok: true, stake, qty: e.qty, cost: e.cost, impact: e.impact, rt: e.rt.ret, be: e.rt.breakEvenMove, stopPx: e.stopPx, stopNote: e.stopNote, worstLoss: e.worst, lossAtStop: e.loss, notes };
}
module.exports = { plan, DEF };
