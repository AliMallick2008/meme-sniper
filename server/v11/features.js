'use strict';
/* MarketSnapshot features and evidence families (audit Findings 04, 05, 07, C4). Everything is computed from what the
   engine had received by `at`: its own price observations (DexScreener, every few seconds), Jupiter token snapshots
   (5-minute rolling stats: buy and sell notional in USD, buys, sells, traders, net buyers, holder change), own 1-minute
   bars, quotes and audits. A family without usable data is `unknown`, never `ok`: a count of transactions is not a cash
   flow, and a missing snapshot is not a quiet market.
   Families (independent evidence, so two of them agreeing is corroboration, not double counting):
     structure  price path: drawdown from the recent high in units of its own volatility, lower highs, failed reclaim
     demand     buy vs sell notional, traders and net buyers, and their trend
     liquidity  sell-quote impact at size and its drift, pool liquidity drift, route failures
     holders    concentration and dev balance changes since entry, holder count change */

function obsAt(k, t, maxAge = 30) {
  let best = null;
  for (const o of k.obs) { if (o[0] > t) break; if (t - o[0] <= maxAge) best = o; }
  return best;
}
function snapAt(k, t, maxAge = 45) {
  let best = null;
  for (const s of k.snaps) { if (s.at > t) break; if (t - s.at <= maxAge) best = s; }
  return best;
}
const share = s => s && s.bv != null && s.sv != null && s.bv + s.sv > 0 ? s.bv / (s.bv + s.sv) : null;

/* All features at time `at` for coin k (with the position if one is held). */
function features(k, at, ctx, pos) {
  const F = { at, m: k.m, stage: k.stage, age: k.t0 ? at - k.t0 : null };
  const p = k.last && at - k.last.at <= 30 ? k.last : null;
  F.usd = p ? p.usd : null; F.sol = p ? p.sol : null; F.mc = p ? p.mc : null; F.pxAge = k.last ? at - k.last.at : null;
  F.prog = p && p.sol ? ctx.MODEL.curveProgress(p.sol * ctx.MODEL.SUPPLY) : null;
  for (const [n, s] of [['ret1', 60], ['ret3', 180], ['ret5', 300], ['ret15', 900]]) { const o = obsAt(k, at - s, 40); F[n] = p && o ? p.usd / o[1] - 1 : null; }
  const win = k.obs.filter(o => o[0] > at - 900 && o[0] <= at);
  if (win.length >= 6) {
    F.hi15 = Math.max(...win.map(o => o[1])); F.lo15 = Math.min(...win.map(o => o[1]));
    F.dd = p ? p.usd / F.hi15 - 1 : null; F.fromLo = p ? p.usd / F.lo15 - 1 : null;
    // volatility: std of 30 s log returns over the window
    const rs = []; let last = null;
    for (const o of win) { if (!last || o[0] - last[0] >= 30) { if (last) rs.push(Math.log(o[1] / last[1])); last = o; } }
    if (rs.length >= 4) { const m = rs.reduce((a, b) => a + b, 0) / rs.length; F.vol = Math.sqrt(rs.reduce((a, b) => a + (b - m) ** 2, 0) / rs.length); }
    F.mean15 = win.reduce((a, o) => a + o[1], 0) / win.length;
  }
  // own 1-minute bars (complete only): lower highs and reclaim of the previous bar's high
  const bars = k.bars.filter(b => b[0] + 60 <= at).slice(-5);
  F.bars = bars.length;
  if (bars.length >= 3) {
    let lh = 0; for (let i = 1; i < bars.length; i++) if (bars[i][2] < bars[i - 1][2]) lh++;
    F.lowerHighs = lh;
    const b = bars[bars.length - 1], prev = bars[bars.length - 2];
    F.lastGreen = b[4] > b[1]; F.reclaim = b[4] > prev[2];
  }
  // demand: Jupiter's 5-minute window, now and about 3 minutes earlier
  const s = snapAt(k, at), s0 = snapAt(k, at - 180, 60);
  F.snapAge = s ? at - s.at : null;
  if (s && s.s5) {
    const x = s.s5;
    F.buyShare = share(x); F.bv = x.bv; F.sv = x.sv;
    F.netPct = x.bv != null && x.sv != null && s.mc > 0 ? (x.bv - x.sv) / s.mc : null;
    F.traders = x.nt; F.netBuyers = x.nnb; F.holderChg = x.hc;
    if (s0 && s0.s5 && s0 !== s) { F.dTraders = x.nt != null && s0.s5.nt != null ? x.nt - s0.s5.nt : null; const b0 = share(s0.s5); F.dShare = F.buyShare != null && b0 != null ? F.buyShare - b0 : null; }
    F.holders = s.holders; F.liqUsd = s.liq;
  }
  const fl = k.flow.length ? k.flow[k.flow.length - 1] : null;
  if (fl && at - fl[0] <= 30) { F.b5 = fl[1]; F.s5 = fl[2]; F.v5 = fl[3]; F.poolLiq = fl[4]; }
  const fl0 = k.flow.find(f => f[0] >= at - 330 && f[0] <= at - 270);
  if (F.poolLiq != null && fl0 && fl0[4] > 0) F.liqChg5 = F.poolLiq / fl0[4] - 1;
  // sellability: the latest sell quote
  if (k.sq) { F.sqAge = at - k.sq.at; F.sqImpact = k.sq.impact; }
  F.sqFails = k.sqFails || 0;
  if (pos) { F.posAge = at - pos.fillAt; F.markRet = pos.mark && pos.mark.v != null ? pos.mark.v / pos.cost - 1 : null; }
  return F;
}

