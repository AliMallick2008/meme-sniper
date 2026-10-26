'use strict';
/* The v4 study (research/v4_protocol.md) on a moments file from v11_moments.js.
     node server/tools/v4_study.js train <moments.jsonl>                      choose candidates on the train window
     node server/tools/v4_study.js validate <moments.jsonl> <candidates.json> judge them on the validation window
   Candidates, chosen on train only by the mean outcome per trade with at least 40 train moments kept: (1) the best single
   feature threshold, (2) the best two-feature rule (both thresholds), (3) a logistic score on at most 5 standardized
   features (kept: score above the train threshold that maximizes the mean). Paper research: outcomes are the fixed exit
   rule of v11_moments.js on recorded curve states. */
const fs = require('fs');

const FEATS = ['sinceCrossMin', 'mc', 'r1', 'r3', 'buyShare5', 'netBuyers5', 'traders5',
  'tape.n30', 'tape.buyers30', 'tape.buyShare30', 'tape.ret30', 'tape.n60', 'tape.buyers60', 'tape.sellers60', 'tape.buySol60', 'tape.sellSol60',
  'tape.buyShare60', 'tape.topBuyShare60', 'tape.maxSell60', 'tape.bigSells60', 'tape.ret60', 'tape.ret180', 'tape.top3Share', 'tape.wallets',
  'tape.crSold', 'tape.vSol0', 'tape.progress'];
const MIN_TRAIN = 40, MIN_VALID = 25;
const get = (x, k) => k.split('.').reduce((o, p) => (o == null ? null : o[p]), x);
const num = v => (typeof v === 'number' && isFinite(v) ? v : typeof v === 'boolean' ? +v : null);
const mean = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const load = f => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(x => x.out && x.out.ret != null);

// a rule: [[feature, '>=' | '<=', threshold], ...]; keeps the moments that pass every condition (unknown never passes)
const pass = (x, rule) => rule.every(([k, op, t]) => { const v = num(get(x, k)); return v != null && (op === '>=' ? v >= t : v <= t); });
const quantiles = vals => { const s = vals.slice().sort((a, b) => a - b); const q = []; for (let i = 1; i < 10; i++) q.push(s[Math.floor(i * s.length / 10)]); return [...new Set(q)]; };
function evalRule(ms, rule) { const k = ms.filter(x => pass(x, rule)); return { n: k.length, mean: mean(k.map(x => x.out.ret)), rug: k.length ? k.filter(x => x.out.rug).length / k.length : null }; }

function singles(ms) {
  const out = [];
  for (const k of FEATS) {
    const vals = ms.map(x => num(get(x, k))).filter(v => v != null);
    if (vals.length < MIN_TRAIN) continue;
    for (const t of quantiles(vals)) for (const op of ['>=', '<=']) {
      const r = evalRule(ms, [[k, op, t]]);
      if (r.n >= MIN_TRAIN) out.push({ rule: [[k, op, t]], ...r });
    }
  }
  return out.sort((a, b) => b.mean - a.mean);
}
function pairs(ms, top) {
  const out = [];
  for (let i = 0; i < top.length; i++) for (let j = i + 1; j < top.length; j++) {
    if (top[i].rule[0][0] === top[j].rule[0][0]) continue;
    const rule = [top[i].rule[0], top[j].rule[0]], r = evalRule(ms, rule);
    if (r.n >= MIN_TRAIN) out.push({ rule, ...r });
  }
  return out.sort((a, b) => b.mean - a.mean);
}
// logistic regression (gradient descent) on standardized features predicting a positive outcome
function logistic(ms, feats) {
  const rows = ms.filter(x => feats.every(k => num(get(x, k)) != null));
  if (rows.length < MIN_TRAIN * 2) return null;
  const mu = feats.map(k => mean(rows.map(x => num(get(x, k))))), sd = feats.map((k, i) => Math.sqrt(mean(rows.map(x => (num(get(x, k)) - mu[i]) ** 2))) || 1);
  const X = rows.map(x => feats.map((k, i) => (num(get(x, k)) - mu[i]) / sd[i])), y = rows.map(x => (x.out.ret > 0 ? 1 : 0));
  let w = feats.map(() => 0), b = 0;
  for (let it = 0; it < 3000; it++) {
    const gw = w.map(() => 0); let gb = 0;
    X.forEach((xi, n) => { const z = b + xi.reduce((s, v, i) => s + v * w[i], 0), p = 1 / (1 + Math.exp(-z)), e = p - y[n]; gb += e; xi.forEach((v, i) => { gw[i] += e * v; }); });
    b -= 0.1 * gb / X.length; w = w.map((v, i) => v - 0.1 * (gw[i] / X.length + 0.01 * v));
  }
  const score = x => b + feats.reduce((s, k, i) => s + w[i] * (num(get(x, k)) - mu[i]) / sd[i], 0);
  const scores = rows.map(score).sort((a, c) => a - c);
  let best = null;
  for (let q = 1; q < 10; q++) {
    const t = scores[Math.floor(q * scores.length / 10)], kept = rows.filter(x => score(x) >= t);
    if (kept.length < MIN_TRAIN) continue;
    const m = mean(kept.map(x => x.out.ret));
    if (!best || m > best.mean) best = { t, n: kept.length, mean: m, rug: kept.filter(x => x.out.rug).length / kept.length };
  }
  return best && { feats, mu, sd, w, b, threshold: best.t, n: best.n, mean: best.mean, rug: best.rug };
}
const logScore = (L, x) => (L.feats.every(k => num(get(x, k)) != null) ? L.b + L.feats.reduce((s, k, i) => s + L.w[i] * (num(get(x, k)) - L.mu[i]) / L.sd[i], 0) : null);

