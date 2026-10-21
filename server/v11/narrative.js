'use strict';
/* Narrative and social evidence (audit C5, Layer 4, Phase 4). Honest by construction:

   - Social attention needs an approved data source (X, Telegram). None is connected, so `attention.status` is
     "unavailable": nothing is scraped, nothing is guessed, no count is ever invented.
   - What a coin's own metadata says (its website, X account, Telegram) is a CLAIM made by whoever launched it. Claims are
     listed with their source and the time they were first seen, labeled "unverified claim". A claim never counts as
     verification, and a celebrity or partner claim is never shown as an endorsement.
   - The legacy "current meme" check is a NAME-CLUSTER score: how many coins with the same word in their name crossed
     $7K in the last 2 hours. It measures copycat launches, not attention, and is labeled that way. Name repetition can
     never make social evidence "verified".
   - If social observations ever arrive (an approved API), they are judged by independent sources: mentions that resolve
     to this exact mint, from distinct account clusters, first seen before the decision. Copies from one account group
     count once. "verified" needs several independent credible accounts; otherwise "uncertain".

   statuses: attention: verified | uncertain | unavailable;  claims: unverified claim | verified (needs an independent
   source that resolves to this mint) */
const E = require('../sniper.js');

const VERIFIED_MIN_CLUSTERS = 3;       // independent account groups needed before attention counts as verified
const CLAIM_TYPES = { twitter: 'X account', website: 'website', telegram: 'Telegram', discord: 'Discord' };

// the name-cluster score (legacy "meme"): copycat names in the recent crossings, explicitly not social proof
function nameCluster(c, crosses, atSec) {
  const s = E.memeScore(c.words || E.words(c.name, c.sym), crosses || [], atSec, c.m);
  return { word: s.word || null, count: s.score || 0, label: 'name-cluster score (copycat names that crossed $7K in 2 h)', socialProof: false,
    note: s.score ? `${s.score} other coin${s.score > 1 ? 's' : ''} with "${s.word}" in the name crossed recently: this measures copycats, not attention` : 'no other recent coin shares a name word' };
}

// claims from the coin's own metadata. Sources: DexScreener pair info as the legacy core stores it ({ web: count,
// soc: ['twitter', ...] }), Jupiter's socials flags ({ tw, web, tg }), or plain { twitter: url, website: url }
function claims(c) {
  const seen = new Map(), l = c.links || {}, so = (c.audit && c.audit.fields && c.audit.fields.socials) || {};
  const add = (type, url, source) => { const k = /^(x|tw|twitter)$/i.test(type) ? 'twitter' : /^(web|website)$/i.test(type) ? 'website' : /^(tg|telegram)$/i.test(type) ? 'telegram' : String(type).toLowerCase();
    if (!seen.has(k) || (url && !seen.get(k).url)) seen.set(k, { type: k, label: CLAIM_TYPES[k] || k, url: typeof url === 'string' ? url : null, source }); };
  for (const [k, v] of Object.entries(CLAIM_TYPES)) if (typeof l[k] === 'string' && l[k]) add(k, l[k], 'token metadata (set by the launcher)');
  if (l.web > 0) add('website', null, 'DexScreener pair info (set by the launcher)');
  if (Array.isArray(l.soc)) for (const t of l.soc) if (t) add(t, null, 'DexScreener pair info (set by the launcher)');
  if (so.tw) add('twitter', null, 'Jupiter token info (set by the launcher)');
  if (so.web) add('website', null, 'Jupiter token info (set by the launcher)');
  if (so.tg) add('telegram', null, 'Jupiter token info (set by the launcher)');
  return [...seen.values()].map(x => Object.assign(x, { firstSeenAt: c.firstAt || c.xAt, status: 'unverified claim',
    why: "anyone can put any link in a token's metadata; it is not checked against the account or site" }));
}

// a claimed association (celebrity, partner, exchange): unverified unless an independent source for this exact mint exists
function assessClaim(claim) {
  const src = claim && claim.source;
  const independent = !!(src && src.independent && src.url && src.mint && claim.mint && src.mint === claim.mint);
  return { what: claim.what, status: independent ? 'verified' : 'unverified claim', endorsement: false,
    why: independent ? `confirmed by ${src.url}, which names this mint` : 'no independent, verifiable source that names this exact mint' };
}

/* social observations (only from an approved source): [{ sourceId, account, cluster, mint, text, firstSeenAt, credible }]
   -> attention at decision time `at`. Mentions must name this exact mint and be seen before `at`. */
function attention(observations, m, at, approvedSource) {
  if (!approvedSource) return { status: 'unavailable', why: 'no approved X or Telegram data source is connected; nothing is scraped or assumed', mentions: null, clusters: null };
  const ok = (observations || []).filter(o => o && o.mint === m && o.firstSeenAt <= at);
  const clusters = new Set(ok.map(o => o.cluster || o.account));
  const credible = new Set(ok.filter(o => o.credible).map(o => o.cluster || o.account));
  const offTarget = (observations || []).filter(o => o && o.mint !== m).length;
  if (!ok.length) return { status: 'uncertain', why: 'no mention of this exact mint before the decision', mentions: 0, clusters: 0, offTarget };
  if (credible.size >= VERIFIED_MIN_CLUSTERS) return { status: 'verified', why: `${credible.size} independent credible account groups named this mint`, mentions: ok.length, clusters: clusters.size, offTarget };
  return { status: 'uncertain', why: clusters.size === 1 ? `all ${ok.length} mentions come from one account group (copies count once)` : `only ${credible.size} independent credible account group${credible.size === 1 ? '' : 's'}`,
    mentions: ok.length, clusters: clusters.size, offTarget };
}

// the Narrative Dossier for one coin: what can be shown, with an explicit "evidence incomplete" warning
function dossier(c, crosses, at, social) {
  const att = attention(social && social.observations, c.m, at, social && social.approved);
  return { m: c.m, sym: c.sym, name: c.name, at, warning: 'Evidence incomplete: this is not a claim that the coin is legitimate, and social posts are not shown to predict returns.',
    attention: att, claims: claims(c), nameCluster: nameCluster(c, crosses, at / 1000), identity: { mint: c.m, curve: c.bc || null, note: 'identified by mint address, never by ticker' } };
}
module.exports = { nameCluster, claims, assessClaim, attention, dossier, VERIFIED_MIN_CLUSTERS };
