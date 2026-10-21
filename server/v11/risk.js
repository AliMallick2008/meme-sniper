'use strict';
/* Pre-trade risk checks for v11 strategies. A trade is only allowed when its exit plan can actually execute: a stop the
   venue can never reach is rejected (or replaced by an explicit plan without it), the loss at the invalidation level
   must fit the risk budget, and the size must fit the quoted depth. */
const E = require('../sniper.js');
const X = require('./model.js');

/* plan: { venue, ps (entry spot SOL/token), size (SOL), stopPs (invalidation price, SOL/token, or null), horizonMs,
           riskBudget (max SOL loss), at }
   returns { ok, reason, plan } where plan may be converted (stop removed, horizon capped) when that is still sound */
function checkPlan(plan) {
  const out = Object.assign({}, plan);
  const qty = X.buyOut(plan.size, plan.ps, plan.venue, plan.at).tokens;
  const cost = plan.size;
  if (!(plan.horizonMs > 0)) return { ok: false, reason: 'no finite horizon: every position needs a time-to-live' };
  if (plan.stopPs != null && plan.venue === 'curve' && plan.stopPs < E.CURVE_FLOOR * 1.0001) {
    // on the bonding curve the price cannot go under the launch price, so this stop can never trigger
    if (!plan.allowConvert) return { ok: false, reason: `stop at ${(plan.stopPs / plan.ps * 100).toFixed(0)}% of the entry is under the curve floor: it can never trigger` };
    out.stopPs = null; out.converted = 'stop removed (unreachable on the curve); horizon and thesis exits carry the risk';
    out.horizonMs = Math.min(plan.horizonMs, 30 * 60000);
  }
  // worst realistic loss: at the stop if it is reachable, else at the curve floor (curve) or 80% down (pool)
  const worstPs = out.stopPs != null ? out.stopPs : plan.venue === 'curve' ? E.CURVE_FLOOR : plan.ps * 0.2;
  const worst = X.sellOut(qty, worstPs, plan.venue, plan.at).sol;
  out.maxLoss = cost - worst;
  if (plan.riskBudget != null && out.maxLoss > plan.riskBudget) {
    return { ok: false, reason: `loss at the exit plan's worst level (${out.maxLoss.toFixed(3)} SOL) exceeds the risk budget (${plan.riskBudget.toFixed(3)} SOL)`, plan: out };
  }
  // the round trip at an unchanged price: what the coin must move just to break even
  const back = X.sellOut(qty, plan.ps, plan.venue, plan.at).sol;
  out.roundTripCost = 1 - back / cost;
  return { ok: true, plan: out };
}
// largest stake (from a list of candidates) whose loss at the worst level fits the budget
function sizeForBudget(base, sizes) {
  for (const s of sizes) { const r = checkPlan(Object.assign({}, base, { size: s })); if (r.ok) return { size: s, check: r }; }
  return null;
}
module.exports = { checkPlan, sizeForBudget };
