'use strict';
/* Market features for v11 decisions, computed only from what a coin's record holds at time `at` (all observations
   were received at or before `at`). Every feature is a number or null: null means unknown, never zero. Each family
   carries its own data age, so a decision can refuse stale evidence. Families (audit C4): structure, demand,
   liquidity, holders, lifecycle. Social evidence lives in narrative.js and is unavailable without an approved API. */
const E = require('../sniper.js');
const MK = require('./market.js');

const nn = v => (typeof v === 'number' && isFinite(v) ? v : null);
const ratio = (a, b) => (nn(a) != null && nn(b) != null && a + b > 0 ? a / (a + b) : null);

const priceAt = MK.priceAt;   // from observations received at or before t (snapshots, else completed bars)
function features(c, at) {
  const f = { at, m: c.m };
  const last = MK.fresh(c, at, 20000);
  f.p = last ? last.p : null; f.ps = last ? last.ps : null; f.priceAge = c.last ? at - c.last.at : null;
  f.mc = last ? (last.mc || last.p * E.SUPPLY) : null;
  // structure (from observed prices and this server's own completed 1-minute bars)
  const bars = MK.doneBars(c, at);
  f.hi = c.hi ? c.hi.p : null; f.hiAt = c.hi ? c.hi.at : null;
  f.dd = f.p != null && f.hi ? 1 - f.p / f.hi : null;                       // drawdown from the high seen so far
  // the lowest price since the high (tracked as observations arrive, so it survives restarts)
  f.lowSinceHi = c.lo && c.lo.at <= at ? c.lo.p : null;
  f.lowSinceHiAt = c.lo && c.lo.at <= at ? c.lo.at : null;
  f.bounce = f.p != null && f.lowSinceHi ? f.p / f.lowSinceHi - 1 : null;     // recovery from the low after the high
  for (const [k, ms] of [['r1', 60000], ['r3', 180000], ['r5', 300000], ['r15', 900000]]) { const p0 = priceAt(c, at - ms); f[k] = f.p != null && p0 ? f.p / p0 - 1 : null; }
  const lb = bars.slice(-3);
  f.lastBar = lb.length ? lb[lb.length - 1] : null;
  f.greenBar = f.lastBar ? f.lastBar.c > f.lastBar.o : null;
  f.higherLow = lb.length >= 2 ? lb[lb.length - 1].l > lb[lb.length - 2].l : null;
  f.lowerHighs = lb.length >= 3 ? (lb[2].h < lb[1].h && lb[1].h < lb[0].h) : null;
  const rets = bars.slice(-10).map((b, i, a) => (i ? b.c / a[i - 1].c - 1 : null)).filter(x => x != null);
  f.vol = rets.length >= 4 ? Math.sqrt(rets.reduce((s, r) => s + r * r, 0) / rets.length) : null;
  const b15 = bars.filter(b => (b.t + 60) * 1000 > at - 900000);
  f.avg15 = b15.length >= 5 ? b15.reduce((s, b) => s + b.c, 0) / b15.length : null;
  f.low15 = b15.length ? Math.min(...b15.map(b => b.l)) : null;
  // demand (Jupiter 5-minute and 1-hour windows: notional by side, traders, net buyers)
  const j = c.jup && at - c.jup.at <= 60000 ? c.jup : null;
  f.jupAge = c.jup ? at - c.jup.at : null;
  f.jupAsOfAge = c.jup && c.jup.asOf ? at - c.jup.asOf : null;   // how old Jupiter's own numbers were (its updatedAt)
  const st = j && j.st ? j.st : {}, s1 = j && j.st1h ? j.st1h : {};
  f.buyVol5 = nn(st.bv); f.sellVol5 = nn(st.sv); f.buyShare5 = ratio(st.bv, st.sv);
  f.netFlow5 = f.buyVol5 != null && f.sellVol5 != null ? f.buyVol5 - f.sellVol5 : null;
  f.traders5 = nn(st.tr); f.netBuyers5 = nn(st.nnb); f.organic5 = nn(st.nob); f.buys5 = nn(st.nb); f.sells5 = nn(st.ns);
  f.organicBuyShare5 = ratio(st.bov, st.sov);     // share of Jupiter's "organic" volume that was buys (unknown when either side is missing)
  f.buyShare1h = ratio(s1.bv, s1.sv); f.netBuyers1h = nn(s1.nnb);
  // the previous Jupiter snapshot: is selling easing or building?
  const js = c.snaps.filter(s => s.src === 'jup' && s.valid !== false && s.at <= at && s.st);
  const prev = js.length >= 2 ? js[js.length - 2] : null;
  f.sellVolPrev5 = prev ? nn(prev.st.sv) : null; f.buySharePrev5 = prev ? ratio(prev.st.bv, prev.st.sv) : null; f.tradersPrev5 = prev ? nn(prev.st.tr) : null;
  // selling has eased: the 5-minute sell volume is at most 75% of the heaviest reading since the high
  f.sellPeak5 = c.svPk && c.hi && c.svPk.since === c.hi.at && c.svPk.at <= at ? c.svPk.v : null;
  f.sellEasing = f.sellVol5 != null && f.sellPeak5 > 0 ? f.sellVol5 <= 0.75 * f.sellPeak5 : null;
  // liquidity and holders
  f.liqUsd = j ? nn(j.liqUsd) : null;
  const liqPrev = js.length >= 4 ? nn(js[js.length - 4].liqUsd) : null;
  f.liqChange = f.liqUsd != null && liqPrev ? f.liqUsd / liqPrev - 1 : null;
  f.holders = j ? nn(j.holders) : null; f.holderChangePct5 = nn(st.hc);     // percent change in holders over 5 minutes
  // lifecycle
  f.ageMin = c.t0 ? (at / 1000 - c.t0) / 60 : null;
  f.sinceCrossMin = (at - c.xAt) / 60000;
  f.stage = c.stage;
  f.curveProgress = f.ps ? E.curveProgress(f.ps * E.SUPPLY) : null;
  f.mcX = c.mcX;
  return f;
}
module.exports = { features, priceAt };