if (require.main === module) {
  const mode = process.argv[2], ms = load(process.argv[3]);
  const base = { n: ms.length, mean: mean(ms.map(x => x.out.ret)), rug: ms.filter(x => x.out.rug).length / (ms.length || 1) };
  const f = v => (v == null ? '-' : (v >= 0 ? '+' : '') + (v * 100).toFixed(1) + '%');
  console.log(`${mode}: ${ms.length} moments with an outcome, ${new Set(ms.map(x => x.m)).size} coins; all moments: mean ${f(base.mean)} per trade, rugs ${(base.rug * 100).toFixed(0)}%`);
  if (mode === 'train') {
    const s = singles(ms), p = pairs(ms, s.slice(0, 30));
    // logistic on the 5 features whose best single rule did best (one feature each)
    const seen = new Set(), five = []; for (const x of s) { const k = x.rule[0][0]; if (!seen.has(k)) { seen.add(k); five.push(k); } if (five.length === 5) break; }
    const L = logistic(ms, five);
    console.log('\nbest single thresholds:'); for (const x of s.slice(0, 10)) console.log(`  ${JSON.stringify(x.rule)} n=${x.n} mean ${f(x.mean)} rugs ${(x.rug * 100).toFixed(0)}%`);
    console.log('\nbest two-feature rules:'); for (const x of p.slice(0, 5)) console.log(`  ${JSON.stringify(x.rule)} n=${x.n} mean ${f(x.mean)} rugs ${(x.rug * 100).toFixed(0)}%`);
    if (L) console.log(`\nlogistic on ${L.feats.join(', ')}: kept n=${L.n} mean ${f(L.mean)} rugs ${(L.rug * 100).toFixed(0)}%`);
    const cands = { single: s[0] ? s[0].rule : null, pair: p[0] ? p[0].rule : null, logistic: L, base };
    if (process.argv[4]) fs.writeFileSync(process.argv[4], JSON.stringify(cands, null, 1));
  } else if (mode === 'validate') {
    const C = JSON.parse(fs.readFileSync(process.argv[4], 'utf8'));
    const rows = [['all moments (no filter)', base]];
    if (C.single) rows.push(['single: ' + JSON.stringify(C.single), evalRule(ms, C.single)]);
    if (C.pair) rows.push(['pair: ' + JSON.stringify(C.pair), evalRule(ms, C.pair)]);
    if (C.logistic) { const k = ms.filter(x => { const s = logScore(C.logistic, x); return s != null && s >= C.logistic.threshold; }); rows.push(['logistic', { n: k.length, mean: mean(k.map(x => x.out.ret)), rug: k.length ? k.filter(x => x.out.rug).length / k.length : null }]); }
    for (const [name, r] of rows) console.log(`  ${name}: n=${r.n} mean ${f(r.mean)} rugs ${r.rug == null ? '-' : (r.rug * 100).toFixed(0) + '%'}`);
    // the protocol's pick: best validation mean among candidates with >= 25 moments, if it beats no-filter and is above 0
    const ok = rows.slice(1).filter(([, r]) => r.n >= MIN_VALID).sort((a, b) => b[1].mean - a[1].mean);
    const pick = ok.length && ok[0][1].mean > base.mean && ok[0][1].mean > 0 ? ok[0][0] : null;
    console.log(pick ? `\nPICK: ${pick}` : '\nNO PICK: no candidate beat the unfiltered moments with a positive mean on validation (no v4).');
  }
}
module.exports = { FEATS, pass, evalRule, singles, pairs, logistic, logScore };
