'use strict';
/* What v11 saves: persist() = the engine state for v11.json, with the observation history of coins nobody watches or
   holds dropped (the event log on the research branch keeps it); page() = the compact view inside state.json that the
   dashboard reads (accounts, positions with thesis and mark source, recent trades, gaps, decisions, gates). */
const r6 = v => v == null || !isFinite(v) ? v : +(+v).toPrecision(6);

function activeMints(S) {
  const s = new Set();
  for (const A of Object.values(S.accts)) { if (A.pos) s.add(A.pos.m); for (const w of A.watch) if (!w.done) s.add(w.m); }
  for (const o of Object.values(S.orders)) s.add(o.m);
  return s;
}
/* every row newer than `cut`, at most one per `gap` seconds */
function every(rows, cut, gap, t = r => r[0]) { const out = []; let last = -Infinity; for (const r of rows) { const x = t(r); if (x > cut && x - last >= gap) { out.push(r); last = x; } } return out; }
function persist(eng) {
  const S = eng.state(), at = S.lastAt || 0, act = activeMints(S), held = new Set(Object.values(S.accts).filter(A => A.pos).map(A => A.pos.m)), coins = {};
  for (const [m, k] of Object.entries(S.coins)) {
    // what a restart needs: 15 min of prices, 6 min of flow and snapshots (feature windows), candles only for held coins
    const c = Object.assign({}, k, { obs: [], flow: [], snaps: [], bars: [], bar: null, cs: {}, socialObs: (k.socialObs || []).slice(-60) });
    if (k.auditLast === k.audit) delete c.auditLast;
    if (k.rcLast === k.rc) delete c.rcLast;
    if (act.has(m)) {   // held coins at full detail; watched ones coarser (features recover within minutes after a restart)
      const h = held.has(m);
      c.obs = every(k.obs, at - 960, h ? 10 : 30); c.flow = every(k.flow, at - 420, h ? 10 : 60); c.snaps = every(k.snaps, at - 420, h ? 15 : 60, x => x.at).map(x => Object.assign({}, x, { s1h: undefined }));
      c.bars = k.bars.slice(-6); c.bar = k.bar;
      if (h) for (const t of Object.keys(k.cs).map(Number).sort((a, b) => a - b).slice(-90)) c.cs[t] = k.cs[t];
    }
    coins[m] = c;
  }
  return Object.assign({}, S, { coins });
}
function compactPos(p) {
  return { id: p.id, m: p.m, sym: p.sym, at: p.at, sigAt: p.sigAt, quoteReq: p.quoteReq, quoteAt: p.quoteAt, fillAt: p.fillAt, stake: p.stake, qty: r6(p.qty), px: r6(p.px),
    mkt: r6(p.mkt), cost: r6(p.cost), impact: r6(p.impact), slip: r6(p.slip), route: p.route, stage: p.stage, why: p.why, state: p.state, states: (p.states || []).slice(-6),
    rules: p.rules, flags: p.flags, thesis: p.thesis || null, exitFails: p.exitFails || 0,
    mark: p.mark ? { at: p.mark.at, v: r6(p.mark.v), src: p.mark.src, why: p.mark.why, worst: r6(p.mark.worst), last: r6(p.mark.last), lastAt: p.mark.lastAt } : null,
    mae: r6(p.mae), mfe: r6(p.mfe), maeLo: r6(p.maeLo), fam: p.fam || null };
}
function compactTrade(t) {
  return { id: t.id, m: t.m, sym: t.sym, sigAt: t.sigAt, at: t.at, quoteReq: t.quoteReq, quoteAt: t.quoteAt, fillAt: t.fillAt, stake: t.stake, px: r6(t.px), mkt: r6(t.mkt),
    slip: r6(t.slip), impact: r6(t.impact), why: t.why, exitAt: t.exitAt, exitQuoteReq: t.exitQuoteReq, exitQuoteAt: t.exitQuoteAt, exitFillAt: t.exitFillAt, exitWhy: t.exitWhy,
    exitReason: t.exitReason, exitRoute: t.exitRoute, exitMark: r6(t.exitMark), proceeds: r6(t.proceeds), net: r6(t.net), ret: r6(t.ret), mae: r6(t.mae), mfe: r6(t.mfe),
    maeLo: r6(t.maeLo), holdS: Math.round(t.holdS || 0), flags: t.flags, fees: t.fees ? { fixed: r6(t.fees.fixed), latency: r6(t.fees.latency) } : null, late: t.late };
}
/* at most n points: every row of the last hour, then evenly thinned */
function thin(rows, n) {
  if (rows.length <= n) return rows;
  const tail = rows.slice(-60), head = rows.slice(0, -60), k = Math.max(1, Math.ceil(head.length / Math.max(1, n - 60)));
  const out = [];
  for (let i = 0; i < head.length; i += k) { const g = head.slice(i, i + k); out.push([g[0][0], Math.min(...g.map(r => r[1])), Math.min(...g.map(r => r[2])), g.some(r => r[3] === 'u') ? 'u' : g[g.length - 1][3]]); }
  return out.concat(tail);
}
function page(eng, rt) {
  const S = eng.state(), C = eng.C, refs = new Set();
  const accts = Object.values(S.accts).map(A => {
    const e = eng.equity(A), realized = A.trades.reduce((s, t) => s + t.net, 0);
    if (A.pos) refs.add(A.pos.m);
    for (const t of A.trades.slice(-6)) refs.add(t.m);
    const live = A.watch.filter(w => !w.done);
    const watch = live.slice(-8).map(w => ({ m: w.m, sym: w.sym, from: w.from, to: w.to, trig: r6(w.trig), H: r6(w.H), ready: w.ready, armed: !!w.armed, lag: w.lag }));
    return { id: A.id, kind: A.kind, label: A.label, locked: A.locked, start: A.start, cash: r6(A.cash), rent: r6(A.rent), eq: r6(e.eq), lo: r6(e.lo), src: e.src, age: e.age,
      realized: r6(realized), n: A.n, trades: A.trades.length, wins: A.trades.filter(t => t.net > 0).length, mdd: r6(A.mdd), mddLo: r6(A.mddLo),
      pos: A.pos ? compactPos(A.pos) : null, watching: live.length, watch, recent: A.trades.slice(-6).map(compactTrade), eqs: thin(A.eq, 72), scan: A.scan ? { at: A.scan.at, rows: A.scan.rows.slice(0, 5) } : null };
  });
  const coins = {};
  for (const m of refs) {
    const k = S.coins[m]; if (!k) continue;
    const a = k.audit, r = k.rc;
    coins[m] = { sym: k.sym, name: k.name, t0: k.t0, stage: k.stage, stageAt: k.stageAt, bc: k.bc, pool: k.pool, cross: k.cross, hi: r6(k.hi),
      last: k.last ? { at: k.last.at, usd: r6(k.last.usd), mc: r6(k.last.mc), src: k.last.src } : null,
      g0: k.g0 ? { at: k.g0.at, eligibleAt: k.g0.eligibleAt, score: k.g0.score } : null, gs: k.gs || null, meme: k.meme,
      audit: a ? { at: a.at, req: a.req, missing: a.missing, mintOff: a.mintOff, freezeOff: a.freezeOff, dev: a.dev, top: a.top, devMints: a.devMints, holders: a.holders, org: a.org, soc: a.soc } : null,
      rc: r ? { at: r.at, req: r.req, missing: r.missing, sn: r.sn, danger: r.danger } : null, social: k.social || null };
  }
  return { v: 1, exp: S.exp, version: S.version, t: S.lastAt, created: S.created, status: S.status, runs: S.runs.slice(-5),
    gaps: S.gaps.slice(-10).map(g => ({ id: g.id, from: g.from, to: g.to, why: g.why, cancelled: g.cancelled.length, open: g.open.length, hypo: g.hypo })),
    accts, coins, dec: S.dec.slice(-40), hypo: S.hypo.slice(-30), errors: S.errors.slice(-10), n: S.n,
    rt: rt ? { events: rt.events, errors: rt.errors, quotes: rt.quotes, snaps: rt.snaps, dex: rt.dex, files: rt.files, lastErr: rt.lastErr, disabled: rt.disabled } : null,
    cfg: { latency: C.latency, prioSol: C.prioSol, netFeeSol: C.netFeeSol, rentSol: C.rentSol, orderTtlS: C.orderTtlS, pxFreshS: C.pxFreshS, gapS: C.gapS } };
}
module.exports = { persist, page, compactTrade, compactPos, activeMints };
