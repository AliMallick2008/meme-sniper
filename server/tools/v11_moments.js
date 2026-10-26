'use strict';
/* The v4 research dataset (research/v4_protocol.md): every moment at which a coin passes v2.0 A's gates, timely data,
   setup and demand checks while its trade tape is live (at most one per coin per 2 minutes), its tape features at that
   moment (only data received before it), and the outcome of a fixed exit rule replayed on the coin's later curve states.
     node server/tools/v11_moments.js <dir> [--from 2026-10-22T16:00Z] [--to ...] [--out moments.jsonl]
   <dir> holds v11-inputs/ (research branch checkout). Prints counts only; analysis follows the protocol's split. */
const fs = require('fs');
const path = require('path');
const REC = require('../v11/record.js');
const V2 = require('../v11/v2.js');
const G = require('../v11/gates.js');
const FT = require('../v11/features.js');
const TS = require('../v11/tapestate.js');
const FEES = require('../v11/fees.js');
const { createEngine } = require('../v11/engine.js');
const { files } = require('./v11_replay.js');

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const VT0 = 1.073e9, VIRT = 279.9e6, REAL0 = 793.1e6;   // tokens: virtual at launch, virtual-only, sold by completion
const P_A = V2.STRATS.A.P, GAP_MS = 120000, FILL_MS = 2000;
const RULE = { take: 1.0, stop: 0.15, horizonMs: 20 * 60000 };   // +100% / -15% on the curve value / 20 minutes

// tape features at `at` from what c.tp holds (trades received by then)
function tapeFeatures(c, at) {
  const t = c.tp, f30 = TS.features(c, at, 30000), f60 = TS.features(c, at, 60000), f180 = TS.features(c, at, 180000);
  const vol = new Map(); let big60 = 0;
  for (const x of t.tr) {
    if (x[0] > at) break;
    vol.set(x[5], (vol.get(x[5]) || 0) + x[3] / 1e6);
    if (!x[2] && at - x[0] <= 60000 && x[3] / 1e6 >= 1) big60++;
  }
  const tot = [...vol.values()].reduce((a, b) => a + b, 0), top3 = [...vol.values()].sort((a, b) => b - a).slice(0, 3).reduce((a, b) => a + b, 0);
  const st = t.last;
  return {
    n30: f30.n, nb30: f30.nb, ns30: f30.ns, buyers30: f30.buyers, buyShare30: f30.buySol + f30.sellSol > 0 ? f30.buySol / (f30.buySol + f30.sellSol) : null, ret30: f30.ret,
    n60: f60.n, buyers60: f60.buyers, sellers60: f60.sellers, buySol60: f60.buySol, sellSol60: f60.sellSol, buyShare60: f60.buySol + f60.sellSol > 0 ? f60.buySol / (f60.buySol + f60.sellSol) : null,
    topBuyShare60: f60.topBuyShare, maxSell60: f60.maxSell, bigSells60: big60, ret60: f60.ret, ret180: f180.ret,
    top3Share: tot > 0 ? top3 / tot : null, wallets: vol.size, tapeMin: (at - t.first) / 60000,
    crSold: t.crSold / 1e6, crSoldAny: t.crSold > 0,
    vSol0: st ? (st.vs / 1e6) * st.vt / VT0 : null, progress: st ? 1 - (st.vt - VIRT) / REAL0 : null, ps: st ? st.ps : null,
  };
}

/* outcome of a 1 SOL buy on the curve at moment + 2 s, sold by RULE on later curve states (each sale filled at the state
   2 s after the decision, as v3), with the pump.fun fee, 0.5% drift each way and network fees */
function outcome(series, at) {
  const fee = 0.0125, drift = FEES.COSTS.landingDrift, net = FEES.COSTS.networkFeeSol;
  const stateAt = t => { let s = null; for (const x of series) { if (x[0] > t) break; s = x; } return s; };
  const s0 = stateAt(at + FILL_MS); if (!s0) return null;
  const st = x => ({ vs: x[1], vt: x[2] });
  const tokens = TS.curveBuy(st(s0), 1, fee).tokens * (1 - drift), cost = 1 + net;
  const value = x => TS.curveSell(st(x), tokens, fee).sol * (1 - drift) - net;
  let best = -Infinity, worst = Infinity, rug = false, exit = null;
  const p0 = s0[1] / s0[2];
  for (const x of series) {
    if (x[0] <= at + FILL_MS) continue;
    if (x[0] > at + FILL_MS + RULE.horizonMs) break;
    const r = value(x) / cost - 1;
    best = Math.max(best, r); worst = Math.min(worst, r);
    if (x[0] <= at + FILL_MS + 300000 && x[1] / x[2] <= 0.5 * p0) rug = true;
    if (!exit && (r >= RULE.take || r <= -RULE.stop)) { const f = stateAt(x[0] + FILL_MS); exit = { why: r >= RULE.take ? 'take' : 'stop', at: x[0], ret: value(f) / cost - 1 }; }
    if (x[3]) { if (!exit) exit = { why: 'graduated', at: x[0], ret: r }; break; }
  }
  if (!exit) { const f = stateAt(at + FILL_MS + RULE.horizonMs); exit = { why: 'time', at: at + FILL_MS + RULE.horizonMs, ret: f ? value(f) / cost - 1 : null }; }
  return { ret: exit.ret, why: exit.why, holdS: (exit.at - at) / 1000, best: isFinite(best) ? best : null, worst: isFinite(worst) ? worst : null, rug };
}

