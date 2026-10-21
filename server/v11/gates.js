'use strict';
/* Security and eligibility gates (audit Findings 06, 09, 10). Every result is four-valued: pass / fail / unknown /
   not_applicable, with the time the deciding data arrived. Two gate sets:
   - legacy: the locked v10 checks exactly (E0 accounts measure legacy rules under honest timing), including their
     unknown-as-pass habits, which are kept but labeled (`legacyPass` true on an `unknown`);
   - strict: unknown critical facts are never a pass. The coin is not eligible until they are known. */
const LEGACY = require('../sniper.js');

const res = (id, v, text, extra) => Object.assign({ id, v, text }, extra || {});

/* The legacy watchlist score (meme first, then holders, socials, organic score). */
function legacyScore(k) {
  const soc = (k.audit && k.audit.soc) || {};
  return (k.meme ? k.meme.score : 0) * 10 + Math.min(10, ((k.audit && k.audit.holders) || 0) / 20) + ((soc.tw || soc.web || soc.tg) ? 3 : 0) + Math.min(5, (+(k.audit && k.audit.org) || 0) / 10);
}
/* Legacy checks for one rule set C ({ devMax, topMax, needMeme, minHolders?, social?, devMints?, rcMax? }).
   k.audit / k.rc as stored by the engine; k.meme = { score, word } at the crossing. */
function legacy(k, C) {
  const a = (k.audit && !k.audit.missing) ? k.audit : null, rc = k.rc && !k.rc.missing ? k.rc : null;
  const out = [];
  const tri = (ok, known) => !known ? 'unknown' : ok ? 'pass' : 'fail';
  out.push(res('mint', tri(a && a.mintOff === true, a && a.mintOff != null), a ? (a.mintOff === true ? 'revoked' : a.mintOff === false ? 'still on' : 'not reported') : 'no audit data', { legacyPass: !!(a && a.mintOff === true) }));
  out.push(res('freeze', tri(a && a.freezeOff === true, a && a.freezeOff != null), a ? (a.freezeOff === true ? 'revoked' : a.freezeOff === false ? 'still on' : 'not reported') : 'no audit data', { legacyPass: !!(a && a.freezeOff === true) }));
  // legacy reads a missing dev balance as 0% (a pass); kept for E0, shown as unknown
  const dev = a ? a.dev : null;
  out.push(res('dev', dev == null ? 'unknown' : dev <= C.devMax ? 'pass' : 'fail', dev == null ? 'not reported (legacy counts it as 0%)' : dev.toFixed(1) + '%', { legacyPass: dev == null ? true : dev <= C.devMax }));
  const top = a ? a.top : null;
  out.push(res('top', top == null ? 'unknown' : top <= C.topMax ? 'pass' : 'fail', top == null ? 'not reported (legacy lets it pass)' : top.toFixed(1) + '%', { legacyPass: top == null || top <= C.topMax }));
  const danger = rc ? rc.danger : [];
  const rcOk = !!rc && !danger.length && (!C.rcMax || (rc.sn != null && rc.sn <= C.rcMax));
  out.push(res('rc', !rc ? 'unknown' : rcOk ? 'pass' : 'fail', !rc ? 'no RugCheck report' : danger.length ? danger.join(', ') : `clean (score ${rc.sn != null ? rc.sn : rc.score})`, { legacyPass: rcOk }));
  const meme = k.meme || { score: 0, word: null };
  out.push(res('meme', meme.score >= C.needMeme ? 'pass' : 'fail', meme.score ? `"${meme.word}": ${meme.score} other coin${meme.score > 1 ? 's' : ''} in 2 h (name cluster, not social proof)` : 'no name match in 2 h', { legacyPass: meme.score >= C.needMeme }));
  if (C.minHolders) { const h = a ? a.holders : null; out.push(res('holders', h == null ? 'unknown' : h >= C.minHolders ? 'pass' : 'fail', h == null ? 'not reported' : String(h), { legacyPass: (h || 0) >= C.minHolders })); }
  if (C.social) { const s = (a && a.soc) || {}; const any = !!(s.tw || s.web || s.tg); out.push(res('social', any ? 'pass' : 'fail', any ? 'link claimed (not verified)' : 'none', { legacyPass: any })); }
  if (C.devMints) { const d = a ? a.devMints : null; out.push(res('devMints', d == null ? 'unknown' : d <= C.devMints ? 'pass' : 'fail', d == null ? 'not reported' : String(d), { legacyPass: d != null && d <= C.devMints })); }
  return { ok: out.every(r => r.legacyPass), res: out };
}

/* Strict gates for the v11 strategies. Critical: mint and freeze authority, top-holder concentration, RugCheck danger.
   A missing dev balance is allowed only when top holders are known and at most 25% (the dev wallet is among them), and
   that substitution is written into the result. Schema problems count as unknown. */
const STRICT = { devMax: 10, topMax: 30, topCover: 25, devMintsMax: 25 };
function strict(k, C = STRICT) {
  const a = (k.audit && !k.audit.missing) ? k.audit : null, rc = k.rc && !k.rc.missing ? k.rc : null;
  const out = [];
  const crit = (id, v, text) => out.push(res(id, v, text, { critical: true }));
  crit('identity', k.bc && k.quote === 'SOL' ? 'pass' : 'unknown', k.bc ? 'pump.fun coin, SOL pair' : 'curve pair not seen');
  crit('mint', !a || a.mintOff == null ? 'unknown' : a.mintOff ? 'pass' : 'fail', !a ? 'no audit data' : a.mintOff == null ? 'not reported' : a.mintOff ? 'revoked' : 'still on');
  crit('freeze', !a || a.freezeOff == null ? 'unknown' : a.freezeOff ? 'pass' : 'fail', !a ? 'no audit data' : a.freezeOff == null ? 'not reported' : a.freezeOff ? 'revoked' : 'still on');
  const top = a ? a.top : null;
  crit('top', top == null ? 'unknown' : top <= C.topMax ? 'pass' : 'fail', top == null ? 'not reported' : top.toFixed(1) + '%');
  crit('rc', !rc ? 'unknown' : rc.danger.length ? 'fail' : 'pass', !rc ? (k.rc && k.rc.invalid ? 'report unreadable' : 'no report') : rc.danger.length ? rc.danger.join(', ') : 'no danger flag');
  const dev = a ? a.dev : null;
  if (dev != null) out.push(res('dev', dev <= C.devMax ? 'pass' : 'fail', dev.toFixed(1) + '%', { critical: true }));
  else if (top != null && top <= C.topCover) out.push(res('dev', 'unknown', `not reported; covered by top holders ${top.toFixed(1)}% <= ${C.topCover}%`, { critical: false }));
  else out.push(res('dev', 'unknown', 'not reported and top holders do not cover it', { critical: true }));
  const dm = a ? a.devMints : null;
  out.push(res('devMints', dm == null ? 'unknown' : dm <= C.devMintsMax ? 'pass' : 'fail', dm == null ? 'not reported' : `${dm} earlier coins`, { critical: dm != null }));
  const ok = out.every(r => r.v === 'pass' || r.v === 'not_applicable' || (r.v === 'unknown' && !r.critical));
  const unknown = out.filter(r => r.v === 'unknown' && r.critical).map(r => r.id);
  const failed = out.filter(r => r.v === 'fail').map(r => r.id);
  return { ok, res: out, unknown, failed };
}
module.exports = { legacy, strict, legacyScore, STRICT, words: LEGACY.words, memeScore: LEGACY.memeScore };
