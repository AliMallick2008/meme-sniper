'use strict';
/* V2 strategies (audit C2/C3): three separate hypotheses that compete, each with its own account, rules and report.
     A  Launch Momentum: very young curve coins with a live move and broad, organic buying
     B  Confirmed Pullback Recovery: after a strong move and a controlled pullback, only once selling has eased and
        buying returns (a raw dip is never enough)
     C  Post-Graduation Momentum: coins trading on their PumpSwap pool with real liquidity and a sustained trend
   "No trade" is always allowed and is often the answer: HOLD (in strategies.js) is the cash baseline.

   Every entry passes the gate sequence identity -> safety -> timely data -> structure -> demand -> cost after fees ->
   risk sizing -> capital, ranks all qualifying coins at the same decision time, and writes an entry contract (what was
   known and when, what confirmed the setup, the plan, the alternatives). Positions are reviewed by thesis.js.
   Rules are locked at LOCKED (research/v2_protocol.md). A change is a new version beside this one, never an edit. */
const E = require('../sniper.js');
const MK = require('./market.js');
const G = require('./gates.js');
const X = require('./model.js');
const R = require('./risk.js');
const FEES = require('./fees.js');
const FT = require('./features.js');
const TH = require('./thesis.js');

const VERSION = 'v2.0';
const LOCKED = Date.UTC(2026, 9, 21, 16, 0, 0);    // Wed Oct 21 2026, 12:00 PM ET (research/v2_protocol.md)
const GATES = { devMax: 10, topMax: 30 };          // the legacy thresholds, but unknown is never a pass
const COMMON = { stake: 1, riskBudget: 0.25, worstBudget: 0.8, maxImpact: 0.06, minStake: 0.25, cooldownMin: 30, priceFreshMs: 20000, jupFreshMs: 60000 };
const SIZES = [1, 0.85, 0.7, 0.55, 0.4, 0.25];
const DAY = 86400e3;

const STRATS = {
  A: {
    name: 'A: Launch Momentum',
    desc: 'Curve coins in their first 20 minutes after crossing $7K, bought only while the price is rising near its high with broad buying (58%+ of the 5-minute volume is buys, 3+ more buyers than sellers, 12+ traders). Exits on corroborated deterioration, a 15% loss, no progress after 8 minutes, a 20-minute horizon, or giving back 35% of a 20%+ gain.',
    P: { maxLoss: 0.15, horizonMin: 20, stagnationMin: 8, stagnationRet: 0.02, trailStart: 0.20, giveBack: 0.35, ddMin: 0.12, altTp: 0.20, rtMax: 0.06 },
  },
  B: {
    name: 'B: Pullback Recovery',
    desc: 'After a strong move (high at least 1.6x the crossing price) and a 25-60% pullback, buys only a confirmed recovery: 10%+ off the low, a green higher-low minute, selling easing and buyers back. Invalid once it falls back under the pullback low. Exits on corroborated deterioration, an 18% loss, no progress after 15 minutes, a 45-minute horizon, or giving back 40% of a 20%+ gain.',
    P: { maxLoss: 0.18, horizonMin: 45, stagnationMin: 15, stagnationRet: 0.03, trailStart: 0.20, giveBack: 0.40, ddMin: 0.12, altTp: 0.20, rtMax: 0.06 },
  },
  C: {
    name: 'C: Post-Graduation Momentum',
    desc: 'Coins trading on their PumpSwap pool for 5+ minutes with $15K+ liquidity, up 8%+ in 15 minutes, above their 15-minute average, with buying ahead on both the 5-minute and 1-hour windows. Exits on corroborated deterioration (including a break of the 15-minute low it had at entry), a 12% loss, no progress after 45 minutes, a 3-hour horizon, or giving back 40% of a 25%+ gain.',
    P: { maxLoss: 0.12, horizonMin: 180, stagnationMin: 45, stagnationRet: 0.03, trailStart: 0.25, giveBack: 0.40, ddMin: 0.10, altTp: 0.25, rtMax: 0.05, supportBreak: true },
  },
};

