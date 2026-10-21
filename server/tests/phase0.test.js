'use strict';
/* Phase 0 guards: the project stays paper-only, and the legacy-v10 baseline (rules + exported journal) stays intact. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const ROOT = path.join(__dirname, '..', '..');

function sources(dirs, exts) {
  const out = [];
  const walk = d => { for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, f.name);
    if (f.isDirectory()) { if (!/node_modules|\.out|dist|tests|vendor|__pycache__/.test(f.name)) walk(p); }
    else if (exts.some(e => f.name.endsWith(e))) out.push(p);
  } };
  for (const d of dirs) walk(path.join(ROOT, d));
  return out;
}

test('paper only: no wallet, key, signing or order-submission code', () => {
  const banned = [/privateKey/i, /secretKey/i, /\bKeypair\b/, /signTransaction/i, /sendTransaction/i, /sendRawTransaction/i,
    /\/swap\/v1\/swap\b/, /swap-instructions/, /\/swap\/v2\/execute/, /\bwallet\.connect\b/i, /window\.solana\b/, /phantom/i, /mnemonic/i];
  const hits = [];
  for (const f of sources(['server', 'dashboard'], ['.js', '.html'])) {
    const s = fs.readFileSync(f, 'utf8');
    for (const re of banned) if (re.test(s)) hits.push(`${path.relative(ROOT, f)}: ${re}`);
  }
  assert.deepStrictEqual(hits, []);
});

test('legacy-v10 baseline: exported journal unchanged and legacy rules still the locked ones', () => {
  const dir = path.join(ROOT, 'baseline', 'legacy-v10');
  const man = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const sha = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, man.journal_file))).digest('hex');
  assert.strictEqual(sha, man.journal_sha256, 'journal snapshot was modified');
  const E = require(path.join(ROOT, 'server', 'sniper.js'));
  const now = { LOCKED: E.RULES.LOCKED, START_SOL: E.RULES.START_SOL, BASE: E.RULES.BASE, CHK: E.RULES.CHK, FOLLOW_S: E.RULES.FOLLOW_S,
    DEAD_S: E.RULES.DEAD_S, DEAD_MC: E.RULES.DEAD_MC, CROSS_MC: E.RULES.CROSS_MC, WATCH_S: E.RULES.WATCH_S, META_S: E.RULES.META_S,
    SLOTS: E.RULES.SLOTS, BOTS: E.RULES.BOTS.map(b => ({ id: b.id, name: b.name, P: b.P, C: b.C })) };
  assert.deepStrictEqual(JSON.parse(JSON.stringify(now)), man.rules, 'legacy rules changed');
  // the exported journal is readable and its balances recompute to the recorded ones
  const st = JSON.parse(fs.readFileSync(path.join(dir, man.journal_file), 'utf8'));
  for (const [id, B] of Object.entries(st.J.bots)) {
    const bal = Math.round((10 + B.trades.reduce((s, t) => s + t.net, 0)) * 1e9) / 1e9;
    assert.strictEqual(bal, man.accounts_at_export[id].realized_sol, id);
  }
});
