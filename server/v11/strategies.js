'use strict';
/* v11 accounts. Every rule set is locked at a recorded time before its account starts; a change is a new id.
   - E0-*: the seven locked legacy v10 rule sets (U, U2, U30, T25, D55, GRN, STR) with causal timing (audit experiment E0):
     same checks (legacy unknown-as-pass habits included, labeled), same 40% / 55% dip from the observed high since launch,
     same re-arm rule, same 6-coin watchlist, same targets, stops and time limits. What changes: the watch starts when the
     checks have arrived, a signal is a live price observation, a green bar is known only when its minute has ended, and
     the fill is the next quote requested after the decision. Measures how much of legacy P&L survives honest timing.
   - HOLD: keeps its 10 SOL (the no-trade baseline). */
const LEGACY = require('../sniper.js');
const R = LEGACY.RULES;

const E0_LOCKED = Date.UTC(2026, 9, 21, 11, 0, 0) / 1000;   // Wed Oct 21 2026, 7:00 AM ET
const E0_SLIP = 0.10;   // a buy fills only if the quote is at most 10% over the observed signal price (fees and impact included)

function E0(bot) {
  const P = bot.P, label = `E0 ${bot.name}`;
  const near = (ctx, w) => { const k = ctx.coin(w.m); return !k || !k.last || !(w.trig > 0) || (w.ready ? k.last.usd <= w.trig * 1.25 : k.last.usd >= w.trig * 0.95); };
  return {
    id: 'E0-' + bot.id, kind: 'E0', gate: 'legacy', label, legacy: bot.id, locked: E0_LOCKED, P, Cg: bot.C,
    rules: { P, C: bot.C, watchS: R.WATCH_S, slots: R.SLOTS, maxSlip: E0_SLIP },
    onEligible(ctx, A, k, eligibleAt) {
      if (A.watch.some(w => w.m === k.m)) return;
      const to = k.cross.at + R.WATCH_S, lag = Math.round(eligibleAt - k.cross.at);
      if (eligibleAt >= to) { ctx.dec(A.id, 'missed', `${label}: ${k.sym} passed its checks only after its 2 h window`, k.m); return; }
      const live = A.watch.filter(w => !w.done && w.to > eligibleAt);
      if (live.length >= R.SLOTS) {
        const weak = live.filter(w => !near(ctx, w)).sort((a, b) => a.score - b.score)[0];
        if (!weak || weak.score >= k.g0.score) { ctx.dec(A.id, 'skip', `${label}: ${k.sym} passed, but every watch slot holds a stronger coin`, k.m); return; }
        weak.done = 'dropped'; weak.doneAt = eligibleAt;
      }
      A.watch.push({ m: k.m, sym: k.sym, from: eligibleAt, to, ready: !P.rearm, armed: false, done: null, score: k.g0.score, lag });
      ctx.dec(A.id, 'watch', `${label}: watching ${k.sym} for a ${Math.round(P.dip * 100)}% dip (checks arrived ${lag} s after the $7K crossing; the watch starts then, not at the crossing)`, k.m, { lag });
    },
    entry(ctx, A, at) {
      if (ctx.halted()) return;
      const C = ctx.C, stake = Math.min(P.stake, A.cash - C.prioSol - C.netFeeSol - C.rentSol);
      for (const w of A.watch) {
        if (w.done) continue;
        if (at >= w.to) { w.done = 'nodip'; w.doneAt = at; continue; }
        if (at < w.from || (w.coolUntil && at < w.coolUntil)) continue;
        const k = ctx.coin(w.m);
        if (!k || !k.last) continue;
        const H = ctx.high(k); if (!(H > 0)) continue;
        const trig = (1 - P.dip) * H, p = k.last;
        w.H = H; w.trig = trig;
        if (p.at < Math.max(w.from, w.rearmAt || 0, w.failAt || 0)) continue;   // only observations after the watch (re)started
        if (!w.ready) { if (p.usd > trig) w.ready = true; else continue; }     // re-arm: it has to trade above the buy level first
        let how = null;
        if (P.entry === 'limit') { if (p.usd <= trig) how = `${Math.round((1 - p.usd / H) * 100)}% under its high`; }
        else {
          if (!w.armed && p.usd <= trig) { w.armed = true; w.armAt = p.at; }
          if (w.armed) {   // the first green 1-minute bar after the dip, known only once its minute has ended
            const b = ctx.lastBar(k, at), t0 = Math.floor(w.armAt / 60) * 60;
            if (b && b[0] >= t0 && b[0] > (w.barUsed || 0) && b[5] >= 2 && b[4] > b[1]) { w.barUsed = b[0]; how = `first green minute after the dip (closed ${new Date((b[0] + 60) * 1000).toISOString().slice(11, 19)} UTC)`; }
          }
        }
        if (!how) continue;
        const why = ctx.blocked(k, at);
        if (why) { w.lastBlock = [at, why]; continue; }
        if (!(stake >= 0.05)) return;
        const o = ctx.buy(A, { m: k.m, stake, sigAt: p.at, sigPx: p.sol, maxPx: p.sol * (1 + E0_SLIP), why: how,
          snap: { H, trig, usd: p.usd, sol: p.sol, mc: p.mc, obsAt: p.at, stage: k.stage, eligibleAt: w.from, cross: k.cross.at } }, at);
        if (o) { w.sigAt = at; return; }
      }
    },
    onFail(ctx, A, o, why, at) {
      if (o.side !== 'buy') return;
      const w = A.watch.find(x => x.m === o.m && !x.done);
      if (w) { w.failAt = at; w.coolUntil = at + 10; }   // a new decision needs a new observation
    },
    onFill(ctx, A, pos, at) {
      const C = ctx.C, k = ctx.coin(pos.m), fixed = C.prioSol + C.netFeeSol;
      const mkt = pos.mkt || pos.px;
      const tpVal = pos.cost * (1 + P.tp);
      pos.rules = { tpVal, tpPx: ctx.MODEL.priceFor(pos.qty, (tpVal + fixed) / (1 - C.latency), k.stage === 'pool' ? 'pool' : 'curve', ctx.liqOf(k), at),
        slPx: P.sl ? (1 - P.sl) * mkt : null, maxHoldS: P.maxHold ? P.maxHold * 60 : null };
      if (pos.rules.slPx && k.stage === 'curve' && pos.rules.slPx < ctx.MODEL.CURVE_FLOOR) pos.flags.push('stop below the curve floor: it cannot trigger while on the curve (legacy rule, kept for E0)');
      if (!P.maxHold) pos.flags.push('no time limit (legacy rule)');
      const w = A.watch.find(x => x.m === pos.m && !x.done);
      if (w) { w.done = 'bought'; w.doneAt = at; }
    },
    review(ctx, A, pos, at) {
      const r = pos.rules, k = ctx.coin(pos.m), mk = pos.mark;
      if (r.maxHoldS && at >= pos.fillAt + r.maxHoldS) {
        const late = at - (pos.fillAt + r.maxHoldS);
        return { exit: true, reason: 'time', why: `${P.maxHold} min time limit` + (late > 30 ? ` (${Math.round(late)} s late: no data or server offline)` : ''), late: late > 30 ? late : null };
      }
      if (mk && mk.v != null && mk.v >= r.tpVal) return { exit: true, reason: 'tp', why: `target +${Math.round(P.tp * 100)}% after costs reached (mark: ${{ q: 'quote', c: 'calibrated model', m: 'model' }[mk.src]})` };
      if (r.slPx && k && !ctx.blocked(k, at) && k.last.sol <= r.slPx) return { exit: true, reason: 'sl', why: `stop at ${Math.round(P.sl * 100)}% below the buy` };
      return null;
    },
    onClose(ctx, A, tr, at) {
      for (const w of A.watch) if (!w.done) {
        if (w.to <= at + 60) { w.done = 'missed'; w.doneAt = at; continue; }
        w.ready = !P.rearm; w.armed = false; w.rearmAt = at;
      }
    },
    interest() { return []; },
  };
}
const HOLD = {
  id: 'HOLD', kind: 'HOLD', gate: null, label: 'Hold SOL (no trades)', locked: E0_LOCKED, rules: {},
  entry() {}, review() { return null; }, onEligible() {}, interest() { return []; },
};
function e0All() { return R.BOTS.map(E0); }
module.exports = { E0, HOLD, e0All, E0_LOCKED, E0_SLIP };