function accounts() {
  return Object.entries(STRATS).map(([id, s]) => ({ id, exp: `v11-${VERSION}/${id}`, kind: 'v2', strat: id, version: VERSION, locked: LOCKED, name: s.name, desc: s.desc,
    P: Object.assign({}, s.P), C: Object.assign({}, GATES), stake: COMMON.stake, maxImpact: COMMON.maxImpact, minStake: COMMON.minStake }));
}

// ------------------------------------------------------------------------------------------------ gates (strict)
// the newest audit we have: Jupiter refreshes it with every flow snapshot, the crossing-time check is the fallback
function latestAudit(c) {
  const j = c.jup && c.jup.audit ? { at: c.jup.at, f: c.jup.audit, src: 'jupiter (latest)' } : null;
  const a = c.audit && c.audit.valid ? { at: c.audit.at, f: c.audit.fields, src: 'jupiter (at crossing)' } : null;
  return j || a;
}
function gates(c, C) {
  const g = (id, label, status, value, at, src) => ({ id, label, status, value, at, src });
  const out = [];
  out.push(g('id', 'pump.fun mint with its bonding curve', /pump$/.test(c.m) && c.bc ? G.P : G.F, c.bc ? 'curve ' + c.bc.slice(0, 6) : 'no curve address', c.xAt, 'discovery'));
  const a = latestAudit(c), f = a ? a.f : null;
  const yes = (k, label) => !f || f[k] == null ? g(k === 'mintAuthorityDisabled' ? 'mint' : 'freeze', label, G.U, null, a && a.at, a ? 'not reported' : 'no audit yet')
    : g(k === 'mintAuthorityDisabled' ? 'mint' : 'freeze', label, f[k] === true ? G.P : G.F, f[k], a.at, a.src);
  out.push(yes('mintAuthorityDisabled', 'Mint authority revoked'));
  out.push(yes('freezeAuthorityDisabled', 'Freeze authority revoked'));
  // dev wallet: Jupiter's figure when it reports one, else the creator's balance from the RugCheck report; both
  // unknown means unknown (never 0%); when both exist the higher one counts
  const jd = f && f.devBalancePercentage != null && isFinite(+f.devBalancePercentage) ? +f.devBalancePercentage : null;
  const rd = c.rcr && c.rcr.valid && c.rcr.devPct != null ? c.rcr.devPct : null;
  if (jd == null && rd == null) out.push(g('dev', `Dev wallet ${C.devMax}% or less`, G.U, null, null, 'neither Jupiter nor RugCheck reported it'));
  else { const v = Math.max(jd == null ? -1 : jd, rd == null ? -1 : rd); out.push(g('dev', `Dev wallet ${C.devMax}% or less`, v <= C.devMax ? G.P : G.F, +v.toFixed(2), jd != null ? a.at : c.rcr.at, jd != null && rd != null ? 'jupiter + rugcheck' : jd != null ? a.src : 'rugcheck report')); }
  const top = f && f.topHoldersPercentage != null && isFinite(+f.topHoldersPercentage) ? +f.topHoldersPercentage : null;
  out.push(top == null ? g('top', `Top holders ${C.topMax}% or less`, G.U, null, a && a.at, 'not reported') : g('top', `Top holders ${C.topMax}% or less`, top <= C.topMax ? G.P : G.F, +top.toFixed(1), a.at, a.src));
  if (!c.rc) out.push(g('rc', 'No RugCheck danger flag', G.U, null, null, 'no report yet'));
  else if (!c.rc.valid) out.push(g('rc', 'No RugCheck danger flag', G.U, null, c.rc.at, c.rc.reason || 'report unavailable'));
  else { const d = (c.rc.risks || []).filter(r => r[1] === 'danger').map(r => r[0]); out.push(g('rc', 'No RugCheck danger flag', d.length ? G.F : G.P, d.length ? d.join(', ') : 'clean', c.rc.at, 'rugcheck')); }
  return out;
}

// ------------------------------------------------------------------------------------------------ setups
const pct = v => v == null ? '?' : (v * 100).toFixed(0) + '%';
// each check: [id, label, value shown, ok]; a null value is unknown, which never confirms anything
function chk(list, id, label, v, ok, shown) { list.push({ id, label, value: shown !== undefined ? shown : v, ok: v != null && !!ok }); }

