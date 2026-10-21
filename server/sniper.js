/* Meme Sniper engine: pump.fun coins on 1-minute candles (research and dashboard share this code).
   Prices in candles are USD; every fill is computed in SOL with the exact constant-product math of the pump.fun bonding
   curve (or the PumpSwap pool after graduation), pump.fun's fee schedule, and a fixed execution slippage per side.
   Pessimistic fills: a stop is checked before a take-profit inside the same candle, and no take-profit in the entry candle. */
const SNIPER = (() => {
  const SUPPLY = 1e9;                       // pump.fun coins: 1,000,000,000 tokens
  const CURVE_K = 30 * 1.073e9;             // virtual SOL x virtual tokens at launch (constant on the curve)
  const POOL_K = 85 * 206.9e6;              // PumpSwap pool right after graduation (85 SOL, 206.9M tokens)
  const GRAD_MC_SOL = 410.9;                // market cap in SOL when the curve completes
  // pump.fun dynamic fees (protocol + creator + LP), by market cap in SOL; the bonding curve is a flat 1.25%
  const POOL_TIERS = [[420, 0.0125], [1470, 0.012], [2460, 0.0115], [3440, 0.011], [4420, 0.0105], [9820, 0.01], [Infinity, 0.0095]];
  function feeRate(mcSol, curve) {
    if (curve) return 0.0125;
    for (const [lim, f] of POOL_TIERS) if (mcSol < lim) return f;
    return 0.0095;
  }
  // reserves [SOL, tokens, k] of a constant-product market at a price in SOL per token
  function reserves(pSol, curve) { const k = curve ? CURVE_K : POOL_K; const R = Math.sqrt(k * pSol); return [R, R / pSol, k]; }
  /* Spend S SOL (fee included) at market price pSol. Returns tokens received and costs. */
  function buy(S, pSol, curve, exec) {
    const f = feeRate(pSol * SUPPLY, curve), fee = S * f, net = S - fee;
    const p = pSol * (1 + exec), [R, T, k] = reserves(p, curve);
    const tokens = T - k / (R + net);
    return { tokens, fee, avg: S / tokens, impact: (net / tokens) / p - 1 };
  }
  /* Sell Q tokens at market price pSol. Returns SOL received (after fee). */
  function sell(Q, pSol, curve, exec) {
    const p = pSol * (1 - exec), [R, T, k] = reserves(p, curve);
    const gross = R - k / (T + Q), f = feeRate(pSol * SUPPLY, curve);
    return { sol: gross * (1 - f), fee: gross * f, gross };
  }
  /* Lowest market price (SOL/token) at which selling Q tokens returns at least target SOL. */
  function priceFor(Q, target, curve, exec) {
    let lo = 1e-15, hi = 10;
    if (sell(Q, hi, curve, exec).sol < target) return Infinity;
    for (let i = 0; i < 90; i++) { const m = Math.sqrt(lo * hi); if (sell(Q, m, curve, exec).sol >= target) hi = m; else lo = m; }
    return hi;
  }
  const DEF = { dip: 0.40, hiRef: 'launch', tp: 0.01, sl: 0.90, maxHold: 0, entry: 'limit', mcMin: 7000, stake: 1, exec: 0.01, rearm: true };
  const opt = P => Object.assign({}, DEF, P);
  /* Find the entry on one coin.
     cs: candles [[t, o, h, l, c, v, g], ...] oldest first (t = minute start, seconds), prices USD, g = 1 after graduation.
     sol(t): SOL/USD for minute t. tw: watch start (seconds). tEnd: only candles starting before tEnd count.
     Returns { pos, trig, H, startT, armT, state } with state 'hold' (bought), 'watch' (no dip yet) or 'never'
     (a higher market cap threshold never reached). trig/H: the level the next candle would have to reach.
     rearm: a coin already under its buy level when the watch starts (or the bot frees up) is not bought there; it has to
     trade back above the buy level first, so every buy is a fresh dip and never a coin that crashed while the bot was busy. */
  function findEntry(cs, sol, tw, tEnd, P) {
    P = opt(P);
    const out = { pos: null, trig: NaN, H: NaN, armT: null, startT: null, state: 'watch' };
    let t0 = Math.ceil(tw / 60) * 60;
    if (P.mcMin > 7000) { // a higher market cap threshold: watch from the minute after the first close at or above it
      let k = -1;
      for (let i = 0; i < cs.length; i++) if (cs[i][0] + 60 > tw && cs[i][0] < tEnd && cs[i][4] * SUPPLY >= P.mcMin) { k = i; break; }
      if (k < 0) { out.state = 'never'; return out; }
      t0 = Math.max(t0, cs[k][0] + 60);
    }
    out.startT = t0;
    let H = 0;
    for (const c of cs) { if (c[0] >= t0) break; if (P.hiRef === 'launch' || c[0] + 60 > tw) H = Math.max(H, c[2]); }
    if (!(H > 0)) { const f = cs.find(c => c[0] >= t0 && c[0] < tEnd); H = f ? f[1] : 0; }
    let armed = false, ready = !P.rearm;
    for (const c of cs) {
      const [t, o, h, l, cl, , g] = c;
      if (t < t0) continue;
      if (t >= tEnd) break;
      const trig = (1 - P.dip) * H;
      if (!ready) {
        if (o > trig) ready = true;
        else { if (cl > trig) ready = true; H = Math.max(H, h); out.waitT = out.waitT || t; continue; }
      }
      let fillUsd = NaN;
      if (P.entry === 'limit') { if (l <= trig) fillUsd = Math.min(o, trig); }
      else { if (!armed && l <= trig) { armed = true; out.armT = t; } if (armed && cl > o) fillUsd = cl; }
      if (fillUsd > 0) {
        const s = sol(t), curve = !g, pSol = fillUsd / s, b = buy(P.stake, pSol, curve, P.exec), tgt = P.stake * (1 + P.tp);
        out.pos = { entryT: t, entryUsd: fillUsd, entrySol: pSol, qty: b.tokens, cost: P.stake, fee: b.fee, impact: b.impact, entryMc: fillUsd * SUPPLY, sol0: s,
          H, trig, slSol: P.sl ? (1 - P.sl) * pSol : 0, tpCurve: priceFor(b.tokens, tgt, true, P.exec), tpPool: priceFor(b.tokens, tgt, false, P.exec), curve0: curve, how: P.entry };
        out.trig = trig; out.H = H; out.state = 'hold';
        return out;
      }
      H = Math.max(H, h);
    }
    out.H = H; out.trig = (1 - P.dip) * H; out.ready = ready;
    return out;
  }
  /* Follow a position from its entry candle. Returns { trade, state }: state 'done' (closed: tp / sl / time / horizon)
     or 'hold' (live: still open, trade valued at the last close after exit costs, out = 'open'). */
  function hold(cs, sol, pos, tEnd, P, live) {
    P = opt(P);
    let last = null;
    for (const c of cs) {
      const [t, o, h, l, cl, , g] = c;
      if (t < pos.entryT) continue;
      if (t >= tEnd) break;
      last = c;
      const s = sol(t), curve = !g, oS = o / s, hS = h / s, lS = l / s, cS = cl / s;
      if (t === pos.entryT) { // rest of the entry candle: a limit fill happened on the way down, so only the stop can follow
        if (pos.how === 'limit' && P.sl && lS <= pos.slSol) return close(pos, t, 'sl', cS <= pos.slSol ? cS : pos.slSol, curve, s, P);
        continue;
      }
      const tgt = curve ? pos.tpCurve : pos.tpPool;
      if (P.sl && lS <= pos.slSol) return close(pos, t, 'sl', oS <= pos.slSol ? oS : (cS < pos.slSol ? cS : pos.slSol), curve, s, P);
      if (hS >= tgt) return close(pos, t, 'tp', Math.max(oS, tgt), curve, s, P);
      if (P.maxHold && t + 60 - pos.entryT >= P.maxHold * 60) return close(pos, t, 'time', cS, curve, s, P);
    }
    if (!last) last = cs.filter(c => c[0] <= pos.entryT).pop() || [pos.entryT, pos.entryUsd, pos.entryUsd, pos.entryUsd, pos.entryUsd, 0, pos.curve0 ? 0 : 1];
    const s = sol(last[0]), r = close(pos, last[0], live ? 'open' : 'horizon', last[4] / s, !last[6], s, P);
    r.state = live ? 'hold' : 'done';
    return r;
  }
  function close(pos, t, why, pSol, curve, s, P) {
    const r = sell(pos.qty, pSol, curve, P.exec);
    return { state: 'done', trade: Object.assign({}, pos, { exitT: t, exitSol: pSol, exitUsd: pSol * s, exitMc: pSol * s * SUPPLY, sol1: s, proceeds: r.sol, exitFee: r.fee,
      net: r.sol - pos.cost, ret: r.sol / pos.cost - 1, out: why }) };
  }
  /* One coin, entry + exit. state: 'done' | 'hold' | 'watch' | 'nodip' | 'never'. */
  function run(cs, sol, tw, tEnd, P = {}, live = false) {
    const e = findEntry(cs, sol, tw, tEnd, P);
    const out = { trade: null, state: e.state, trig: e.trig, H: e.H, armT: e.armT, startT: e.startT };
    if (!e.pos) { if (!live && e.state === 'watch') out.state = 'nodip'; return out; }
    const h = hold(cs, sol, e.pos, tEnd, P, live);
    out.trade = h.trade; out.state = h.state;
    return out;
  }
  /* Merge the bonding-curve pool's candles with the PumpSwap pool's (after graduation): oldest first, g flag added. */
  function stitch(curveCs, poolCs) {
    const a = (curveCs || []).map(c => c.map(Number)).sort((x, y) => x[0] - y[0]);
    const b = (poolCs || []).map(c => c.map(Number)).sort((x, y) => x[0] - y[0]);
    const lastCurve = a.length ? a[a.length - 1][0] : -Infinity;
    const out = a.map(c => [c[0], c[1], c[2], c[3], c[4], c[5], 0]);
    for (const c of b) if (c[0] > lastCurve) out.push([c[0], c[1], c[2], c[3], c[4], c[5], 1]);
    return out;
  }
  /* Current memes. A coin's words: name + symbol, camelCase split, lowercase letters only, 3+ letters, minus filler words.
     Meme score at time t = the most other coins sharing one of its words that crossed $7k in the 2 hours before t. */
  const STOP = new Set(['the', 'and', 'for', 'you', 'are', 'with', 'this', 'that', 'from', 'have', 'not', 'but', 'all', 'can', 'its', 'was', 'new', 'just', 'get', 'got', 'our', 'out', 'who', 'why', 'how', 'now', 'one', 'two', 'coin', 'token', 'sol', 'solana', 'pump', 'fun', 'meme', 'official']);
  function words(name, sym) {
    const s = `${name || ''} ${sym || ''}`.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().replace(/[^a-z]+/g, ' ');
    return [...new Set(s.split(' ').filter(w => w.length >= 3 && !STOP.has(w)))];
  }
  // crosses: [[t, mint, words], ...] (any order); counts each other coin once per word
  function memeScore(ws, crosses, t, self, win = 7200) {
    let score = 0, word = null;
    for (const w of ws) {
      let n = 0;
      for (const [tc, m, cw] of crosses) if (m !== self && tc < t && tc >= t - win && cw.includes(w)) n++;
      if (n > score) { score = n; word = w; }
    }
    return { score, word };
  }
  /* Lowest price a coin can have on the bonding curve (nobody holds any bought tokens), in SOL per token. */
  const CURVE_FLOOR = 30 / 1.073e9;
  /* Bonding-curve progress 0..1 from a market cap in SOL (85 real SOL completes the curve). */
  function curveProgress(mcSol) { const R = Math.sqrt(CURVE_K * mcSol / SUPPLY); return Math.max(0, Math.min(1, (R - 30) / 85)); }
  /* Group 1-minute candles [[t, o, h, l, c, v, g], ...] (oldest first) into k-minute candles aligned to k minutes. */
  function aggregate(cs, k) {
    if (k <= 1) return cs;
    const out = [], w = k * 60;
    for (const c of cs) {
      const t = Math.floor(c[0] / w) * w, last = out[out.length - 1];
      if (last && last[0] === t) { last[2] = Math.max(last[2], c[2]); last[3] = Math.min(last[3], c[3]); last[4] = c[4]; last[5] += c[5] || 0; last[6] = c[6]; }
      else out.push([t, c[1], c[2], c[3], c[4], c[5] || 0, c[6]]);
    }
    return out;
  }
  /* The locked v10 rules, shared by the browser bots and the server bots (one definition, so they can't drift apart). */
  const RULES = (() => {
    const BASE = { dip: 0.40, hiRef: 'launch', tp: 0.01, sl: 0.90, maxHold: 0, entry: 'limit', mcMin: 7000, stake: 1, exec: 0.01, rearm: true };
    const CHK = { devMax: 10, topMax: 30, needMeme: 1 };
    const withP = o => Object.assign({}, BASE, o);
    return {
      LOCKED: Date.UTC(2026, 9, 20, 12, 25, 0) / 1000, // Tue Oct 20 2026, 8:25 AM Toronto
      START_SOL: 10, BASE, CHK,
      FOLLOW_S: 75 * 60, DEAD_S: 20 * 60, DEAD_MC: 4500, CROSS_MC: 7000, WATCH_S: 2 * 3600, META_S: 2 * 3600, SLOTS: 6,
      BOTS: [
        { id: 'U', name: 'Your rules', color: '--c-snipe', diff: 'Exactly your rules. No time limit.', P: withP({}), C: CHK },
        { id: 'U2', name: '+ 2 h exit', color: '--l1', diff: 'Your rules, plus: sell after 2 hours if neither the target nor the stop came.', P: withP({ maxHold: 120 }), C: CHK },
        { id: 'U30', name: '+ 30 min exit', color: '--l3', diff: 'Your rules, plus: sell after 30 minutes.', P: withP({ maxHold: 30 }), C: CHK },
        { id: 'T25', name: 'Target +25%', color: '--l2', diff: '+ 2 h exit, and it waits for +25% after costs instead of the first +1%.', P: withP({ maxHold: 120, tp: 0.25 }), C: CHK },
        { id: 'D55', name: 'Deeper dip', color: '--l4', diff: '+ 2 h exit, and it waits for a 55% dip instead of 40%.', P: withP({ maxHold: 120, dip: 0.55 }), C: CHK },
        { id: 'GRN', name: 'Bounce entry', color: '--l5', diff: '+ 2 h exit, and after the 40% dip it buys at the close of the first green 1-minute candle.', P: withP({ maxHold: 120, entry: 'green' }), C: CHK },
        { id: 'STR', name: 'Stricter checks', color: '--l6', diff: '+ 2 h exit, and the coin also needs 50+ holders, a social link, a dev with 10 or fewer earlier coins and a RugCheck risk score of 50 or less.', P: withP({ maxHold: 120 }), C: Object.assign({}, CHK, { minHolders: 50, social: true, devMints: 10, rcMax: 50 }) },
      ],
    };
  })();
  return { run, findEntry, hold, buy, sell, priceFor, feeRate, reserves, stitch, words, memeScore, curveProgress, aggregate, STOP, DEF, SUPPLY, CURVE_K, POOL_K, GRAD_MC_SOL, CURVE_FLOOR, RULES };
})();
if (typeof module !== 'undefined') module.exports = SNIPER;
