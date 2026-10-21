'use strict';
/* Ablation and baseline replays on recorded v11 inputs (audit D2/D3).
     node server/tools/v11_ablation.js <dir> [--from 2026-10-21T17:00Z] [--to ...] [--latency 1000] [--drift 0.005] [--json out.json]
   <dir> holds v11-inputs/ (a checkout of the research branch or a sim output folder).

   Every variant sees exactly the same recorded market (crossings, checks, RugCheck reports, prices, order flow, SOL
   price, run starts) in the order it arrived. Orders are filled from the model at the last observed price `latency` ms
   after the decision (a live run used real quotes; these replays cannot), so all variants here share one execution
   model and are comparable with each other, not with the live ledger. The engine runs continuously (no restarts trim
   its memory), and time the server was not running stays uncovered, as it was live.

   Variants: the live strategies (A, B, C), and for each: "~timed" (identical entries, exit only at the horizon),
   "~nodemand" (no order-flow confirmation), "~random" (same moment, a random coin among those that passed the gates);
   the seven E0 accounts (legacy rules, honest timing) and HOLD. */
const fs = require('fs');
const REC = require('../v11/record.js');
const ST = require('../v11/strategies.js');
const V2 = require('../v11/v2.js');
const X = require('../v11/model.js');
const MK = require('../v11/market.js');
const FEES = require('../v11/fees.js');
const { createEngine } = require('../v11/engine.js');
const { files } = require('./v11_replay.js');

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };

function variants() {
  const base = V2.accounts(), out = ST.accounts();
  for (const a of base) {
    out.push(a);
    for (const [suf, ab, what] of [['timed', { timedOnly: true }, 'identical entries, exits only at the horizon'], ['nodemand', { noDemand: true }, 'no order-flow confirmation'],
      ['random', { random: true }, 'same moments, a random coin that passed the gates']]) {
      out.push(Object.assign({}, a, { id: `${a.id}~${suf}`, exp: `${a.exp}~${suf}`, name: `${a.name} (${what})`, ablate: ab, P: Object.assign({}, a.P), C: Object.assign({}, a.C) }));
    }
    // v2.1 candidates noted in research/v2_protocol.md (parameters only; same code)
    const cand = [['volcap', { volCap: 0.30 }, 'structure threshold capped at 30%']];
    if (a.strat === 'A') cand.push(['nospike', { r1Max: 0.25 }, 'no entry after a 25%+ minute']);
    for (const [suf, extra, what] of cand)
      out.push(Object.assign({}, a, { id: `${a.id}~${suf}`, exp: `${a.exp}~${suf}`, name: `${a.name} (${what})`, P: Object.assign({}, a.P, extra), C: Object.assign({}, a.C) }));
  }
  return out;
}

function run(dir, { from = 0, to = Infinity, latency = 1000, accounts = variants } = {}) {
  const list = files(require('path').join(dir, 'v11-inputs'));
  const eng = createEngine({ accounts });
  let started = false, last = 0, n = { events: 0, ticks: 0, quotes: 0, noPrice: 0 };
  const pending = [];
  const answer = (upTo) => {
    pending.sort((a, b) => a.at - b.at);
    while (pending.length && pending[0].at <= upTo) {
      const q = pending.shift(), c = eng.state().coins[q.r.m];
      const p = c && MK.fresh(c, q.at, 30000);
      n.quotes++;
      if (!p || !(p.ps > 0)) { n.noPrice++; eng.ingest({ id: `mq:${q.r.orderId || q.r.m}:${q.at}`, type: 'quote', at: q.at, orderId: q.r.orderId, m: q.r.m, side: q.r.side, inAmount: q.r.amount, ok: false, err: 'no fresh price for a model fill', transport: true, valid: true }); continue; }
      const venue = c.stage === 'pool' ? 'pool' : 'curve';
      const o = q.r.side === 'buy' ? X.buyOut(q.r.amount / 1e9, p.ps, venue, q.at) : X.sellOut(q.r.amount / 1e6, p.ps, venue, q.at);
      const out = q.r.side === 'buy' ? o.tokens * 1e6 : o.sol * 1e9;
      const ideal = q.r.side === 'buy' ? q.r.amount / 1e9 / p.ps * 1e6 : q.r.amount / 1e6 * p.ps * 1e9;
      eng.ingest({ id: `mq:${q.r.orderId || q.r.m}:${q.at}`, type: 'quote', at: q.at, orderId: q.r.orderId, m: q.r.m, side: q.r.side, inAmount: q.r.amount, outAmount: Math.floor(out),
        impactPct: Math.max(0, 1 - out / ideal), route: [venue === 'pool' ? 'Pump.fun Amm' : 'Pump.fun'], venue, ok: true, valid: true, model: true });
    }
  };
  for (const it of REC.decode(list.map(f => fs.readFileSync(f)))) {
    const at = it.k === 'event' ? it.ev.at : it.at;
    if (at < from) continue;
    if (at > to) break;
    if (!started) { eng.init(at); started = true; }
    answer(at);
    if (it.k === 'event') {
      const t = it.ev.type;
      if (t === 'quote') continue;                       // live quotes belong to live orders; replays use the model
      n.events++; try { eng.ingest(it.ev); } catch (e) { /* as live */ }
    } else if (it.k === 'tick') {
      n.ticks++;
      let reqs = []; try { reqs = eng.tick(it.at); } catch (e) { /* as live */ }
      eng.drain();
      for (const r of reqs) pending.push({ at: it.at + latency, r });
    }
    last = at;
  }
  answer(Infinity);
  return { eng, n, last };
}

