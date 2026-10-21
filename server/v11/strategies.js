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

const E0_LOCKED = Date.UTC(2026, 9, 21, 10, 45, 0) / 1000;   // RULES LOCKED Wed Oct 21 2026, 6:45 AM ET (before the first v11 start)
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

/* ---------------------------------------------------------------- v2 strategies (audit C2, C3, C4)
   A: Launch Momentum, B: Confirmed Pullback Recovery, C: Post-Graduation Momentum. Strict four-valued gates. Every
   10 s each strategy compares all its candidates at that moment, keeps those whose setup is confirmed by price
   structure AND real demand (buy vs sell notional) and whose plan fits (size from depth, round-trip cost and break-even,
   a reachable protective level, risk budget), and buys the best one, recording why it beat the others. While holding
   it re-checks the thesis on every event: an emergency (authority turned on, new danger flag, dev dump, exit route
   collapsing) is enough to leave; otherwise it takes two independent evidence families gone bad and staying bad
   (structure, demand, liquidity, holders), or the protective level, the risk budget, the trailing profit guard (from
   marks seen so far, never later ones) or the horizon. No fixed target: whether a target helps is a later experiment.
   All thresholds are first guesses to be tested, not tuned values. */
const FEAT = require('./features.js');
const RISK = require('./risk.js');
const V2_LOCKED = Date.UTC(2026, 9, 21, 10, 45, 0) / 1000;   // RULES LOCKED Wed Oct 21 2026, 6:45 AM ET; any change below = new ids, new start
const BASE = { stake: 1, everyS: 10, slip: 0.08, maxImpactQuote: 0.08, persistS: 20, coolLossS: 1800, coolWinS: 600, coolFailS: 60,
  risk: { maxImpact: 0.06, riskBudget: 0.3, maxBreakEven: 0.12, minStake: 0.1, stopGap: 0.15 } };
const no = why => ({ ok: false, why });
const pct = (v, d = 0) => (v >= 0 ? '+' : '') + (v * 100).toFixed(d) + '%';