function build(dir, { from = 0, to = Infinity } = {}) {
  const list = files(path.join(dir, 'v11-inputs'));
  let eng = null;
  const series = new Map(), moments = [], last = new Map();
  for (const it of REC.decode(list.map(f => fs.readFileSync(f)))) {
    const at = it.k === 'event' ? it.ev.at : it.at;
    if (it.k === 'load') {
      // one continuous engine from the last run start before `from`; no accounts (nothing trades)
      if (!eng && it.state && it.state.accts && (it.at >= from - 6 * 3600e3)) { eng = createEngine({ accounts: () => [] }); eng.load(REC.unpack(REC.roundTrip(it.state))); eng.state().accts = {}; }
      continue;
    }
    if (!eng) continue;
    if (at > to + RULE.horizonMs + 60000) break;
    if (it.k === 'event') {
      const ev = it.ev;
      if (ev.type === 'quote') continue;
      try { eng.ingest(ev); } catch (e) { /* as live */ }
      if ((ev.type === 'tape' || ev.type === 'curve') && (ev.vs > 0 || ev.done)) {
        const s = series.get(ev.m) || (series.set(ev.m, []), series.get(ev.m));
        const prev = s[s.length - 1];
        s.push([ev.at, ev.vs > 0 ? ev.vs : prev ? prev[1] : 0, ev.vt > 0 ? ev.vt : prev ? prev[2] : 1, ev.done ? 1 : 0]);   // vs in micro-SOL, vt in tokens (tapestate units)
      }
    } else if (it.k === 'tick') {
      try { eng.tick(it.at); } catch (e) { /* as live */ }
      eng.drain();
      if (it.at < from || it.at > to) continue;
      const S = eng.state();
      for (const c of Object.values(S.coins)) {
        if (c.deadAt || !TS.live(S, c) || !V2.universe('A', c, it.at)) continue;
        if (it.at - (last.get(c.m) || -Infinity) < GAP_MS) continue;
        if (V2.gates(c, V2.GATES).some(g => g.status !== G.P && g.status !== G.NA)) continue;
        const f = FT.features(c, it.at);
        if (f.p == null || f.priceAge > V2.COMMON.priceFreshMs) continue;
        const ev = V2.evaluate('A', c, f, it.at, P_A);
        if (!ev.setup.every(x => x.ok)) continue;
        if (f.jupAge == null || f.jupAge > V2.COMMON.jupFreshMs || !ev.demand.every(x => x.ok)) continue;
        last.set(c.m, it.at);
        moments.push({ at: it.at, m: c.m, sym: c.sym, sinceCrossMin: (it.at - c.xAt) / 60000, mc: f.mc, r1: f.r1, r3: f.r3, buyShare5: f.buyShare5, netBuyers5: f.netBuyers5, traders5: f.traders5,
          tape: tapeFeatures(c, it.at) });
      }
    }
  }
  for (const x of moments) x.out = outcome(series.get(x.m) || [], x.at);
  return moments;
}

if (require.main === module) {
  const dir = process.argv[2];
  const from = arg('from') ? Date.parse(arg('from')) : Date.parse('2026-10-22T16:00:00Z'), to = arg('to') ? Date.parse(arg('to')) : Infinity;
  const t0 = Date.now();
  const ms = build(dir, { from, to });
  const done = ms.filter(x => x.out && x.out.ret != null);
  console.log(`${ms.length} moments (${new Set(ms.map(x => x.m)).size} coins) from ${new Date(from).toISOString()}, ${done.length} with an outcome, built in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  if (arg('out')) fs.writeFileSync(arg('out'), ms.map(x => JSON.stringify(x)).join('\n') + '\n');
}
module.exports = { build, tapeFeatures, outcome, RULE };
