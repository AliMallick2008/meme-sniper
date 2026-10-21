'use strict';
/* Invariants every v11 state must satisfy (Phase 1 exit criterion: every paper trade is justified by data known at or
   before its submission, nothing is booked for time the server was not running, and the books add up).
   Returns a list of violations (empty = fine). Used by the tests, the simulator check and the report. */
function check(S, C = {}) {
  const out = [], eps = 1e-9, startSol = C.startSol || 10;
  const inGap = t => S.gaps.find(g => t > g.from && t < g.to);
  for (const A of Object.values(S.accts)) {
    const items = A.trades.map(t => ['trade', t]).concat(A.pos ? [['open', A.pos]] : []);
    for (const [kind, t] of items) {
      const id = `${A.id} ${kind} ${t.sym} ${t.id}`;
      if (t.sigAt != null && t.sigAt > t.at + eps) out.push(`${id}: signal after the decision`);
      if (!(t.quoteReq >= t.at - eps)) out.push(`${id}: entry quote requested before the decision`);
      if (!(t.quoteAt >= t.quoteReq - eps)) out.push(`${id}: entry quote received before it was requested`);
      if (t.snap && t.snap.eligibleAt != null && t.sigAt != null && t.sigAt < t.snap.eligibleAt - eps) out.push(`${id}: signal before the coin was eligible`);
      if (t.snap && t.snap.obsAt != null && t.snap.obsAt > t.at + eps) out.push(`${id}: decision used a later observation`);
      for (const f of ['at', 'quoteAt', 'exitAt', 'exitQuoteAt']) if (t[f] != null && inGap(t[f])) out.push(`${id}: ${f} inside a coverage gap`);
      if (kind === 'trade') {
        if (!(t.exitAt >= t.quoteAt - eps)) out.push(`${id}: exit decided before the entry filled`);
        if (!(t.exitQuoteReq >= t.exitAt - eps)) out.push(`${id}: exit quote requested before the exit decision`);
        if (!(t.exitQuoteAt >= t.exitQuoteReq - eps)) out.push(`${id}: exit quote received before it was requested`);
        if (Math.abs(t.net - (t.proceeds - (t.fees ? t.fees.fixed : 0) - t.stake)) > 1e-6) out.push(`${id}: net does not add up`);
      }
    }
    const realized = A.trades.reduce((s, t) => s + t.net, 0);
    const expect = startSol + realized - (A.pos ? A.pos.cost + A.pos.rent : 0);
    if (Math.abs(A.cash - expect) > 1e-6) out.push(`${A.id}: cash ${A.cash} != start + realized - open cost ${expect}`);
    if (Math.abs(A.rent - (A.pos ? A.pos.rent : 0)) > 1e-9) out.push(`${A.id}: locked rent ${A.rent} without a matching position`);
    if (A.cash < -eps) out.push(`${A.id}: negative cash`);
  }
  return out;
}
module.exports = { check };