const SPECS = {
  A: { label: 'A Launch momentum', P: { windowS: 2700, maxAgeS: 2700, mcMax: 30000, horizonS: 1200, stopFrac: 0.25, trailFrom: 0.2, trail: 0.12 },
    setup(F, k, w, ctx, P) {
      if (k.stage !== 'curve') return no('not on the bonding curve');
      if (F.age == null || F.age > P.maxAgeS) return no('older than 45 min');
      if (!(F.mc > 0) || F.mc > P.mcMax) return no('market cap over $30K');
      if (F.ret3 == null || F.ret3 < 0.08) return no(`no ignition (3 min ${F.ret3 == null ? '?' : pct(F.ret3)})`);
      if (!(F.ret1 > 0)) return no('stalling in the last minute');
      if (F.buyShare == null) return no('demand unknown (no buy/sell notional)');
      if (F.buyShare < 0.6) return no(`buyers only ${(F.buyShare * 100).toFixed(0)}% of volume`);
      if (!(F.traders >= 20)) return no(`${F.traders == null ? '?' : F.traders} traders in 5 min`);
      if (F.dTraders != null && F.dTraders < 0) return no('traders falling');
      if (F.ret1 > 0.25) return no(`vertical last minute (${pct(F.ret1)}): chasing`);
      return { ok: true, score: Math.min(0.5, F.ret3) + (F.buyShare - 0.5) + Math.min(0.3, Math.max(0, F.netPct || 0) * 20), stopFrac: P.stopFrac,
        why: `momentum ${pct(F.ret3)} in 3 min, buyers ${(F.buyShare * 100).toFixed(0)}% of volume, ${F.traders} traders`,
        invalidation: ['two of structure / demand / liquidity / holders turn bad for 20 s', 'price under the 25% protective level', '20 min without the move'] };
    } },
  B: { label: 'B Confirmed pullback', P: { windowS: 3 * 3600, horizonS: 2700, minRun: 1.5, pullMin: 0.25, pullMax: 0.6, recover: 0.08, trailFrom: 0.25, trail: 0.15 },
    setup(F, k, w, ctx, P) {
      const hi = ctx.high(k), x0 = k.cross.mc / 1e9;
      if (!(hi > 0) || hi / x0 < P.minRun) return no(`no strong prior move (high ${pct(hi / x0 - 1)} over the $7K crossing)`);
      const pull = F.usd / hi - 1;
      if (pull > -P.pullMin) return no(`no real pullback (${pct(pull)} from the high)`);
      if (pull < -P.pullMax) return no(`a collapse, not a pullback (${pct(pull)})`);
      if (F.fromLo == null || F.fromLo < P.recover) return no(`not recovering yet (${F.fromLo == null ? '?' : pct(F.fromLo)} off the low)`);
      if (!F.reclaim) return no("no close above the previous minute's high");
      if (F.buyShare == null || F.netPct == null) return no('demand unknown (no buy/sell notional)');
      if (F.buyShare < 0.55 || F.netPct <= 0) return no(`selling not absorbed (buyers ${(F.buyShare * 100).toFixed(0)}%)`);
      if (F.dShare != null && F.dShare < 0) return no('buy share falling again');
      return { ok: true, score: Math.min(0.4, F.fromLo) + (F.buyShare - 0.5) + Math.min(0.3, F.netPct * 20), stopFrac: Math.max(0.05, 1 - F.lo15 * 0.97 / F.usd),
        why: `pullback ${pct(pull)} from the high, back ${pct(F.fromLo)} off the low, buyers ${(F.buyShare * 100).toFixed(0)}%`,
        invalidation: ['back under the pullback low', 'sellers take over again with the structure failing', '45 min without recovery'] };
    } },
  C: { label: 'C After graduation', P: { windowS: 6 * 3600, horizonS: 7200, minAfterGradS: 600, minLiqUsd: 15000, mcMin: 60000, stopFrac: 0.18, trailFrom: 0.3, trail: 0.15, maxImpact: 0.03 },
    setup(F, k, w, ctx, P) {
      if (k.stage !== 'pool') return no('not graduated');
      if (F.at - k.stageAt < P.minAfterGradS) return no('graduated less than 10 min ago');
      if (!(F.poolLiq >= P.minLiqUsd)) return no(`pool liquidity ${F.poolLiq == null ? 'unknown' : '$' + Math.round(F.poolLiq)}`);
      if (!(F.mc >= P.mcMin)) return no('market cap under $60K');
      if (F.ret15 == null || F.ret15 < 0.1 || !(F.usd > F.mean15)) return no('no 15-min trend');
      if (F.buyShare == null || F.netPct == null) return no('demand unknown (no buy/sell notional)');
      if (F.buyShare < 0.55 || F.netPct <= 0 || !(F.traders >= 30)) return no(`demand not confirmed (buyers ${(F.buyShare * 100).toFixed(0)}%, ${F.traders} traders)`);
      return { ok: true, score: Math.min(0.5, F.ret15) + (F.buyShare - 0.5) + Math.min(0.3, F.netPct * 20), stopFrac: P.stopFrac,
        why: `trend ${pct(F.ret15)} in 15 min on a $${Math.round(F.poolLiq / 1000)}K pool, buyers ${(F.buyShare * 100).toFixed(0)}%`,
        invalidation: ['two evidence families bad for 20 s', '18% protective level', '2 h horizon'] };
    } },
};

/* opts (ablations, audit D2): noDemand (the setup ignores buy/sell evidence and exits ignore the demand family),
   noThesis (exits only by emergency, protective level, risk budget, trailing guard and horizon), noTrail. */