// Toronto calendar day of a time (the owner's day), and a day-level bootstrap of the mean daily P&L (audit D3: intervals
// over days, not trades). Days in the window with no closed trade count as 0.
const DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto' });
const dayOf = ms => DAY.format(new Date(ms));
function daily(trades, from, to) {
  const days = new Map();
  for (let t = from; t <= to + 86400e3; t += 3600e3) { const d = dayOf(t); if (t <= to) days.set(d, 0); }
  for (const t of trades) { const d = dayOf(t.closeAt); days.set(d, (days.get(d) || 0) + t.net); }
  return [...days.entries()].sort();
}
function bootstrap(vals, n = 2000, seed = 7) {
  if (vals.length < 2) return null;
  let x = seed; const rnd = () => { x = (Math.imul(x, 1103515245) + 12345) >>> 0; return x / 4294967296; };
  const means = [];
  for (let i = 0; i < n; i++) { let s = 0; for (let j = 0; j < vals.length; j++) s += vals[Math.floor(rnd() * vals.length)]; means.push(s / vals.length); }
  means.sort((a, b) => a - b);
  return { lo: means[Math.floor(0.05 * n)], hi: means[Math.floor(0.95 * n)] };
}
function report(eng, split) {
  const S = eng.state(), rows = [];
  for (const A of Object.values(S.accts)) {
    const tr = split ? A.trades.filter(split) : A.trades;
    const wins = tr.filter(t => t.net > 0), losses = tr.filter(t => t.net <= 0);
    const gw = wins.reduce((s, t) => s + t.net, 0), gl = -losses.reduce((s, t) => s + t.net, 0);
    const eq = eng.equityNow(A);
    const by = {}; for (const t of tr) by[t.exitReason] = (by[t.exitReason] || 0) + 1;
    const days = daily(tr, S.startedAt, S.lastAt).map(d => d[1]);
    const ci = bootstrap(days);
    rows.push({ id: A.id, trades: tr.length, wins: wins.length, net: tr.reduce((s, t) => s + t.net, 0), pf: gl > 0 ? gw / gl : (gw > 0 ? Infinity : null),
      days: days.length, perDay: days.length ? days.reduce((a, b) => a + b, 0) / days.length : null, perDayCI: ci, worstDay: days.length ? Math.min(...days) : null, greenDays: days.filter(v => v > 0).length,
      avg: tr.length ? tr.reduce((s, t) => s + t.ret, 0) / tr.length : null, best: tr.length ? Math.max(...tr.map(t => t.ret)) : null, worst: tr.length ? Math.min(...tr.map(t => t.ret)) : null,
      mdd: A.mdd, value: eq.value, open: A.pos ? A.pos.sym : null, exits: by, funnel: A.funnel || null });
  }
  return rows;
}
const f3 = v => v == null ? '   -  ' : (v >= 0 ? '+' : '') + v.toFixed(3);
const pc = v => v == null ? '  -  ' : (v * 100).toFixed(1) + '%';
function print(rows, title) {
  console.log(`\n${title}`);
  console.log('account          trades wins   net SOL   PF    avg     best    worst   maxDD  per day (90% CI, days)        green days  exits');
  for (const r of rows) console.log(`${r.id.padEnd(16)} ${String(r.trades).padStart(5)} ${String(r.wins).padStart(4)} ${f3(r.net).padStart(9)} ${(r.pf == null ? '-' : r.pf === Infinity ? 'inf' : r.pf.toFixed(2)).padStart(5)} ${pc(r.avg).padStart(7)} ${pc(r.best).padStart(7)} ${pc(r.worst).padStart(7)} ${pc(r.mdd).padStart(6)}  ` +
    `${f3(r.perDay)} ${r.perDayCI ? `[${f3(r.perDayCI.lo)}, ${f3(r.perDayCI.hi)}]` : '[too few days]'} ${String(r.days).padStart(2)}d  ${String(r.greenDays).padStart(3)}/${r.days}  ${Object.entries(r.exits).map(([k, v]) => k + ':' + v).join(' ')}${r.open ? ' (open ' + r.open + ')' : ''}`);
}

if (require.main === module) {
  const dir = process.argv[2];
  const from = arg('from') ? Date.parse(arg('from')) : 0, to = arg('to') ? Date.parse(arg('to')) : Infinity;
  const latency = +arg('latency', 1000);
  if (arg('drift')) FEES.COSTS.landingDrift = +arg('drift');
  const t0 = Date.now();
  const { eng, n, last } = run(dir, { from, to, latency });
  const S = eng.state();
  console.log(`replayed ${n.events} market events and ${n.ticks} ticks from ${new Date(S.startedAt).toISOString()} to ${new Date(last).toISOString()} in ${((Date.now() - t0) / 1000).toFixed(1)} s; ${n.quotes} model fills (${n.noPrice} without a fresh price), drift ${FEES.COSTS.landingDrift}, latency ${latency} ms`);
  const rows = report(eng);
  print(rows, 'all trades');
  // protocol split: decisions in the first 60% of the window choose, the last 40% judge
  const cut = S.startedAt + 0.6 * (last - S.startedAt);
  print(report(eng, t => t.decidedAt < cut), `choose (decided before ${new Date(cut).toISOString()})`);
  print(report(eng, t => t.decidedAt >= cut), 'judge (decided after)');
  for (const r of rows) if (r.funnel) console.log(`funnel ${r.id.padEnd(14)} ${JSON.stringify(r.funnel)}`);
  if (arg('json')) fs.writeFileSync(arg('json'), JSON.stringify({ n, rows, cut }, null, 1));
}
module.exports = { run, report, variants, daily, bootstrap };
