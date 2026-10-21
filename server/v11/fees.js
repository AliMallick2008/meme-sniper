'use strict';
/* pump.fun trading fees, versioned by effective date (audit Finding 13). The bonding curve charges a flat rate; PumpSwap
   canonical SOL pools charge by the coin's market cap in SOL. Jupiter quotes already include these fees, so v11 fills never
   use this table: it only prices model marks (no fresh quote) and pre-trade cost estimates.
   Not verifiable from the Claude Code session that wrote this (pump.fun blocked by its network policy): the tiers above
   9,820 SOL. The Oct 17 2026 page lists 25 tiers ending at 0.30% from 98,240 SOL; until they are copied in, coins above
   9,820 SOL are priced at the old 0.95% (the higher, conservative end of the known range) and flagged `bounded`. */
const SCHEDULES = [
  {
    id: 'pumpfun-2026-10-legacy-table', from: Date.UTC(2026, 9, 1) / 1000,
    curve: 0.0125,
    pool: [[420, 0.0125], [1470, 0.012], [2460, 0.0115], [3440, 0.011], [4420, 0.0105], [9820, 0.01]],
    above: { rate: 0.0095, lo: 0.003, hi: 0.0095 },
    source: 'legacy v10 table (pump.fun docs, Oct 2026); tiers above 9,820 SOL unverified',
  },
];

function scheduleAt(at) {
  let s = SCHEDULES[0];
  for (const x of SCHEDULES) if (x.from <= at) s = x;
  return s;
}
/* { rate, id, bounded }: fee rate for a swap at market cap mcSol (SOL) on stage 'curve' or 'pool', at time `at`. */
function feeFor(mcSol, stage, at) {
  const s = scheduleAt(at);
  if (stage === 'curve') return { rate: s.curve, id: s.id, bounded: false };
  for (const [lim, f] of s.pool) if (mcSol < lim) return { rate: f, id: s.id, bounded: false };
  return { rate: s.above.rate, id: s.id, bounded: true, lo: s.above.lo, hi: s.above.hi };
}
module.exports = { SCHEDULES, scheduleAt, feeFor };
