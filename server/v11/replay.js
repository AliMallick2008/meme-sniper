'use strict';
/* Replays recorded v11 event traces (V11_TRACE files: every event a server run ingested, in order, plus its ticks)
   through a fresh engine (audit Phase 3 ablations and E-experiments, Phase 5 validation).
   - exact mode: the live strategy set with the recorded quotes. Must reproduce the live books (a check of determinism and
     of the trace itself).
   - model mode: any strategy set; every account gets its quotes from one model desk (curve/pool math at the last
     observed price, 0.6 s after the request), so variants are compared on the same footing. Model fills are labeled as
     such: they are not live quotes, and the comparisons are between variants, not claims about real returns.
   A server restart inside the traces is replayed the way it happened live: the state goes through the same save and load.
   node server/v11/replay.js [--model] [--set live|ablations] trace1.jsonl [trace2.jsonl ...] */
const fs = require('fs');
const zlib = require('zlib');
const ENG = require('./engine.js');
const ST = require('./strategies.js');
const VIEW = require('./view.js');
const MODEL = require('./model.js');
const { SOL_MINT } = require('./parse.js');

function readTrace(files) {
  const out = [];
  for (const f of files) {
    const buf = fs.readFileSync(f), txt = f.endsWith('.gz') ? zlib.gunzipSync(buf).toString() : buf.toString();
    for (const l of txt.split('\n')) { if (!l.trim()) continue; try { out.push(JSON.parse(l)); } catch (e) { /* a run cut off mid-line */ } }
  }
  return out;
}
/* a quote from the model at the coin's last observed price (what a desk could have answered) */
function modelQuote(eng, r, at) {
  const S = eng.state(), m = r.outMint === SOL_MINT ? r.inMint : r.outMint, k = S.coins[m];
  const base = { type: 'quote', at: at + 0.6, req: at, inMint: r.inMint, outMint: r.outMint, amount: r.amount };
  const p = k && k.last;
  if (!p || !p.sol || at - p.at > 30 || k.stage === 'migrating') return Object.assign(base, { ok: false, why: 'no route' });
  const stage = k.stage === 'pool' ? 'pool' : 'curve', liq = stage === 'pool' ? p.liq : null, label = stage === 'pool' ? 'Pump.fun Amm' : 'Pump.fun';
  if (r.outMint === SOL_MINT) { const s = MODEL.sellOut(r.amount / 10 ** k.dec, p.sol, stage, liq, at); return Object.assign(base, { ok: true, inAmount: r.amount, outAmount: Math.floor(s.sol * 1e9), impact: Math.max(0, s.impact), labels: [label], model: true }); }
  const b = MODEL.buyOut(r.amount / 1e9, p.sol, stage, liq, at);
  return Object.assign(base, { ok: true, inAmount: r.amount, outAmount: Math.floor(b.tokens * 10 ** k.dec), impact: Math.max(0, b.impact), labels: [label], model: true });
}
/* events: the trace; strategies: the accounts to run; model: quotes from the model desk instead of the recorded ones */
function replay(events, strategies, { model = false, config } = {}) {
  let eng = ENG.create({ strategies, config }), started = false, pending = [];
  const desk = at => {
    for (const r of eng.requests(at)) { eng.sent(r.key, at); pending.push(modelQuote(eng, r, at)); }
  };
  for (const ev of events) {
    if (model) {   // model quotes due before this event
      const due = pending.filter(q => q.at <= ev.at); pending = pending.filter(q => q.at > ev.at);
      for (const q of due) eng.ingest(q);
    }
    if (ev.type === 'run_start') {
      if (started) eng = ENG.create({ strategies, config, state: JSON.parse(JSON.stringify(VIEW.persist(eng))) });
      started = true;
      if (model) pending = [];   // in-flight requests die with the process
    }
    if (ev.type === 'tick') eng.tick(ev.at);
    else if (ev.type === 'quote') { if (!model) eng.ingest(ev); }
    else eng.ingest(ev);
    if (model && ev.type === 'tick') desk(ev.at);
  }
  return eng;
}
function summary(eng) {
  return Object.values(eng.state().accts).map(A => {
    const realized = A.trades.reduce((s, t) => s + t.net, 0), wins = A.trades.filter(t => t.net > 0).length, e = eng.equity(A);
    return { id: A.id, label: A.label, trades: A.trades.length, wins, realized: +realized.toFixed(6), equity: +e.eq.toFixed(6), mdd: +A.mdd.toFixed(4), open: A.pos ? A.pos.sym : null,
      exits: A.trades.reduce((o, t) => (o[t.exitReason] = (o[t.exitReason] || 0) + 1, o), {}) };
  });
}
module.exports = { readTrace, replay, summary, modelQuote };

if (require.main === module) {
  const args = process.argv.slice(2), model = args.includes('--model'), si = args.indexOf('--set'), set = si >= 0 ? args[si + 1] : 'live';
  const files = args.filter((a, i) => !a.startsWith('--') && !(si >= 0 && i === si + 1));
  const strategies = set === 'ablations' ? ST.ablations() : [...ST.e0All(), ST.HOLD, ...ST.v2All()];
  const eng = replay(readTrace(files), strategies, { model });
  console.log(JSON.stringify({ mode: model ? 'model quotes' : 'recorded quotes', set, accounts: summary(eng) }, null, 1));
}
