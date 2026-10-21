'use strict';
/* Venue fees and per-swap costs for the v11 paper engine. Fee tables are versioned by the date they took effect, so a
   trade always records the schedule it was costed with. Source: https://pump.fun/docs/fees (last updated 17 Oct 2026). */

const SCHEDULES = [{
  id: 'pumpfun-2026-10-17',
  effective: Date.UTC(2026, 9, 17) / 1000,
  source: 'https://pump.fun/docs/fees (last updated 17 October 2026)',
  curve: 0.0125,                               // bonding curve, SOL coins: protocol 0.95% + creator 0.30%
  // PumpSwap canonical pool, SOL coins: [market cap in SOL below which the tier applies, total fee]
  pool: [[420, 0.0125], [1470, 0.012], [2460, 0.0115], [3440, 0.011], [4420, 0.0105], [9820, 0.01], [14740, 0.0095],
    [19650, 0.009], [24560, 0.0085], [29470, 0.008], [34380, 0.0075], [39300, 0.007], [44210, 0.0065], [49120, 0.006],
    [54030, 0.0055], [58940, 0.00525], [63860, 0.005], [68770, 0.00475], [73681, 0.0045], [78590, 0.00425],
    [83500, 0.004], [88400, 0.00375], [93330, 0.0035], [98240, 0.00325], [Infinity, 0.003]],
  graduationFeeSol: 0.015,
}];

// Costs outside the venue fee, per swap. Assumptions, not measurements: they are shown with every trade and swept in
// the sensitivity tests.
const COSTS = {
  networkFeeSol: 0.000005 + 0.0001,   // base signature fee + a modest priority fee
  ataRentSol: 0.00203928,             // token account rent, paid on the first buy, refunded when the account closes
  landingDrift: 0.005,                // price moves against the order between the quote and landing (0.5%)
};

function schedule(at) {
  let s = SCHEDULES[0];
  for (const x of SCHEDULES) if (x.effective <= at) s = x;
  return s;
}
function feeRate(at, venue, mcSol) {
  const s = schedule(at);
  if (venue !== 'pool') return s.curve;
  for (const [lim, f] of s.pool) if (mcSol < lim) return f;
  return s.pool[s.pool.length - 1][1];
}
module.exports = { SCHEDULES, COSTS, schedule, feeRate };