/* Evidence families for a held position (or a candidate when pos is null). */
function families(F, k, pos, P = {}) {
  const T = Object.assign({ ddVol: 2, ddMin: 0.12, ddMax: 0.25, lostEntry: 0.05, shareBad: 0.42, shareOk: 0.55, netBad: -0.004, impactRise: 2, impactBad: 0.15, liqDrop: -0.3, topRise: 5 }, P);
  const out = [];
  // structure
  if (F.usd == null || F.dd == null) out.push({ f: 'structure', v: 'unknown', why: 'not enough recent prices' });
  else {
    // deep: under the 15-min high by more than its usual 5-min swing (2 sigma, between 12% and 25%); for a held coin,
    // falling back under the price it was bought at is a broken setup too
    const thr = Math.min(T.ddMax, Math.max(T.ddMin, (F.vol || 0) * T.ddVol * Math.sqrt(10)));
    const lost = !!(pos && F.sol && pos.mkt && F.sol < pos.mkt * (1 - T.lostEntry));
    const deep = F.dd <= -thr || lost;
    const failing = (F.lowerHighs != null && F.lowerHighs >= 3) || (F.reclaim === false && F.ret3 != null && F.ret3 < 0);
    out.push(deep && failing ? { f: 'structure', v: 'bad', why: `${(F.dd * 100).toFixed(0)}% off the 15-min high${lost ? ', under its entry' : ''}, ${F.lowerHighs} lower highs, no reclaim` }
      : deep || failing ? { f: 'structure', v: 'weak', why: deep ? `${(F.dd * 100).toFixed(0)}% off the 15-min high` : 'lower highs / no reclaim' }
        : { f: 'structure', v: 'ok', why: 'holding its structure' });
  }
  // demand (needs notional by side)
  if (F.buyShare == null || F.netPct == null) out.push({ f: 'demand', v: 'unknown', why: F.snapAge == null ? 'no recent Jupiter snapshot' : 'no buy/sell notional' });
  else {
    // holder count change is flow evidence too (wallets leaving), so it lives here, not in the holders family
    const fading = (F.dTraders != null && F.dTraders < 0) || (F.dShare != null && F.dShare < -0.05) || (F.holderChg != null && F.holders > 0 && F.holderChg / F.holders < -0.03);
    if (F.buyShare <= T.shareBad && F.netPct <= T.netBad && fading) out.push({ f: 'demand', v: 'bad', why: `sellers ${(100 - F.buyShare * 100).toFixed(0)}% of 5-min volume, net ${(F.netPct * 100).toFixed(2)}% of market cap, traders ${F.dTraders != null ? (F.dTraders >= 0 ? '+' : '') + F.dTraders : '?'}` });
    else if (F.buyShare < T.shareOk || F.netPct < 0) out.push({ f: 'demand', v: 'weak', why: `buy share ${(F.buyShare * 100).toFixed(0)}%` });
    else out.push({ f: 'demand', v: 'ok', why: `buy share ${(F.buyShare * 100).toFixed(0)}%, net +${(F.netPct * 100).toFixed(2)}% of market cap` });
  }
  // liquidity / sellability
  if (pos) {
    const imp0 = pos.impact != null ? Math.max(0.005, pos.impact) : null;
    if (F.sqFails >= 1 && (F.sqAge == null || F.sqAge > 120)) out.push({ f: 'liquidity', v: 'bad', why: 'sell quotes failing' });
    else if (F.sqImpact != null && (F.sqImpact >= T.impactBad || (imp0 && F.sqImpact > imp0 * T.impactRise && F.sqImpact > 0.04))) out.push({ f: 'liquidity', v: 'bad', why: `sell impact ${(F.sqImpact * 100).toFixed(1)}% at full size` });
    else if (F.liqChg5 != null && F.liqChg5 <= T.liqDrop) out.push({ f: 'liquidity', v: 'bad', why: `pool liquidity ${(F.liqChg5 * 100).toFixed(0)}% in 5 min` });
    else if (F.sqImpact == null && F.liqChg5 == null) out.push({ f: 'liquidity', v: 'unknown', why: 'no sell quote yet' });
    else out.push({ f: 'liquidity', v: 'ok', why: F.sqImpact != null ? `sell impact ${(F.sqImpact * 100).toFixed(1)}%` : 'pool steady' });
  }
  // holders: concentration and dev balance changes since the first audit (who owns it, not who is trading it)
  const a0 = k.audit, a1 = k.auditLast;
  if (!a0 || !a1 || a1 === a0 || a1.top == null || a0.top == null) out.push({ f: 'holders', v: 'unknown', why: 'no audit re-check yet' });
  else {
    const dTop = a1.top - a0.top, dDev = a1.dev != null && a0.dev != null ? a1.dev - a0.dev : null;
    if (dTop >= T.topRise) out.push({ f: 'holders', v: 'bad', why: `top holders ${dTop >= 0 ? '+' : ''}${dTop.toFixed(1)} pts of supply since entry` });
    else if (dDev != null && dDev < -2) out.push({ f: 'holders', v: 'weak', why: `dev sold ${(-dDev).toFixed(1)} pts of supply` });
    else out.push({ f: 'holders', v: 'ok', why: `top holders ${dTop >= 0 ? '+' : ''}${dTop.toFixed(1)} pts` });
  }
  return out;
}