function V2(key, opts = {}) {
  const spec = SPECS[key], P = Object.assign({}, BASE, spec.P, { risk: Object.assign({}, BASE.risk, spec.P.maxImpact ? { maxImpact: spec.P.maxImpact } : {}) });
  const tag = Object.keys(opts).filter(k => opts[k]).map(k => k.replace(/^no/, '-').toLowerCase()).join('');
  const id = key + tag, label = spec.label + (tag ? ` (${tag.slice(1).replace(/-/g, ', no ')})`.replace('(', '(no ') : '');
  const demandFree = F => opts.noDemand ? Object.assign({}, F, { buyShare: 0.75, netPct: 0.01, dShare: 0, dTraders: 0, traders: Math.max(F.traders || 0, 60) }) : F;
  return {
    id, kind: 'V2', gate: 'strict', label, locked: V2_LOCKED, rules: P,
    onEligible(ctx, A, k, eligibleAt) {
      if (A.watch.some(w => w.m === k.m)) return;
      const to = key === 'A' && k.t0 ? Math.min(k.t0 + P.maxAgeS, k.cross.at + P.windowS) : k.cross.at + P.windowS;
      if (eligibleAt >= to) return;
      A.watch.push({ m: k.m, sym: k.sym, from: eligibleAt, to, done: null, lag: Math.round(eligibleAt - k.cross.at) });
    },
    onGateLost(ctx, A, k, at) { for (const w of A.watch) if (w.m === k.m && !w.done) { w.done = 'gates'; w.doneAt = at; } },
    entry(ctx, A, at) {
      if (ctx.halted() || at - (A.lastEval || 0) < P.everyS) return;
      A.lastEval = at;
      const C = ctx.C, cash = A.cash - C.prioSol - C.netFeeSol - C.rentSol, rows = [];
      for (const w of A.watch) {
        if (w.done) continue;
        if (at >= w.to) { w.done = 'expired'; w.doneAt = at; continue; }
        if (at < w.from) continue;
        const k = ctx.coin(w.m);
        if (!k) { w.done = 'gone'; continue; }
        if (A.cool[w.m] && at < A.cool[w.m]) { rows.push({ w, sym: k.sym, ok: false, why: 'cooling down after the last trade' }); continue; }
        if (!k.gs || !k.gs.ok) { rows.push({ w, sym: k.sym, ok: false, why: 'gates: ' + (k.gs ? k.gs.failed.concat(k.gs.unknown.map(u => u + '?')).join(', ') : 'checks pending') }); continue; }
        const b = ctx.blocked(k, at);
        if (b) { rows.push({ w, sym: k.sym, ok: false, why: b }); continue; }
        const F = FEAT.features(k, at, ctx);
        const s = spec.setup(demandFree(F), k, w, ctx, P);
        if (!s.ok) { rows.push({ w, sym: k.sym, ok: false, why: s.why }); continue; }
        const plan = RISK.plan(Object.assign({ pSol: k.last.sol, stage: k.stage, liq: ctx.liqOf(k), at, stake: Math.min(P.stake, cash), stopFrac: s.stopFrac,
          costs: { prioSol: C.prioSol, netFeeSol: C.netFeeSol, latency: C.latency } }, P.risk));
        if (!plan.ok) { rows.push({ w, sym: k.sym, ok: false, why: plan.why }); continue; }
        rows.push({ w, sym: k.sym, ok: true, score: s.score - plan.be, s, plan, F, k });
      }
      A.scan = { at, rows: rows.slice().sort((a, b) => (b.ok - a.ok) || ((b.score || 0) - (a.score || 0))).slice(0, 8).map(r => [r.w.m, r.sym, r.ok ? 1 : 0, r.ok ? +r.score.toFixed(3) : r.why]) };
      const ok = rows.filter(r => r.ok).sort((a, b) => b.score - a.score);
      if (!ok.length || !(ok[0].plan.stake >= P.risk.minStake)) return;
      const best = ok[0], k = best.k, p = k.last;
      const thesis = { setup: label, why: best.s.why, decidedAt: at, horizonS: P.horizonS, stopPx: best.plan.stopPx, stopNote: best.plan.stopNote,
        riskBudget: P.risk.riskBudget, worstLoss: +best.plan.worstLoss.toFixed(4), lossAtStop: +best.plan.lossAtStop.toFixed(4), breakEven: +best.plan.be.toFixed(4), roundTrip: +best.plan.rt.toFixed(4),
        impact: +best.plan.impact.toFixed(4), size: best.plan.stake, notes: best.plan.notes, invalidation: best.s.invalidation, features: FEAT.brief(best.F),
        social: k.social ? k.social.status : 'unavailable', score: +best.score.toFixed(4),
        alternatives: rows.filter(r => r !== best).slice(0, 6).map(r => [r.sym, r.ok ? 'ranked lower (' + r.score.toFixed(3) + ')' : r.why]) };
      ctx.buy(A, { m: k.m, stake: best.plan.stake, sigAt: p.at, sigPx: p.sol, maxPx: p.sol * (1 + P.slip), maxImpact: P.maxImpactQuote, why: best.s.why, thesis,
        snap: { usd: p.usd, sol: p.sol, mc: p.mc, obsAt: p.at, stage: k.stage, eligibleAt: best.w.from, cross: k.cross.at } }, at);
    },
    onFail(ctx, A, o, why, at) { if (o.side === 'buy') A.cool[o.m] = at + P.coolFailS; },
    onFill(ctx, A, pos) {
      const th = pos.thesis || {};
      pos.rules = { stopPx: th.stopPx || null, horizonS: P.horizonS, trailFrom: P.trailFrom, trail: P.trail, riskBudget: P.risk.riskBudget };
      if (th.stopNote) pos.flags.push(th.stopNote);
      for (const w of A.watch) if (w.m === pos.m && !w.done) { w.done = 'bought'; w.doneAt = pos.quoteAt; }
    },
    review(ctx, A, pos, at) {
      const k = ctx.coin(pos.m), r = pos.rules;
      if (!k) return { exit: true, reason: 'emergency', why: 'coin data lost' };
      if (pos.state === 'exit_unavailable') return { exit: true, reason: 'emergency', why: 'no sell route: trying again' };
      const F = FEAT.features(k, at, ctx, pos);
      const em = FEAT.emergency(k, pos, F);
      if (em) return { exit: true, reason: 'emergency', why: em };
      if (r.stopPx && k.last && !ctx.blocked(k, at) && k.last.sol <= r.stopPx) return { exit: true, reason: 'stop', why: 'protective level hit' };
      if (pos.mark && pos.mark.v != null && pos.cost - pos.mark.v > r.riskBudget * 1.25) return { exit: true, reason: 'risk', why: `loss ${(pos.cost - pos.mark.v).toFixed(3)} SOL is past the risk budget` };
      const fam = FEAT.families(F, k, pos).filter(f => !(opts.noDemand && f.f === 'demand')), bad = opts.noThesis ? [] : fam.filter(f => f.v === 'bad');
      pos.fam = fam.map(f => [f.f, f.v, f.why]);
      if (bad.length >= 2) {
        if (!pos.badSince) pos.badSince = at;
        ctx.setState(A, pos, 'broken', bad.map(f => f.f + ': ' + f.why).join('; '), at);
        if (at - pos.badSince >= P.persistS) return { exit: true, reason: 'thesis', why: 'thesis broken: ' + bad.map(f => f.why).join('; ') };
      } else {
        pos.badSince = null;
        if (pos.state !== 'exit_pending') ctx.setState(A, pos, bad.length ? 'watching' : 'healthy', bad.length ? bad[0].f + ': ' + bad[0].why : 'evidence still supports it', at);
      }
      if (!opts.noTrail && pos.mfe >= r.trailFrom && pos.mark && pos.mark.v != null && pos.peakV && pos.mark.v <= pos.peakV * (1 - r.trail))
        return { exit: true, reason: 'trail', why: `gave back ${(r.trail * 100).toFixed(0)}% from its best mark after ${pct(pos.mfe)}` };
      if (at - pos.fillAt >= r.horizonS) return { exit: true, reason: 'time', why: `${Math.round(r.horizonS / 60)} min horizon` };
      return null;
    },
    onClose(ctx, A, tr, at) { A.cool[tr.m] = at + (tr.net < 0 ? P.coolLossS : P.coolWinS); },
    interest() { return []; },
  };
}
function v2All() { return ['A', 'B', 'C'].map(k => V2(k)); }

