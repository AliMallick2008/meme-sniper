'use strict';
/* Eligibility gates. Every gate answers pass / fail / unknown / not_applicable, with the value it saw and when that
   value was received. Unknown is never treated as safe by the v11 (strict) gate set. The legacy gate set reproduces the
   v10 rules exactly (including their unknown-as-pass habits) so the E0 accounts keep the legacy decisions. */
const E = require('../sniper.js');

const P = 'pass', F = 'fail', U = 'unknown', NA = 'not_applicable';
const g = (id, label, status, value, at, why) => ({ id, label, status, value, at, why });

// strict (v11) security gates
function strict(c, at, C) {
  const a = c.audit && c.audit.valid ? c.audit.fields : null, aAt = c.audit ? c.audit.at : null;
  const rc = c.rc && c.rc.valid ? c.rc : null;
  const has = k => a && a[k] != null;
  const out = [];
  out.push(!a ? g('mint', 'Mint authority revoked', U, null, aAt, 'no audit yet')
    : has('mintAuthorityDisabled') ? g('mint', 'Mint authority revoked', a.mintAuthorityDisabled === true ? P : F, a.mintAuthorityDisabled, aAt)
    : g('mint', 'Mint authority revoked', U, null, aAt, 'not reported'));
  out.push(!a ? g('freeze', 'Freeze authority revoked', U, null, aAt, 'no audit yet')
    : has('freezeAuthorityDisabled') ? g('freeze', 'Freeze authority revoked', a.freezeAuthorityDisabled === true ? P : F, a.freezeAuthorityDisabled, aAt)
    : g('freeze', 'Freeze authority revoked', U, null, aAt, 'not reported'));
  out.push(!a ? g('dev', `Dev wallet ${C.devMax}% or less`, U, null, aAt, 'no audit yet')
    : has('devBalancePercentage') ? g('dev', `Dev wallet ${C.devMax}% or less`, +a.devBalancePercentage <= C.devMax ? P : F, +a.devBalancePercentage, aAt)
    : g('dev', `Dev wallet ${C.devMax}% or less`, U, null, aAt, 'not reported (not the same as 0%)'));
  out.push(!a ? g('top', `Top holders ${C.topMax}% or less`, U, null, aAt, 'no audit yet')
    : has('topHoldersPercentage') ? g('top', `Top holders ${C.topMax}% or less`, +a.topHoldersPercentage <= C.topMax ? P : F, +a.topHoldersPercentage, aAt)
    : g('top', `Top holders ${C.topMax}% or less`, U, null, aAt, 'not reported'));
  if (!c.rc) out.push(g('rc', 'No RugCheck danger flag', U, null, null, 'no report yet'));
  else if (!rc) out.push(g('rc', 'No RugCheck danger flag', U, null, c.rc.at, c.rc.reason || 'report unavailable'));
  else { const d = rc.risks.filter(r => r[1] === 'danger').map(r => r[0]); out.push(g('rc', 'No RugCheck danger flag', d.length ? F : P, d.length ? d.join(', ') : 'clean', rc.at)); }
  return out;
}

// the v10 rule set, as v10 evaluated it (dev missing counts as 0%, top missing passes, meme = name-cluster score)
function legacy(c, C, crosses) {
  const a = c.audit && c.audit.valid ? c.audit.fields : (c.audit ? { missing: true } : {});
  const dev = a.devBalancePercentage == null ? 0 : +a.devBalancePercentage, top = a.topHoldersPercentage == null ? null : +a.topHoldersPercentage;
  const rc = c.rc && c.rc.valid ? c.rc : { missing: true, risks: [] }, danger = rc.risks.filter(r => r[1] === 'danger');
  const meme = E.memeScore(c.words, crosses, c.xAt / 1000, c.m);
  const out = [
    g('mint', 'Mint authority revoked', a.mintAuthorityDisabled === true ? P : F, a.mintAuthorityDisabled, c.audit && c.audit.at),
    g('freeze', 'Freeze authority revoked', a.freezeAuthorityDisabled === true ? P : F, a.freezeAuthorityDisabled, c.audit && c.audit.at),
    g('dev', `Dev wallet ${C.devMax}% or less (v10: missing = 0%)`, dev <= C.devMax ? P : F, a.devBalancePercentage == null ? 'not reported' : dev, c.audit && c.audit.at),
    g('top', `Top holders ${C.topMax}% or less (v10: missing passes)`, top == null || top <= C.topMax ? P : F, top == null ? 'not reported' : top, c.audit && c.audit.at),
    g('rc', 'No RugCheck danger flag' + (C.rcMax ? `, score ${C.rcMax} or less` : ''), !rc.missing && !danger.length && (!C.rcMax || (rc.sn != null && rc.sn <= C.rcMax)) ? P : F, rc.missing ? 'no report' : danger.map(r => r[0]).join(', ') || rc.sn, c.rc && c.rc.at),
    g('meme', 'Name-cluster score 1+ (v10 "current meme")', meme.score >= C.needMeme ? P : F, meme.score ? `${meme.word} x${meme.score}` : 0, c.xAt),
  ];
  const f = c.audit && c.audit.valid ? c.audit.fields : {};
  if (C.minHolders) out.push(g('hold', `${C.minHolders}+ holders`, (f.holders || 0) >= C.minHolders ? P : F, f.holders || null, c.audit && c.audit.at));
  if (C.social) out.push(g('soc', 'Has a social link', f.socials && (f.socials.tw || f.socials.web || f.socials.tg) ? P : F, f.socials || null, c.audit && c.audit.at));
  if (C.devMints) out.push(g('devm', `Dev made ${C.devMints} or fewer coins before`, f.devMints != null && f.devMints <= C.devMints ? P : F, f.devMints, c.audit && c.audit.at));
  return out;
}
const allPass = gs => gs.every(x => x.status === P || x.status === NA);
const unknowns = gs => gs.filter(x => x.status === U);
const fails = gs => gs.filter(x => x.status === F);
module.exports = { strict, legacy, allPass, unknowns, fails, P, F, U, NA };