function universe(id, c, at) {
  const since = at - c.xAt;
  if (id === 'A') return c.stage === 'curve' && since <= 20 * 60000;
  if (id === 'B') return c.stage !== 'migrating' && since <= 120 * 60000 && c.hi && c.mcX > 0 && c.hi.p >= 1.6 * c.mcX / E.SUPPLY;
  if (id === 'C') return c.stage === 'pool' && at - c.stageAt >= 5 * 60000 && since <= 480 * 60000;
  return false;
}
// worth fast polling: in the universe and close to a possible setup
function hot(id, c, at) {
  if (!universe(id, c, at) || c.deadAt) return false;
  if (id === 'B') return c.last && c.last.p <= 0.85 * c.hi.p;
  return true;
}
// setup + demand checks from features f. Returns { setup: [...], demand: [...], score, parts, invalidP, invalidWhy }
function evaluate(id, c, f, at, P) {
  const s = [], d = [];
  let score = 0, parts = {}, invalidP = null, invalidWhy = null;
  if (id === 'A') {
    chk(s, 'mc', 'market cap $8K-$40K', f.mc, f.mc >= 8000 && f.mc <= 40000, f.mc ? '$' + (f.mc / 1000).toFixed(1) + 'K' : null);
    chk(s, 'r3', 'up 10%+ in 3 minutes', f.r3, f.r3 >= 0.10, pct(f.r3));
    chk(s, 'r1', 'not falling in the last minute', f.r1, f.r1 >= 0, pct(f.r1));
    chk(s, 'dd', 'within 10% of its high', f.dd, f.dd <= 0.10, pct(f.dd));
    chk(s, 'green', 'last 1-minute bar green', f.greenBar, f.greenBar === true, f.greenBar);
    // P.r1Max (research variants only; unset in v2.0): no entry right after a single-minute spike
    if (P && P.r1Max) chk(s, 'spike', `up no more than ${Math.round(P.r1Max * 100)}% in the last minute`, f.r1, f.r1 <= P.r1Max, pct(f.r1));
    chk(d, 'buy', '58%+ of 5-minute volume is buys', f.buyShare5, f.buyShare5 >= 0.58, pct(f.buyShare5));
    chk(d, 'net', '3+ more buyers than sellers (5 min)', f.netBuyers5, f.netBuyers5 >= 3);
    chk(d, 'tr', '12+ traders (5 min)', f.traders5, f.traders5 >= 12);
    const lows = MK.doneBars(c, at).slice(-3).map(b => b.l);
    if (lows.length) { invalidP = Math.min(...lows) * 0.98; invalidWhy = 'back under the base of the move (lowest of the last 3 minutes)'; }
    parts = { move: 4 * Math.min(f.r3 || 0, 0.5), buying: 10 * ((f.buyShare5 || 0.5) - 0.5), breadth: Math.min(f.netBuyers5 || 0, 20) / 10 };
  } else if (id === 'B') {
    const pX = c.mcX / E.SUPPLY, ddLow = f.hi && f.lowSinceHi ? 1 - f.lowSinceHi / f.hi : null;
    chk(s, 'move', 'high 1.6x+ the crossing price', f.hi ? f.hi / pX : null, f.hi >= 1.6 * pX, f.hi ? (f.hi / pX).toFixed(2) + 'x' : null);
    chk(s, 'pull', 'pullback of 25-60% from the high', ddLow, ddLow >= 0.25 && ddLow <= 0.60, pct(ddLow));
    chk(s, 'bounce', '10%+ off the pullback low', f.bounce, f.bounce >= 0.10, pct(f.bounce));
    chk(s, 'held', 'the low is 2+ minutes old', f.lowSinceHiAt, f.lowSinceHiAt != null && at - f.lowSinceHiAt >= 120000, f.lowSinceHiAt != null ? Math.round((at - f.lowSinceHiAt) / 1000) + ' s' : null);
    chk(s, 'green', 'last minute green with a higher low', f.greenBar, f.greenBar === true && f.higherLow === true, `${f.greenBar}/${f.higherLow}`);
    chk(d, 'buy', '55%+ of 5-minute volume is buys', f.buyShare5, f.buyShare5 >= 0.55, pct(f.buyShare5));
    chk(d, 'net', '2+ more buyers than sellers (5 min)', f.netBuyers5, f.netBuyers5 >= 2);
    chk(d, 'tr', '8+ traders (5 min)', f.traders5, f.traders5 >= 8);
    chk(d, 'ease', 'selling eased: 5-minute sells at most 75% of their heaviest since the high', f.sellEasing, f.sellEasing === true,
      f.sellPeak5 ? `${pct(f.sellVol5 / f.sellPeak5)} of the peak` : null);
    if (f.lowSinceHi) { invalidP = f.lowSinceHi * 0.97; invalidWhy = 'failed reclaim: back under the pullback low'; }
    parts = { buying: 10 * ((f.buyShare5 || 0.5) - 0.5), breadth: Math.min(f.netBuyers5 || 0, 20) / 10, bounce: 3 * Math.min(f.bounce || 0, 0.3), depth: -2 * Math.abs((ddLow || 0.4) - 0.4) };
  } else if (id === 'C') {
    chk(s, 'liq', '$15K+ pool liquidity', f.liqUsd, f.liqUsd >= 15000, f.liqUsd ? '$' + (f.liqUsd / 1000).toFixed(1) + 'K' : null);
    chk(s, 'r15', 'up 8%+ in 15 minutes', f.r15, f.r15 >= 0.08, pct(f.r15));
    chk(s, 'avg', 'above its 15-minute average', f.avg15, f.p >= f.avg15, f.avg15 ? pct(f.p / f.avg15 - 1) : null);
    chk(s, 'dd', 'within 15% of its high', f.dd, f.dd <= 0.15, pct(f.dd));
    chk(d, 'buy', '55%+ of 5-minute volume is buys', f.buyShare5, f.buyShare5 >= 0.55, pct(f.buyShare5));
    chk(d, 'buy1h', '52%+ of 1-hour volume is buys', f.buyShare1h, f.buyShare1h >= 0.52, pct(f.buyShare1h));
    chk(d, 'net', '3+ more buyers than sellers (5 min)', f.netBuyers5, f.netBuyers5 >= 3);
    chk(d, 'tr', '15+ traders (5 min)', f.traders5, f.traders5 >= 15);
    parts = { move: 4 * Math.min(f.r15 || 0, 0.5), buying: 10 * ((f.buyShare5 || 0.5) - 0.5), trend: 5 * ((f.buyShare1h || 0.5) - 0.5), breadth: Math.min(f.netBuyers5 || 0, 20) / 10 };
  }
  score = Object.values(parts).reduce((a, b) => a + b, 0);
  return { setup: s, demand: d, score, parts, invalidP, invalidWhy };
}