/* E2 (audit experiment E2: does explicit downside invalidation help?): a legacy bot's entries exactly as E0, with the v2
   exits instead of its target / stop / time limit: thesis checks, emergencies, the risk budget, a trailing guard and a
   finite horizon (2 h). Replay-only for now. */
function E2(bot) {
  const e0 = E0(bot), v = V2('B');
  return Object.assign({}, e0, { id: 'E2-' + bot.id, kind: 'E2', label: `E2 ${bot.name} entries, v2 exits`,
    onFill(ctx, A, pos, at) { e0.onFill(ctx, A, pos, at); pos.rules = { stopPx: null, horizonS: 7200, trailFrom: 0.25, trail: 0.15, riskBudget: 0.6 }; },
    review: v.review });
}
/* Strategy sets for replays: the live set, and each ablation next to what it removes. */
function ablations() {
  return [...v2All(), V2('A', { noDemand: true }), V2('B', { noDemand: true }), V2('C', { noDemand: true }), V2('A', { noThesis: true }), V2('B', { noThesis: true }),
    V2('A', { noTrail: true }), ...e0All(), ...R.BOTS.filter(b => ['U', 'U2', 'GRN'].includes(b.id)).map(E2), HOLD];
}
module.exports = { E0, E2, HOLD, e0All, E0_LOCKED, E0_SLIP, V2, v2All, V2_LOCKED, SPECS, BASE, ablations };
