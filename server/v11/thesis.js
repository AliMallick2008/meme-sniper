'use strict';
/* Position control for the V2 strategies (audit C4 and Layer 5). Every review asks again whether the reason a coin was
   bought is still supported by evidence, using only what was observed by then. Exit priority:
     1. emergency: one event is enough (sell route lost, mint or freeze authority switched on, pool liquidity collapse,
        catastrophic sell impact)
     2. thesis break: corroborated deterioration, i.e. at least two independent feature families (structure, demand,
        liquidity, holders) each flagging, and each flag persisting across two separate observations of its own inputs
        (at least 10 s apart), so one red candle or one noisy snapshot never sells
     3. risk limit: the executable value of the position fell to the loss the plan allowed
     4. time: the setup did not develop in time (stagnation), or the horizon ended
     5. profit protection: after a large enough gain, a give-back of part of it (confirmed twice)
   A one-family flag is reported ("weakening") but is not a reason to sell. */
const MK = require('./market.js');

const FAMILIES = ['structure', 'demand', 'liquidity', 'holders'];
const CONFIRM_MS = 10000;

// deterioration flags right now. Each family: { state: 'ok'|'flag'|'unknown', why: [..], obs: id of the observation it rests on }
function families(f, pos, c, at, P) {
  const e = pos.contract.f, plan = pos.contract.plan, out = {};
  // structure: failed reclaim of the invalidation level, or a trend break (lower highs plus a drop from the post-entry
  // peak that is large for this coin's own volatility)
  {
    const why = [];
    if (f.p == null) out.structure = { state: 'unknown', why: ['no fresh price'], obs: null };
    else {
      if (plan.invalidP && f.p < plan.invalidP) why.push(`price under the invalidation level (${plan.invalidWhy})`);
      const peak = pos.peakP || pos.entryP;
      // P.volCap (research variants only; unset in v2.0): cap the volatility-scaled part of the threshold
      const volNeed = 3 * (e.vol || f.vol || 0.04), ddPeak = peak ? 1 - f.p / peak : 0, need = Math.max(P.ddMin, P.volCap ? Math.min(volNeed, P.volCap) : volNeed);
      if (ddPeak >= need && f.lowerHighs === true) why.push(`lower highs and ${(ddPeak * 100).toFixed(0)}% off the post-entry high (more than ${(need * 100).toFixed(0)}% for this coin)`);
      if (P.supportBreak && e.low15 && f.p < e.low15) why.push('under the 15-minute low it had at entry');
      out.structure = { state: why.length ? 'flag' : 'ok', why, obs: c.last ? 'p' + c.last.at : null };
    }
  }
  // demand: net selling in USD notional, more wallets selling than buying, or participation collapsing
  {
    const why = [];
    if (f.buyShare5 == null && f.netBuyers5 == null) out.demand = { state: 'unknown', why: ['no fresh order flow'], obs: null };
    else {
      if (f.buyShare5 != null && f.buyShare5 <= 0.42 && f.netFlow5 < 0) why.push(`sellers dominate: ${(f.buyShare5 * 100).toFixed(0)}% of the last 5 minutes' volume was buys`);
      if (f.netBuyers5 != null && f.netBuyers5 <= -2) why.push(`${-f.netBuyers5} more wallets sold than bought in 5 minutes`);
      if (e.traders5 >= 10 && f.traders5 != null && f.traders5 <= 0.4 * e.traders5) why.push(`traders down to ${f.traders5} from ${e.traders5} at entry`);
      out.demand = { state: why.length ? 'flag' : 'ok', why, obs: c.jup ? 'j' + (c.jup.asOf || c.jup.at) : null };
    }
  }
  // liquidity and sellability: the executable sell quote for this position, pool liquidity
  {
    const why = [];
    const mq = c.mq && at - c.mq.at <= 120000 ? c.mq : null;
    if (mq && !mq.ok) why.push('the last sell quote found no route');
    if (mq && mq.ok && mq.impact != null && mq.impact >= Math.max(2 * (pos.impact || 0), 0.08)) why.push(`selling now would move the price ${(mq.impact * 100).toFixed(1)}%`);
    if (e.liqUsd && f.liqUsd != null && f.liqUsd <= 0.7 * e.liqUsd) why.push(`liquidity down ${((1 - f.liqUsd / e.liqUsd) * 100).toFixed(0)}% since entry`);
    const known = mq || f.liqUsd != null;
    out.liquidity = { state: why.length ? 'flag' : known ? 'ok' : 'unknown', why, obs: (mq ? 'q' + mq.at : '') + (c.jup ? 'j' + c.jup.at : '') || null };
  }
  // holders: holders leaving fast, or the top holders' share rising
  {
    const why = [];
    if (f.holderChangePct5 != null && f.holderChangePct5 <= -5 && (f.holders || 0) >= 30) why.push(`holders down ${(-f.holderChangePct5).toFixed(1)}% in 5 minutes`);
    const top = c.jup && c.jup.audit ? +c.jup.audit.topHoldersPercentage : NaN;
    if (isFinite(top) && isFinite(e.top) && top >= e.top + 8) why.push(`top holders' share up from ${e.top.toFixed(0)}% to ${top.toFixed(0)}%`);
    out.holders = { state: why.length ? 'flag' : (f.holderChangePct5 != null || isFinite(top)) ? 'ok' : 'unknown', why, obs: c.jup ? 'j' + (c.jup.asOf || c.jup.at) : null };
  }
  return out;
}