// ------------------------------------------------------------------------------------------------ entry
/* One decision for account A at time `at`: every coin in the strategy's universe is checked through the gate sequence;
   the qualifying ones are ranked; the best gets an order with its contract. `fc(c)` gives the coin's features at `at`
   (computed once per tick for all strategies). */
function entry(A, at, coins, fc, cashFree, log) {
  const P = A.P, id = A.strat, cands = [], eligible = [], ab = A.ablate || {};
  A.fun = A.fun || {}; A.funnel = A.funnel || { coins: 0, gates: 0, setup: 0, demand: 0, cost: 0, entered: 0 };
  A.cool = A.cool || {}; A.gateSeen = A.gateSeen || {};
  for (const c of Object.values(coins)) {
    if (!universe(id, c, at) || c.deadAt) continue;
    const lv = A.fun[c.m] || (A.fun[c.m] = { at, lv: 0 });
    if (!lv.counted) { lv.counted = true; A.funnel.coins++; }
    if (A.cool[c.m] && at < A.cool[c.m]) continue;
    const gs = gates(c, A.C), failed = gs.filter(x => x.status !== G.P && x.status !== G.NA);
    const st = failed.length ? (failed.some(x => x.status === G.F) ? 'fail' : 'unknown') : 'pass';
    const prevSt = A.gateSeen[c.m];
    if (prevSt !== st) {   // log eligibility only when it changes
      A.gateSeen[c.m] = st;
      log('EligibilityDecided', at, { acct: A.id, m: c.m, sym: c.sym, pass: st === 'pass', state: st, eligibleAt: at, crossedAt: c.xAt,
        gates: gs.map(x => [x.id, x.status, x.value]), why: failed.map(x => `${x.label}: ${x.status}${x.src ? ' (' + x.src + ')' : ''}`).join('; ') || 'all gates pass' });
    }
    if (st !== 'pass') continue;
    bump(A, c.m, 1, 'gates');
    const f = fc(c);
    if (f.p == null || f.priceAge > COMMON.priceFreshMs) continue;                       // timely data
    eligible.push({ c, f });
    const ev = evaluate(id, c, f, at, P);
    if (!ev.setup.every(x => x.ok)) continue;
    bump(A, c.m, 2, 'setup');
    if (!ab.noDemand && (f.jupAge == null || f.jupAge > COMMON.jupFreshMs || !ev.demand.every(x => x.ok))) continue;
    bump(A, c.m, 3, 'demand');
    // cost and risk at the intended size, before any order: the largest size whose round trip (venue fees both ways,
    // price impact both ways since a paper buy never moves the real market, landing drift, network fees) stays under
    // rtMax, whose loss at the plan's limit fits the risk budget, and whose worst case fits the worst-case budget
    const sz = sizeFor(A, c, f, at, cashFree);
    if (!sz) continue;
    bump(A, c.m, 4, 'cost');
    cands.push({ c, f, ev, plan: sz.plan, rt: sz.rt, score: ev.score - 20 * sz.rt });
  }
  if (!cands.length) return null;
  cands.sort((a, b) => b.score - a.score || (a.c.m < b.c.m ? -1 : 1));
  // ablation baseline (replays only): same moment, but a coin drawn at random from every coin that passed the gates
  if (ab.random) {
    const pool = eligible.slice().sort((a, b) => (a.c.m < b.c.m ? -1 : 1));
    for (let k = 0; k < pool.length; k++) {
      const x = pool[Math.floor(rand(A.id + ':' + at + ':' + k) * pool.length)], sz = sizeFor(A, x.c, x.f, at, cashFree);
      if (sz) { const ev2 = evaluate(id, x.c, x.f, at, P); cands.unshift({ c: x.c, f: x.f, ev: ev2, plan: sz.plan, rt: sz.rt, score: ev2.score - 20 * sz.rt, random: true }); break; }
    }
  }
  const best = cands[0], { c, f, ev, plan, rt } = best;
  const size = plan.size;
  const contract = {
    v: VERSION, strat: id, setup: STRATS[id].name, at, m: c.m, sym: c.sym, venue: c.stage === 'pool' ? 'pool' : 'curve', stage: c.stage,
    crossedAt: c.xAt, firstSeenAt: c.firstAt, ageMin: f.ageMin != null ? +f.ageMin.toFixed(1) : null, sinceCrossMin: +f.sinceCrossMin.toFixed(1),
    gates: gates(c, A.C).map(x => [x.id, x.status, x.value, x.at, x.src]),
    confirmed: ev.setup.concat(ev.demand).map(x => [x.label, x.value]),
    f: { p: f.p, ps: f.ps, mc: f.mc, priceAt: c.last.at, jupAt: c.jup && c.jup.at, jupAsOf: c.jup && c.jup.asOf, buyShare5: f.buyShare5, netFlow5: f.netFlow5, netBuyers5: f.netBuyers5,
      traders5: f.traders5, organicBuyShare5: f.organicBuyShare5, buyShare1h: f.buyShare1h, r1: f.r1, r3: f.r3, r15: f.r15, dd: f.dd, hi: f.hi, vol: f.vol, low15: f.low15, liqUsd: f.liqUsd, holders: f.holders,
      top: (() => { const a = latestAudit(c); return a && a.f.topHoldersPercentage != null ? +a.f.topHoldersPercentage : null; })(),
      mintOff: (() => { const a = latestAudit(c); return !!(a && a.f.mintAuthorityDisabled === true); })(), freezeOff: (() => { const a = latestAudit(c); return !!(a && a.f.freezeAuthorityDisabled === true); })() },
    plan: { size, horizonMin: P.horizonMin, maxLoss: P.maxLoss, invalidP: ev.invalidP, invalidWhy: ev.invalidWhy, trail: [P.trailStart, P.giveBack], stagnation: [P.stagnationMin, P.stagnationRet],
      lossAtLimit: +(size * (P.maxLoss + rt)).toFixed(4), worstCase: +plan.check.plan.maxLoss.toFixed(4), worstWhy: c.stage === 'pool' ? 'pool price 80% lower' : 'curve back at its launch price',
      roundTripCost: +rt.toFixed(4), breakEven: +rt.toFixed(4), emergency: 'route lost, authority switched on, liquidity collapse, 25%+ sell impact: exit at once (logged unfilled if impossible)' },
    rank: { score: +best.score.toFixed(3), parts: Object.fromEntries(Object.entries(ev.parts).map(([k, v]) => [k, +v.toFixed(3)])), costPenalty: +(20 * rt).toFixed(3), n: cands.length,
      alternatives: cands.slice(1, 4).map(x => ({ m: x.c.m, sym: x.c.sym, score: +x.score.toFixed(3), behind: +(best.score - x.score).toFixed(3) })) },
    social: 'unavailable: no approved X or Telegram API (not used, not assumed)',
  };
  const why = `${STRATS[id].name.split(': ')[1]}: ${ev.setup.concat(ev.demand).map(x => `${x.label} (${x.value})`).join(', ')}; round trip ${(rt * 100).toFixed(1)}%` +
    (cands.length > 1 ? `; ranked first of ${cands.length} (next: ${cands[1].c.sym} ${(best.score - cands[1].score).toFixed(2)} behind)` : '; the only qualifying coin');
  return { m: c.m, sigAt: at, p: f.p, ps: f.ps, size, why, contract };
}
/* cost and risk at the intended size, before any order: the largest size whose round trip (venue fees both ways, price
   impact both ways since a paper buy never moves the real market, landing drift, network fees) stays under rtMax, whose
   loss at the plan's limit fits the risk budget, and whose worst case (curve back at launch, pool 80% down) fits the
   worst-case budget. null if no size qualifies. */
