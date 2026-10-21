'use strict';
/* Narrative and social evidence (audit Findings 06, C5, Phase 4). What it answers for a coin, as of a time:
   - status: 'unavailable' (no approved social source is connected: the honest default today; never read as "no
     interest"), 'none_found', 'uncertain', or 'verified' (independent, mint-specific attention that is recent and
     growing: a statement about attention, never about legitimacy or future returns);
   - claims: links and partnerships the token's creator or listing declares (Jupiter, DexScreener). They are claims,
     labeled unverified until a source confirms them;
   - nameCluster: how many other coins sharing a name word crossed $7K in 2 h (the legacy "meme" signal), kept as weak
     context and never as social proof.
   Independence: observations are grouped when they share an author, a declared author cluster, or near-identical text
   (copy-paste campaigns), so a hundred copies from one group count as one voice. Only posts naming the exact mint count
   toward attention; a generic word or ticker is not this coin. Nothing here is generated: counts come from observations
   with timestamps, sources and ids, and missing data stays missing. */

const DEF = { minGroups: 5, recentS: 600, simText: 0.7, keep: 300, source: null };

function norm(t) { return String(t || '').toLowerCase().replace(/https?:\/\/\S+/g, ' ').replace(/[@$#][\w]+/g, ' ').replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim(); }
function shingles(t) { const w = norm(t).split(' ').filter(Boolean), s = new Set(); for (let i = 0; i + 2 < w.length; i++) s.add(w.slice(i, i + 3).join(' ')); if (!s.size && w.length) s.add(w.join(' ')); return s; }
function jaccard(a, b) { if (!a.size || !b.size) return 0; let n = 0; for (const x of a) if (b.has(x)) n++; return n / (a.size + b.size - n); }

/* Groups of observations that cannot be told apart as independent voices (union-find). */
function groups(obs, simText) {
  const parent = obs.map((_, i) => i), find = i => parent[i] === i ? i : (parent[i] = find(parent[i])), join = (a, b) => { parent[find(a)] = find(b); };
  const sh = obs.map(o => shingles(o.text));
  for (let i = 0; i < obs.length; i++) for (let j = 0; j < i; j++) {
    const a = obs[i], b = obs[j];
    if ((a.author && a.author === b.author) || (a.cluster && a.cluster === b.cluster) || jaccard(sh[i], sh[j]) >= simText) join(i, j);
  }
  const g = new Map();
  obs.forEach((o, i) => { const r = find(i); if (!g.has(r)) g.set(r, []); g.get(r).push(o); });
  return [...g.values()];
}

/* The coin's dossier as of `at` from what had been observed by then. */
function assess(k, at, C = {}) {
  const P = Object.assign({}, DEF, C);
  const obs = (k.socialObs || []).filter(o => o.at <= at);
  const claims = [];
  const jc = k.jclaims || {}, dc = k.claims || {};
  for (const [kind, url] of [['x', jc.tw], ['website', jc.web], ['telegram', jc.tg]]) if (url) claims.push({ kind, url, by: 'token listing (Jupiter)', status: 'unverified claim' });
  for (const [type, url] of (dc.socials || [])) if (url && !claims.some(c => c.url === url)) claims.push({ kind: type || 'social', url, by: 'token listing (DexScreener)', status: 'unverified claim' });
  for (const url of (dc.webs || [])) if (url && !claims.some(c => c.url === url)) claims.push({ kind: 'website', url, by: 'token listing (DexScreener)', status: 'unverified claim' });
  for (const o of obs) if (o.kind === 'partner_claim') claims.push({ kind: 'partner', text: String(o.text || '').slice(0, 120), url: o.url || null, by: o.author || 'unknown', status: 'unverified claim: no confirming source', at: o.at });
  const nameCluster = k.meme ? { word: k.meme.word, coins: k.meme.score, note: 'name cluster, not social proof' } : null;
  const warnings = [];
  if (!obs.length && !P.source) {
    warnings.push('evidence incomplete: no approved social source is connected (X / Telegram), so attention is unknown');
    return { at, status: 'unavailable', claims, nameCluster, attention: null, warnings };
  }
  const posts = obs.filter(o => o.kind !== 'partner_claim'), mint = posts.filter(o => o.mint);
  const gs = groups(mint, P.simText);
  const recent = mint.filter(o => at - o.at <= P.recentS).length, before = mint.filter(o => at - o.at > P.recentS && at - o.at <= 2 * P.recentS).length;
  const copies = mint.length - gs.length;
  const attention = { mintMentions: mint.length, nameOnly: posts.length - mint.length, independent: gs.length, copies, recent, before,
    firstAt: mint.length ? Math.min(...mint.map(o => o.at)) : null, lastAt: mint.length ? Math.max(...mint.map(o => o.at)) : null,
    sources: [...new Set(obs.map(o => o.src).filter(Boolean))] };
  let status;
  if (!mint.length) { status = posts.length ? 'uncertain' : 'none_found'; if (posts.length) warnings.push('mentions do not name this exact mint'); }
  else if (gs.length >= P.minGroups && recent > before && at - attention.lastAt <= P.recentS) status = 'verified';
  else {
    status = 'uncertain';
    if (gs.length < P.minGroups) warnings.push(`${gs.length} independent voice${gs.length === 1 ? '' : 's'} (${copies} copies merged): not enough`);
    if (recent <= before) warnings.push('attention not growing');
  }
  if (claims.some(c => c.kind === 'partner')) warnings.push('partnership or celebrity claims are unverified');
  return { at, status, claims, nameCluster, attention, warnings };
}
/* a `social` event: { m, src, id, author, cluster, text, url, mint (names the exact mint), kind ('post' | 'partner_claim') } */
function ingest(k, ev, at, C) {
  k.socialObs = k.socialObs || [];
  if (ev.id && k.socialObs.some(o => o.id === ev.id && o.src === ev.src)) return;
  k.socialObs.push({ at, src: ev.src || null, id: ev.id || null, author: ev.author || null, cluster: ev.cluster || null, text: String(ev.text || '').slice(0, 280), url: ev.url || null, mint: !!ev.mint, kind: ev.kind || 'post' });
  if (k.socialObs.length > (C && C.keep || DEF.keep)) k.socialObs.shift();
  k.social = assess(k, at, C);
}
module.exports = { assess, ingest, groups, norm, DEF };
