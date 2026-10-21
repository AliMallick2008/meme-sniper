'use strict';
/* node server/v11/check.js <v11.json>: checks a saved v11 state against the invariants and prints a JSON summary
   (used by the simulator test and for spot checks of the live state). */
const fs = require('fs');
const VERIFY = require('./verify.js');
const S = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const accts = Object.values(S.accts).map(A => {
  const realized = A.trades.reduce((s, t) => s + t.net, 0);
  return { id: A.id, start: A.start, trades: A.trades.length, wins: A.trades.filter(t => t.net > 0).length, realized, cash: A.cash, open: A.pos ? { sym: A.pos.sym, state: A.pos.state, mark: A.pos.mark } : null,
    n: A.n, mdd: A.mdd, mddLo: A.mddLo, list: A.trades.map(t => ({ m: t.m, sym: t.sym, sigAt: t.sigAt, at: t.at, quoteAt: t.quoteAt, exitAt: t.exitAt, exitQuoteAt: t.exitQuoteAt, reason: t.exitReason, net: t.net, ret: t.ret, slip: t.slip, mae: t.mae, mfe: t.mfe })),
    pos: A.pos ? { m: A.pos.m, sym: A.pos.sym, sigAt: A.pos.sigAt, at: A.pos.at, quoteAt: A.pos.quoteAt } : null, watch: A.watch.map(w => ({ m: w.m, from: w.from, to: w.to, done: w.done, lag: w.lag })) };
});
console.log(JSON.stringify({ violations: VERIFY.check(S), status: S.status, n: S.n, gaps: S.gaps.map(g => ({ from: g.from, to: g.to, why: g.why, cancelled: g.cancelled.length, open: g.open.length, hypo: g.hypo })), hypo: S.hypo, dup: S.dup, errors: S.errors.slice(-8), accts }));
