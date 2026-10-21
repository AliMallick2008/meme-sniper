/* Meme Coin Trader engine: daily-candle portfolio simulator for a basket of coins (research and dashboard share this code).
   Decisions at each UTC daily close on finished candles; fills at the next day's open +/- slippage; Kraken taker tiers on the
   bot's own 30-day volume. Long only, no leverage. Positions are all-in/all-out, equal share of cash per new position. */
const MEME = (() => {
  const DAY = 86400, MONTH = 30 * DAY;
  const KR_TH = [0, 2500, 10000, 25000, 50000, 100000, 250000, 500000, 1000000];
  const KR_TK = [0.0080, 0.0060, 0.0038, 0.0035, 0.0030, 0.0025, 0.0022, 0.0020, 0.0018];
  function takerAt(volT, volN, now, flat) {
    if (flat != null) return flat;
    let tot = 0;
    for (let i = volT.length - 1; i >= 0 && volT[i] > now - MONTH; i--) tot += volN[i];
    let tier = 0;
    for (let k = 0; k < KR_TH.length; k++) if (tot >= KR_TH[k]) tier = k;
    return KR_TK[tier];
  }
  /* Align coins on one UTC day grid (NaN where a coin has no candle) and precompute age (consecutive candles up to each day)
     and the 30-day median dollar volume. U: [{sym, t, o, h, l, c, v}] with t = UTC day start. */
  function grid(U, btc, step = DAY) {
    let t0 = Infinity, t1 = -Infinity;
    for (const u of U) if (u.t.length) { t0 = Math.min(t0, u.t[0]); t1 = Math.max(t1, u.t[u.t.length - 1]); }
    const n = Math.round((t1 - t0) / step) + 1, T = Array.from({ length: n }, (_, i) => t0 + i * step);
    const al = u => {
      const f = () => new Float64Array(n).fill(NaN);
      const x = { sym: u.sym, o: f(), h: f(), l: f(), c: f(), v: f(), age: new Int32Array(n), dv: new Float64Array(n), sma: {} };
      for (let i = 0; i < u.t.length; i++) {
        const d = Math.round((u.t[i] - t0) / step);
        if (d < 0 || d >= n) continue;
        x.o[d] = u.o[i]; x.h[d] = u.h[i]; x.l[d] = u.l[i]; x.c[d] = u.c[i]; x.v[d] = u.v ? u.v[i] : NaN;
      }
      for (let d = 0; d < n; d++) x.age[d] = x.c[d] > 0 ? (d > 0 ? x.age[d - 1] : 0) + 1 : 0;
      const w = [];
      for (let d = 0; d < n; d++) {
        if (x.age[d] < 30) { x.dv[d] = 0; continue; }
        w.length = 0;
        for (let j = d - 29; j <= d; j++) w.push(x.c[j] * x.v[j]);
        w.sort((p, q) => p - q);
        x.dv[d] = (w[14] + w[15]) / 2;
      }
      return x;
    };
    return { T, n, t0, step, C: U.map(al), B: btc ? al(btc) : null };
  }
  function sma(x, len) {
    if (x.sma[len]) return x.sma[len];
    const n = x.c.length, out = new Float64Array(n).fill(NaN);
    for (let d = 0; d < n; d++) {
      if (x.age[d] < len) continue;
      let s = 0; for (let j = d - len + 1; j <= d; j++) s += x.c[j];
      out[d] = s / len;
    }
    return (x.sma[len] = out);
  }
  /* P: fam 'rot' | 'brk' | 'one' | 'rand'   (lengths are in bars of the grid: days, or hours on an hourly grid)
       rot : L, k, buf, trend (0|10|20|50), btcF (0|50), cad ('d'|'w'), every (decide only at bar closes divisible by every bars),
             anyGain (true = also buy a leader whose gain is negative: always invested)
       brk : N, M, k (max positions), btcF
       one : sym, n (SMA length)
       rand: k, cad, seed (random eligible coins at each decision; a luck baseline)
     cfg: d0, d1 (day indexes to run, inclusive), startEq, slip, liqMin, flatFee, live (last day = forming day: fills and
     mark-to-market only, no decision), noteFn(P, sym, d, m, rank) for the 'why' text, minTrade (smallest buy, default 1),
     decideAtStart (also decide at the close of d0 even when 'every' would skip it). */
  function sim(G, P, cfg) {
    const { T, C, B } = G, nC = C.length, step = G.step || DAY, unit = step === DAY ? 'day' : 'hour';
    const slip = cfg.slip == null ? 0.0015 : cfg.slip, liqMin = cfg.liqMin == null ? 1e6 : cfg.liqMin;
    const longest = Math.max(30, P.L || 0, P.trend || 0, P.N || 0, P.M || 0, P.n || 0);
    const trendArr = P.trend ? C.map(x => sma(x, P.trend)) : null;
    const btcSma = P.btcF && B ? sma(B, P.btcF) : null;
    let cash = cfg.startEq, rng = P.seed || 1;
    const rand = () => { rng = (rng * 1103515245 + 12345) % 2147483648; return rng / 2147483648; };
    const qty = new Float64Array(nC), entPx = new Float64Array(nC), entD = new Int32Array(nC).fill(-1), entFee = new Float64Array(nC), entNot = new Float64Array(nC);
    const entWhy = new Array(nC).fill(''), lastC = new Float64Array(nC).fill(NaN);
    const volT = [], volN = [], trades = [], eq = [];
    let pendSell = [], pendBuy = [], why = {};
    const nHeld = () => { let k = 0; for (let i = 0; i < nC; i++) if (qty[i] > 0) k++; return k; };
    for (let d = cfg.d0; d <= cfg.d1; d++) {
      // 1) fills at today's open: sells first, then buys with an equal share of cash per free slot
      for (const i of pendSell) {
        if (!(qty[i] > 0)) continue;
        const op = C[i].o[d] > 0 ? C[i].o[d] : lastC[i];
        const px = op * (1 - slip), proceeds = qty[i] * px, fee = proceeds * takerAt(volT, volN, T[d], cfg.flatFee);
        cash += proceeds - fee; volT.push(T[d]); volN.push(proceeds);
        trades.push({ sym: C[i].sym, entryT: T[entD[i]], exitT: T[d], entryD: entD[i], exitD: d, entryPx: entPx[i], exitPx: px, qty: qty[i],
          notional: entNot[i], fees: entFee[i] + fee, entryFee: entFee[i], exitFee: fee, net: proceeds - fee - entNot[i] - entFee[i], gross: proceeds - entNot[i],
          why: entWhy[i], whyOut: why['s' + i] || '' });
        qty[i] = 0; entD[i] = -1;
      }
      if (pendBuy.length) {
        let free = Math.max(1, (P.k || 1) - nHeld());
        for (const i of pendBuy) {
          if (free <= 0) break;
          if (qty[i] > 0 || !(C[i].o[d] > 0)) { free--; continue; }
          const use = cash / free;
          free--;
          if (use <= (cfg.minTrade == null ? 1 : cfg.minTrade)) continue;
          const fr = takerAt(volT, volN, T[d], cfg.flatFee), notional = use / (1 + fr), fee = notional * fr, px = C[i].o[d] * (1 + slip);
          qty[i] = notional / px; entPx[i] = px; entD[i] = d; entFee[i] = fee; entNot[i] = notional; entWhy[i] = why['b' + i] || '';
          cash -= use; volT.push(T[d]); volN.push(notional);
        }
      }
      pendSell = []; pendBuy = []; why = {};
      // 2) mark to market at today's close (or the latest price on the forming day)
      let e = cash;
      for (let i = 0; i < nC; i++) {
        if (C[i].c[d] > 0) lastC[i] = C[i].c[d];
        if (qty[i] > 0) e += qty[i] * lastC[i];
      }
      eq.push(e);
      if (cfg.live && d === cfg.d1) break;
      // 3) decisions at today's close, on finished candles only
      const closeT = T[d] + step, weekly = closeT % DAY === 0 && new Date(closeT * 1000).getUTCDay() === 0;
      if ((P.fam === 'rot' || P.fam === 'rand') && P.cad === 'w' && !weekly) continue;
      if (P.every && closeT % (P.every * step) !== 0 && !(cfg.decideAtStart && d === cfg.d0)) continue;
      const elig = [];
      for (let i = 0; i < nC; i++) if (C[i].c[d] > 0 && C[i].age[d] >= longest && C[i].dv[d] >= liqMin) elig.push(i);
      const btcOk = !P.btcF || (B && B.c[d] > btcSma[d]);
      const held = []; for (let i = 0; i < nC; i++) if (qty[i] > 0) held.push(i);
      if (P.fam === 'rot' || P.fam === 'rand') {
        let ranked;
        if (P.fam === 'rot') {
          ranked = btcOk ? elig.map(i => ({ i, m: C[i].c[d] / C[i].c[d - P.L] - 1 }))
            .filter(r => (P.anyGain || r.m > 0) && (!P.trend || C[r.i].c[d] > trendArr[r.i][d])).sort((a, b) => b.m - a.m) : [];
        } else ranked = elig.map(i => ({ i, m: rand() })).sort((a, b) => b.m - a.m);
        const rank = new Map(ranked.map((r, j) => [r.i, j]));
        const keep = held.filter(i => rank.has(i) && rank.get(i) < P.k + (P.buf || 0));
        for (const i of held) if (!keep.includes(i)) {
          pendSell.push(i);
          why['s' + i] = !btcOk ? `BTC closed under its ${P.btcF}-day average` : rank.has(i) ? `fell to #${rank.get(i) + 1} by ${P.L}-${unit} gain` : (C[i].c[d] / C[i].c[d - (P.L || 1)] - 1 <= 0 ? `${P.L}-${unit} gain turned negative` : `closed under its ${P.trend}-${unit} average`);
        }
        let slots = P.k - keep.length;
        for (const r of ranked) {
          if (slots <= 0) break;
          if (keep.includes(r.i)) continue;
          pendBuy.push(r.i); why['b' + r.i] = cfg.noteFn ? cfg.noteFn(P, C[r.i].sym, d, r.m, rank.get(r.i)) : '';
          slots--;
        }
      } else if (P.fam === 'brk') {
        for (const i of held) {
          let lo = Infinity; for (let j = d - P.M; j < d; j++) if (C[i].l[j] > 0) lo = Math.min(lo, C[i].l[j]);
          if (C[i].c[d] < lo) { pendSell.push(i); why['s' + i] = `closed under its ${P.M}-day low`; }
        }
        if (btcOk) {
          const cands = [];
          for (const i of elig) {
            if (qty[i] > 0) continue;
            let hi = -Infinity; for (let j = d - P.N; j < d; j++) if (C[i].h[j] > 0) hi = Math.max(hi, C[i].h[j]);
            if (C[i].c[d] > hi) cands.push({ i, m: C[i].c[d] / C[i].c[d - P.N] - 1 });
          }
          cands.sort((a, b) => b.m - a.m);
          let slots = P.k - (held.length - pendSell.length);
          for (const r of cands) { if (slots <= 0) break; pendBuy.push(r.i); why['b' + r.i] = cfg.noteFn ? cfg.noteFn(P, C[r.i].sym, d, r.m, 0) : ''; slots--; }
        }
      } else if (P.fam === 'one') {
        const i = C.findIndex(x => x.sym === P.sym), s = sma(C[i], P.n);
        const ok = elig.includes(i) && C[i].c[d] > s[d];
        if (qty[i] > 0 && !ok) pendSell.push(i);
        if (!(qty[i] > 0) && ok) pendBuy.push(i);
      }
    }
    const opens = [];
    for (let i = 0; i < nC; i++) if (qty[i] > 0) opens.push({ sym: C[i].sym, entryT: T[entD[i]], entryD: entD[i], entryPx: entPx[i], qty: qty[i], notional: entNot[i], entryFee: entFee[i], why: entWhy[i], last: lastC[i] });
    return { eq, trades, opens, cash, pendBuy: pendBuy.map(i => C[i].sym), pendSell: pendSell.map(i => C[i].sym), why, volT, volN, d0: cfg.d0, d1: cfg.d1 };
  }
  /* Equal-weight benchmark: all eligible coins, rebalanced to equal weights at each month's last close (fills at the next open),
     costs = (taker fee + slippage) on the traded amount, flat rate. Returns daily equity from d0 to d1. */
  function ewBench(G, cfg) {
    const { T, C } = G, nC = C.length, step = G.step || DAY, cost = (cfg.flatFee == null ? 0.0038 : cfg.flatFee) + (cfg.slip == null ? 0.0015 : cfg.slip);
    const liqMin = cfg.liqMin == null ? 1e6 : cfg.liqMin;
    let cash = cfg.startEq, target = null;
    const val = new Float64Array(nC), eq = [];
    for (let d = cfg.d0; d <= cfg.d1; d++) {
      for (let i = 0; i < nC; i++) if (val[i] > 0 && C[i].o[d] > 0 && C[i].c[d - 1] > 0) val[i] *= C[i].o[d] / C[i].c[d - 1];
      if (target) {
        let tot = cash; for (let i = 0; i < nC; i++) tot += val[i];
        let traded = 0;
        const w = target.length ? 1 / target.length : 0;
        for (let i = 0; i < nC; i++) { const want = target.includes(i) && C[i].o[d] > 0 ? tot * w : 0; traded += Math.abs(want - val[i]); val[i] = want; }
        let inv = 0; for (let i = 0; i < nC; i++) inv += val[i];
        cash = tot - inv - traded * cost;
        target = null;
      }
      for (let i = 0; i < nC; i++) if (val[i] > 0 && C[i].c[d] > 0 && C[i].o[d] > 0) val[i] *= C[i].c[d] / C[i].o[d];
      let e = cash; for (let i = 0; i < nC; i++) e += val[i];
      eq.push(e);
      if (((T[d] + step) % DAY === 0 && new Date((T[d] + step) * 1000).getUTCDate() === 1) || d === cfg.d0) {
        target = [];
        for (let i = 0; i < nC; i++) if (C[i].c[d] > 0 && C[i].age[d] >= 30 && C[i].dv[d] >= liqMin) target.push(i);
      }
    }
    return { eq, d0: cfg.d0, d1: cfg.d1 };
  }
  /* stats over bar window [a, b] of a run that starts at d0 with starting equity eq0 (per = bars per year for the Sharpe) */
  function stats(run, a, b, eq0, per = 365) {
    const { eq, d0 } = run, s = Math.max(a, d0), e = Math.min(b, d0 + eq.length - 1);
    if (e <= s) return null;
    const v0 = s === d0 ? eq0 : eq[s - 1 - d0];
    let peak = v0, mdd = 0, up = 0, n = 0, sum = 0, sum2 = 0, prev = v0;
    for (let d = s; d <= e; d++) {
      const v = eq[d - d0], r = v / prev - 1;
      n++; sum += r; sum2 += r * r; if (r > 1e-9) up++;
      if (v > peak) peak = v;
      mdd = Math.min(mdd, v / peak - 1); prev = v;
    }
    const mu = sum / n, sd = Math.sqrt(Math.max(0, sum2 / n - mu * mu));
    return { ret: eq[e - d0] / v0 - 1, sharpe: sd > 0 ? mu / sd * Math.sqrt(per) : 0, mdd, daysUp: up / n, days: n };
  }
  return { grid, sim, ewBench, stats, sma, takerAt, KR_TH, KR_TK, DAY };
})();
if (typeof module !== 'undefined') module.exports = MEME;