function sizeFor(A, c, f, at, cashFree) {
  const P = A.P, venue = c.stage === 'pool' ? 'pool' : 'curve', ps = f.ps;
  if (!(ps > 0)) return null;
  for (const size of SIZES) {
    if (size > Math.min(A.stake, cashFree)) continue;
    const ck = R.checkPlan({ venue, ps, size, stopPs: null, horizonMs: P.horizonMin * 60000, riskBudget: COMMON.worstBudget, at });
    if (!ck.ok) continue;
    const r = ck.plan.roundTripCost + 2 * FEES.COSTS.landingDrift + 2 * FEES.COSTS.networkFeeSol / size;
    if (r > P.rtMax || size * (P.maxLoss + r) > COMMON.riskBudget + 1e-9) continue;
    return { plan: { size, check: ck }, rt: r };
  }
  return null;
}
// deterministic pseudo-random number in [0, 1) from a string (replays give the same draws)
function rand(s) { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d) >>> 0; h ^= h >>> 12; return (h >>> 0) / 4294967296; }
function bump(A, m, lv, key) { const x = A.fun[m]; if (x.lv < lv) { x.lv = lv; A.funnel[key]++; } }

// ------------------------------------------------------------------------------------------------ review
function review(A, pos, c, at, f) {
  // ablation baseline (replays only): identical entries, exits only at the horizon
  if (A.ablate && A.ablate.timedOnly) {
    if (c.stage === 'migrating') return { hold: true, state: 'paused', why: 'coin is graduating: venue uncertain, no fills' };
    return at - pos.openAt >= A.P.horizonMin * 60000 ? { exit: 'time', why: `${A.P.horizonMin}-minute horizon reached (timed-exit baseline)` } : { hold: true, state: 'holding', why: 'timed-exit baseline' };
  }
  return TH.review(pos, c, at, f, A.P);
}

module.exports = { VERSION, LOCKED, STRATS, GATES, COMMON, SIZES, accounts, gates, evaluate, universe, hot, entry, review, latestAudit, sizeFor };