/* One of these alone is enough to leave (verified, not inferred): an authority turned back on, a new RugCheck danger,
   the dev wallet dumping, or the exit route collapsing. */
function emergency(k, pos, F) {
  const a0 = k.audit, a1 = k.auditLast;
  if (a1 && a1 !== a0) {
    if (a1.mintOff === false && a0 && a0.mintOff === true) return 'mint authority turned back on';
    if (a1.freezeOff === false && a0 && a0.freezeOff === true) return 'freeze authority turned back on';
    if (a1.dev != null && a0 && a0.dev != null && a0.dev - a1.dev >= 5) return `dev wallet sold ${(a0.dev - a1.dev).toFixed(1)}% of supply`;
  }
  if (k.rcLast && k.rc && k.rcLast !== k.rc && k.rcLast.danger && k.rcLast.danger.length > (k.rc.danger || []).length) return 'new RugCheck danger: ' + k.rcLast.danger[k.rcLast.danger.length - 1];
  if (F.sqImpact != null && F.sqImpact >= 0.25) return `selling now would move the price ${(F.sqImpact * 100).toFixed(0)}%`;
  if (F.liqChg5 != null && F.liqChg5 <= -0.5) return `pool liquidity fell ${(-F.liqChg5 * 100).toFixed(0)}% in 5 minutes`;
  return null;
}
/* Compact copy of the features for the decision record. */
function brief(F) {
  const o = {};
  for (const k of ['age', 'mc', 'ret1', 'ret3', 'ret5', 'ret15', 'dd', 'fromLo', 'vol', 'lowerHighs', 'reclaim', 'buyShare', 'netPct', 'traders', 'dTraders', 'dShare', 'netBuyers', 'holders', 'holderChg', 'b5', 's5', 'poolLiq', 'liqChg5', 'sqImpact', 'snapAge', 'prog'])
    if (F[k] != null) o[k] = typeof F[k] === 'number' ? +F[k].toPrecision(4) : F[k];
  return o;
}
module.exports = { features, families, emergency, brief, obsAt, snapAt };
