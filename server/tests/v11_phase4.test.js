'use strict';
/* Phase 4 (narrative and social evidence): audit tests T08, T09, T19, and "unavailable" without an approved source. */
const test = require('node:test');
const assert = require('node:assert');
const N = require('../v11/narrative.js');
const { T0, M } = require('./helpers.js');

const coin = { m: M, sym: 'FROGT', name: 'Frog Test', xAt: T0, firstAt: T0, words: ['frog'], links: { twitter: 'https://x.com/frogtest', website: 'https://frog.example' } };

test('no approved social source: attention is "unavailable", never a guessed count', () => {
  const a = N.attention([{ mint: M, cluster: 'g1', credible: true, firstSeenAt: T0 - 1 }], M, T0, false);
  assert.strictEqual(a.status, 'unavailable');
  assert.strictEqual(a.mentions, null, 'no count is invented');
});

test('T08: mentions copied by one account group never reach high-trust status', () => {
  const obs = Array.from({ length: 40 }, (_, i) => ({ mint: M, account: 'acct' + i, cluster: 'shill-ring', credible: i < 5, firstSeenAt: T0 - 60000 + i }));
  const a = N.attention(obs, M, T0, true);
  assert.strictEqual(a.status, 'uncertain');
  assert.strictEqual(a.clusters, 1);
  assert.match(a.why, /one account group/);
  // three independent credible groups would be needed
  const ok = N.attention(obs.concat([{ mint: M, cluster: 'g2', credible: true, firstSeenAt: T0 - 1 }, { mint: M, cluster: 'g3', credible: true, firstSeenAt: T0 - 1 }]), M, T0, true);
  assert.strictEqual(ok.status, 'verified');
  // mentions seen after the decision do not count
  const late = N.attention([{ mint: M, cluster: 'a', credible: true, firstSeenAt: T0 + 1 }, { mint: M, cluster: 'b', credible: true, firstSeenAt: T0 + 1 }, { mint: M, cluster: 'c', credible: true, firstSeenAt: T0 + 1 }], M, T0, true);
  assert.strictEqual(late.status, 'uncertain');
});

test('T09: a celebrity or partner claim without a verifiable source is labeled unverified, never an endorsement', () => {
  const r = N.assessClaim({ what: 'partnered with a famous exchange', mint: M, source: { url: 'https://x.com/frogtest/status/1', independent: false } });
  assert.strictEqual(r.status, 'unverified claim');
  assert.strictEqual(r.endorsement, false);
  const self = N.claims(coin);
  assert.ok(self.length === 2 && self.every(c => c.status === 'unverified claim'), "the coin's own links are claims, not verification");
  // even an independent source must name this exact mint
  const other = N.assessClaim({ what: 'listed', mint: M, source: { url: 'https://news.example/x', independent: true, mint: 'SomeOtherMintpump' } });
  assert.strictEqual(other.status, 'unverified claim');
});

test('T19: many copycat tokens sharing a name cannot make social evidence verified', () => {
  const crosses = Array.from({ length: 12 }, (_, i) => [T0 / 1000 - 600 + i, 'Copy' + i + 'pump', ['frog']]);
  const d = N.dossier(coin, crosses, T0, { approved: false });
  assert.ok(d.nameCluster.count >= 5, `name repeated ${d.nameCluster.count} times`);
  assert.strictEqual(d.nameCluster.socialProof, false);
  assert.match(d.nameCluster.note, /copycats, not attention/);
  assert.strictEqual(d.attention.status, 'unavailable');
  assert.match(d.warning, /Evidence incomplete/);
  assert.strictEqual(d.identity.mint, M, 'identified by mint, not ticker');
  // with an approved source, mentions of a lookalike ticker on another mint do not count for this one
  const a = N.attention([{ mint: 'LookalikeFrogpump', cluster: 'g1', credible: true, firstSeenAt: T0 - 1 }, { mint: 'LookalikeFrogpump', cluster: 'g2', credible: true, firstSeenAt: T0 - 1 },
    { mint: 'LookalikeFrogpump', cluster: 'g3', credible: true, firstSeenAt: T0 - 1 }], M, T0, true);
  assert.strictEqual(a.status, 'uncertain');
  assert.strictEqual(a.offTarget, 3);
});
