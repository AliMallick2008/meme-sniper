'use strict';
/* Forward results by account from a saved v11 engine state (v11.json on the data branch), with the measures the v3
   protocol asks for (research/v3_protocol.md section 3): how loss-limit exits filled against the limit, how much of the
   peak gain profit protection kept, decision-to-fill delays, rugs.
     node server/tools/v11_compare.js <v11.json> [--since 2026-10-22T16:20Z] [--accts A,A3,A3e,A4,B,B3]
   Paper results; small samples prove nothing (research/*_protocol.md: 30 trades and 5 days before any claim). */
const fs = require('fs');
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const med = a => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; };
const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const pc = v => (v == null ? '   -  ' : ((v >= 0 ? '+' : '') + (v * 100).toFixed(1) + '%').padStart(7));
const f3 = v => (v == null ? '   -  ' : ((v >= 0 ? '+' : '') + v.toFixed(3)).padStart(8));

function summarize(A, since) {
  const tr = A.trades.filter(t => t.decidedAt >= since);
  const wins = tr.filter(t => t.net > 0), gw = wins.reduce((s, t) => s + t.net, 0), gl = -tr.filter(t => t.net <= 0).reduce((s, t) => s + t.net, 0);
  const risk = tr.filter(t => t.exitReason === 'risk'), trail = tr.filter(t => t.exitReason === 'trail');
  const lim = A.P && A.P.maxLoss;
  const by = {}; for (const t of tr) (by[t.exitReason] = by[t.exitReason] || []).push(t.ret);
  return {
    id: A.id, version: A.version || null, n: tr.length, wins: wins.length, net: tr.reduce((s, t) => s + t.net, 0), pf: gl > 0 ? gw / gl : gw > 0 ? Infinity : null,
    avg: mean(tr.map(t => t.ret)), median: med(tr.map(t => t.ret)), best: tr.length ? Math.max(...tr.map(t => t.ret)) : null, worst: tr.length ? Math.min(...tr.map(t => t.ret)) : null,
    rugs: tr.filter(t => t.ret < -0.5).length,
    // loss-limit exits: realized minus the limit (0 = filled exactly at the limit; negative = past it)
    riskN: risk.length, riskAvg: mean(risk.map(t => t.ret)), riskGap: lim ? mean(risk.map(t => t.ret + lim)) : null, riskWorst: risk.length ? Math.min(...risk.map(t => t.ret)) : null,
    // profit protection: share of the best mark's gain that the sale kept
    trailN: trail.length, trailKept: med(trail.filter(t => t.v2 && t.v2.peakRet > 0).map(t => t.ret / t.v2.peakRet)),
    entryDelayS: med(tr.map(t => (t.openAt - t.decidedAt) / 1000)), exitDelayS: med(tr.map(t => (t.closeAt - t.exitDecidedAt) / 1000)),
    curveFills: tr.filter(t => (t.entryRoute || []).some(r => /tape/.test(r))).length,
    exits: Object.fromEntries(Object.entries(by).map(([k, v]) => [k, `${v.length} (${(mean(v) * 100).toFixed(0)}%)`])),
    open: A.pos ? A.pos.sym : null,
  };
}

if (require.main === module) {
  const S = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const since = arg('since') ? Date.parse(arg('since')) : 0;
  const want = arg('accts') ? arg('accts').split(',') : null;
  const rows = Object.values(S.accts).filter(A => A.kind !== 'hold' && (!want || want.includes(A.id))).map(A => summarize(A, since));
  console.log(`v11 accounts, trades decided since ${since ? new Date(since).toISOString() : 'each account started'} (state saved ${new Date(S.lastAt).toISOString()})`);
  console.log('account  ver   trades wins   net SOL    PF     avg  median   worst  rugs | loss limit: n   avg     gap | trail: n kept | delay in/out s | tape fills | exits');
  for (const r of rows) console.log(`${r.id.padEnd(8)} ${String(r.version || '').padEnd(5)} ${String(r.n).padStart(6)} ${String(r.wins).padStart(4)} ${f3(r.net)} ${(r.pf == null ? '-' : r.pf === Infinity ? 'inf' : r.pf.toFixed(2)).padStart(5)} ${pc(r.avg)} ${pc(r.median)} ${pc(r.worst)} ${String(r.rugs).padStart(4)} |` +
    ` ${String(r.riskN).padStart(4)} ${pc(r.riskAvg)} ${pc(r.riskGap)} | ${String(r.trailN).padStart(4)} ${r.trailKept == null ? '  - ' : (r.trailKept * 100).toFixed(0).padStart(3) + '%'} | ${r.entryDelayS == null ? '   -' : r.entryDelayS.toFixed(1).padStart(4)} / ${r.exitDelayS == null ? '  -' : r.exitDelayS.toFixed(1).padStart(4)} | ${String(r.curveFills).padStart(4)} | ${JSON.stringify(r.exits)}${r.open ? ' (open ' + r.open + ')' : ''}`);
  if (S.qc) { const g = S.qc.gaps.map(x => x[1]).sort((a, b) => a - b); console.log(`fill model check: ${S.qc.n} Jupiter quotes vs the curve model, median gap ${(g[g.length >> 1] * 100).toFixed(2)}% (p10 ${(g[Math.floor(g.length * 0.1)] * 100).toFixed(2)}%, p90 ${(g[Math.floor(g.length * 0.9)] * 100).toFixed(2)}%)`); }
}
module.exports = { summarize };
