'use strict';
/* v11 Phase 4 (narrative evidence): audit tests T08, T09, T19, and Finding 06's acceptance tests. */
const test = require('node:test');
const assert = require('node:assert');
const { World, addr, ST } = require('./v11_world.js');
const SOCIAL = require('../v11/social.js');
const GATES = require('../v11/gates.js');
const LEGACY = require('../sniper.js');

const coin = () => ({ m: addr('pump'), sym: 'FROG', name: 'Frog', meme: { score: 0, word: null }, socialObs: [] });
const post = (k, at, i, o) => SOCIAL.ingest(k, Object.assign({ m: k.m, src: 'x', id: 'p' + i, author: 'user' + i, text: `post ${i}`, mint: true, kind: 'post' }, o), at, { source: 'x' });

test('T08: mentions copied by one group of accounts do not make verified hype', () => {
  const k = coin(), t0 = 1792500000;
  // 12 accounts post the same promo text (small edits), all naming the exact mint, attention "growing"
  for (let i = 0; i < 12; i++) post(k, t0 + 600 + i * 40, i, { text: `🚀 ${k.m} FROG is the next 100x, get in now before it moons!!! ${i % 3 ? '' : 'LFG'}` });
  let a = SOCIAL.assess(k, t0 + 1100, { source: 'x' });
  assert.strictEqual(a.attention.mintMentions, 12);
  assert.strictEqual(a.attention.independent, 1, 'one voice');
  assert.strictEqual(a.attention.copies, 11);
  assert.notStrictEqual(a.status, 'verified');
  assert.match(a.warnings.join(), /1 independent voice \(11 copies merged\)/);
  // different texts but one declared account cluster: still one voice
  const k2 = coin();
  for (let i = 0; i < 8; i++) post(k2, t0 + 600 + i * 40, i, { cluster: 'ring-7', text: ['gm frens', 'this chart is clean', 'dev is based', 'cto incoming', 'whales loading', 'listing soon', 'low cap gem', 'not financial advice'][i] });
  assert.strictEqual(SOCIAL.assess(k2, t0 + 1100, { source: 'x' }).attention.independent, 1);
});

test('T09: a celebrity or partner claim without a confirming source is labeled unverified, never an endorsement', () => {
  const k = coin(), t0 = 1792500000;
  SOCIAL.ingest(k, { m: k.m, src: 'x', id: 'c1', author: 'frogdev', kind: 'partner_claim', text: 'Official partnership with a famous exchange founder, announcement soon', url: 'https://x.com/frogdev/1' }, t0, { source: 'x' });
  const a = SOCIAL.assess(k, t0 + 10, { source: 'x' });
  const c = a.claims.find(x => x.kind === 'partner');
  assert.ok(c); assert.match(c.status, /unverified/);
  assert.notStrictEqual(a.status, 'verified');
  assert.match(a.warnings.join(), /partnership or celebrity claims are unverified/);
  // links the listing declares are claims too
  k.jclaims = { tw: 'https://x.com/frogcoin', web: 'https://frog.example' };
  assert.ok(SOCIAL.assess(k, t0 + 20, { source: 'x' }).claims.filter(x => x.by === 'token listing (Jupiter)').every(x => x.status === 'unverified claim'));
});

test('T19: copycat coins sharing a name word are a name cluster, not social proof', () => {
  const w = new World({ strategies: [ST.E0(LEGACY.RULES.BOTS[0]), ST.V2('B')] });
  const T = w.t0 + 1000;
  const cs = [];
  for (let i = 0; i < 10; i++) cs.push(w.coin({ name: 'Pepe Clone', sym: 'PEPE' + i, created: T - 900 + i * 30, price: t => t < T - 600 + i * 30 ? 3000 : 8000 }));
  const k = w.coin({ name: 'Pepe Clone', sym: 'PEPEX', created: T - 300, price: t => t < T ? 3000 : 8000 });
  w.checks(k, T + 20, T + 25).run(T + 60);
  const S = w.eng.state(), c = S.coins[k.m];
  assert.ok(c.meme.score >= 10, `name cluster ${c.meme.score}`);
  assert.strictEqual(c.social.status, 'unavailable', 'no social source: unknown, not "hype"');
  assert.match(c.social.nameCluster.note, /not social proof/);
  assert.match(GATES.legacy(c, LEGACY.RULES.CHK).res.find(r => r.id === 'meme').text, /name cluster, not social proof/);
  // the v2 strategies never read the name cluster: their thesis records social evidence separately
  assert.ok(!JSON.stringify(require('../v11/strategies.js').SPECS).includes('meme'));
});

test('F06: unavailable is unknown, not "no interest"; genuine independent, growing, mint-specific attention can be verified', () => {
  const k = coin(), t0 = 1792500000;
  assert.strictEqual(SOCIAL.assess(k, t0, { source: null }).status, 'unavailable');
  assert.strictEqual(SOCIAL.assess(k, t0, { source: 'x' }).status, 'none_found');
  const texts = ['the frog art on this one is genuinely funny', 'bought a little, community chat is active', 'saw the frog meme on my timeline three times today',
    'dev answered questions on stream, fair launch it seems', 'my friend made a frog sticker pack lol', 'chart aside, the memes are good', 'frog is trending in our group'];
  post(k, t0 + 100, 0, { text: texts[0] });
  for (let i = 1; i < 7; i++) post(k, t0 + 700 + i * 30, i, { text: texts[i] });
  const a = SOCIAL.assess(k, t0 + 950, { source: 'x' });
  assert.strictEqual(a.attention.independent, 7);
  assert.strictEqual(a.status, 'verified');
  // the same posts naming only a ticker-like word, not the mint: never verified
  const k2 = coin();
  for (let i = 0; i < 7; i++) post(k2, t0 + 700 + i * 30, i, { text: texts[i], mint: false });
  assert.strictEqual(SOCIAL.assess(k2, t0 + 950, { source: 'x' }).status, 'uncertain');
});