// a family is confirmed when its flag has held across two different observations at least CONFIRM_MS apart
function persist(pos, fam, at) {
  pos.th = pos.th || {};
  const conf = [];
  for (const k of FAMILIES) {
    const x = fam[k], t = pos.th[k];
    if (x.state !== 'flag') { delete pos.th[k]; continue; }
    if (!t) { pos.th[k] = { since: at, obs: [x.obs], why: x.why }; continue; }
    if (x.obs && !t.obs.includes(x.obs)) t.obs.push(x.obs);
    if (t.obs.length > 4) t.obs.splice(0, t.obs.length - 4);
    t.why = x.why;
    if (t.obs.length >= 2 && at - t.since >= CONFIRM_MS) conf.push(k);
  }
  return conf;
}

function emergency(f, pos, c, at) {
  if (c.routeLostAt) return 'no executable sell route (two quotes in a row found none)';
  const a = c.jup && c.jup.audit, e = pos.contract.f;
  if (a && a.mintAuthorityDisabled === false && e.mintOff) return 'mint authority switched on after entry';
  if (a && a.freezeAuthorityDisabled === false && e.freezeOff) return 'freeze authority switched on after entry';
  if (e.liqUsd && f.liqUsd != null && f.liqUsd <= 0.5 * e.liqUsd) return `pool liquidity collapsed (${((1 - f.liqUsd / e.liqUsd) * 100).toFixed(0)}% gone)`;
  const mq = c.mq && at - c.mq.at <= 120000 ? c.mq : null;
  if (mq && mq.ok && mq.impact >= 0.25) return `selling would move the price ${(mq.impact * 100).toFixed(0)}%`;
  return null;
}

/* review(pos, c, at, f, P) -> { exit, why, state, thesis } (exit: 'emergency'|'thesis'|'risk'|'stagnation'|'time'|'trail')
   P: { maxLoss, horizonMin, stagnationMin, stagnationRet, trailStart, giveBack, ddMin, supportBreak, altTp } */
function review(pos, c, at, f, P) {
  const cost = pos.cost, m = pos.mark && pos.mark.value != null && pos.mark.at === at ? pos.mark : null;
  if (f.p != null) pos.peakP = Math.max(pos.peakP || 0, f.p);
  // the fixed-target alternative, assessed live: when would a plain +altTp target have sold, and for how much
  if (m && P.altTp && !pos.alt && m.value >= cost * (1 + P.altTp)) pos.alt = { tp: P.altTp, at, value: m.value, ret: m.value / cost - 1, src: m.src };
  const fam = families(f, pos, c, at, P);
  const conf = persist(pos, fam, at);
  const thesis = { state: conf.length >= 2 ? 'broken' : conf.length === 1 || FAMILIES.some(k => fam[k].state === 'flag') ? 'weakening' : 'healthy',
    families: Object.fromEntries(FAMILIES.map(k => [k, conf.includes(k) ? 'confirmed' : fam[k].state])), at };
  pos.thesis = thesis;
  const flagged = conf.map(k => `${k}: ${pos.th[k].why.join('; ')}`).join(' | ');
  if (c.stage === 'migrating') return { hold: true, state: 'paused', why: 'coin is graduating: venue uncertain, no fills', thesis };
  const em = emergency(f, pos, c, at);
  if (em) return { exit: 'emergency', why: em, thesis };
  if (conf.length >= 2) return { exit: 'thesis', why: `thesis broken, ${conf.length} families agree: ${flagged}`, thesis };
  if (m && m.value <= cost * (1 - P.maxLoss)) return { exit: 'risk', why: `worth ${m.value.toFixed(3)} SOL if sold now (${((m.value / cost - 1) * 100).toFixed(1)}%): the plan's ${(P.maxLoss * 100).toFixed(0)}% loss limit`, thesis };
  const age = at - pos.openAt;
  if (age >= P.horizonMin * 60000) return { exit: 'time', why: `${P.horizonMin}-minute horizon reached`, thesis };
  if (P.stagnationMin && age >= P.stagnationMin * 60000 && !pos.stagnationOk) {
    if (m && m.value / cost - 1 >= P.stagnationRet) pos.stagnationOk = true;
    else if (m) return { exit: 'stagnation', why: `after ${P.stagnationMin} minutes it is ${((m.value / cost - 1) * 100).toFixed(1)}%, under the ${(P.stagnationRet * 100).toFixed(0)}% the setup should have made by now`, thesis };
  }
  // profit protection: once the position was worth trailStart more than it cost, give back at most giveBack of the gain
  const peak = pos.peak || 0;
  if (m && peak >= cost * (1 + P.trailStart)) {
    const level = cost + (peak - cost) * (1 - P.giveBack);
    if (m.value <= level) {
      // confirmed by a second observation (a newer price or quote) at least 10 s after the first
      const obsAt = m.at - (m.age || 0);
      if (!pos.trailHit) pos.trailHit = { since: at, obsAt };
      else if (obsAt !== pos.trailHit.obsAt && at - pos.trailHit.since >= CONFIRM_MS)
        return { exit: 'trail', why: `gave back ${(((peak - m.value) / (peak - cost)) * 100).toFixed(0)}% of the gain from its best (+${((peak / cost - 1) * 100).toFixed(0)}%): profit protection`, thesis };
    } else pos.trailHit = null;
  }
  const state = thesis.state === 'healthy' ? 'holding' : 'watching';
  const why = thesis.state === 'healthy' ? 'thesis intact' : `one warning, not corroborated: ${FAMILIES.filter(k => fam[k].state === 'flag').map(k => `${k} (${fam[k].why.join('; ')})`).join(', ')}`;
  return { hold: true, state: m ? state : 'unpriceable', why: m ? why : 'no fresh price or quote: holding, exits that need a price wait', thesis };
}
module.exports = { review, families, persist, FAMILIES, CONFIRM_MS };
