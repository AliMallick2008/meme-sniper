/* BTC Paper Lab engine: indicators, conservative simulator, frozen strategies, metrics.
   Mirrors research/bt.py + research/lab.py exactly (verified trade-for-trade). */
const ENGINE = (() => {
  const KR_TH = [0, 2500, 10000, 25000, 50000, 100000, 250000, 500000, 1000000];
  const KR_MK = [0.0040, 0.0030, 0.0022, 0.0020, 0.0015, 0.0012, 0.0010, 0.0008, 0.0006];
  const KR_TK = [0.0080, 0.0060, 0.0038, 0.0035, 0.0030, 0.0025, 0.0022, 0.0020, 0.0018];
  const SLIP_TAKER = 0.0002, SLIP_STOP = 0.0005, THROUGH = 0.0002, MONTH = 30 * 86400;
  const REASONS = ['', 'stop', 'target', 'time', 'session', 'signal', 'end'];

  function tierInfo(volT, volN, now) {
    let tot = 0;
    for (let k = 0; k < volT.length; k++) if (volT[k] > now - MONTH) tot += volN[k];
    let tier = 0;
    for (let t = 0; t < KR_TH.length; t++) if (tot >= KR_TH[t]) tier = t;
    return { vol30: tot, tier, maker: KR_MK[tier], taker: KR_TK[tier] };
  }
  function feeRate(isMaker, feeModel, volT, volN, now) {
    if (feeModel.kind === 'flat') return isMaker ? feeModel.maker : feeModel.taker;
    const ti = tierInfo(volT, volN, now);
    return isMaker ? ti.maker : ti.taker;
  }

  // ---------------------------------------------------------------- indicators
  function sma(x, n) {
    const out = new Float64Array(x.length).fill(NaN);
    let s = 0;
    for (let i = 0; i < x.length; i++) {
      s += x[i];
      if (i >= n) s -= x[i - n];
      if (i >= n - 1) out[i] = s / n;
    }
    return out;
  }
  function atrWilder(h, l, c, n) {
    const out = new Float64Array(c.length);
    const a = 1 / n;
    for (let i = 0; i < c.length; i++) {
      let tr = h[i] - l[i];
      if (i > 0) tr = Math.max(tr, Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]));
      out[i] = i === 0 ? tr : out[i - 1] + a * (tr - out[i - 1]);
    }
    return out;
  }

  // ---------------------------------------------------------------- signals container
  function newSig(n) {
    return {
      type: new Int8Array(n), entPx: new Float64Array(n).fill(NaN), entValid: new Int32Array(n).fill(1),
      slAbs: new Float64Array(n).fill(NaN), slPct: new Float64Array(n).fill(NaN),
      tpAbs: new Float64Array(n).fill(NaN), tpPct: new Float64Array(n).fill(NaN),
      eod: new Uint8Array(n), exitSig: new Uint8Array(n), alloc: new Float64Array(n).fill(1),
      note: new Array(n), maxHold: 0,
    };
  }

  /* Simulator. bars = {t,o,h,l,c} arrays; i0 = first bar processed (the signal bar right before the start).
     partialLast: last bar is still forming -> only market fills at its open, no other checks, no signals.
     endExit: force-close at the last bar (backtests only). */
  function simulate(bars, s, o) {
    const { t, o: op, h, l, c } = bars;
    const n = c.length;
    const feeModel = o.feeModel, startEq = o.startEq, i0 = o.i0 || 0;
    const partialLast = !!o.partialLast, endExit = !!o.endExit;
    const trades = [], equity = [], volT = [], volN = [];
    let cash = startEq, qty = 0, inPos = false, entryPx = 0, entryI = -1, entryFee = 0, entryNotional = 0;
    let stop = NaN, tgt = NaN, entryWasLimit = false, entryNote = '';
    let pendType = 0, pendPx = 0, pendUntil = -1, pendSig = -1;

    for (let j = i0; j < n; j++) {
      const partial = partialLast && j === n - 1;
      // ---- entries
      if (!inPos && pendType !== 0 && j <= pendUntil) {
        let filled = false, fill = 0, maker = false;
        if (pendType === 1) { fill = op[j] * (1 + SLIP_TAKER); filled = true; }
        else if (!partial && pendType === 2) {
          if (l[j] < pendPx * (1 - THROUGH)) { fill = pendPx; filled = true; maker = true; }
        } else if (!partial && pendType === 3) {
          if (h[j] >= pendPx) { fill = (op[j] > pendPx ? op[j] : pendPx) * (1 + SLIP_TAKER); filled = true; }
        }
        if (filled) {
          const notional = s.alloc[pendSig] * cash;
          const fr = feeRate(maker, feeModel, volT, volN, t[j]);
          const fee = notional * fr;
          qty = notional / fill;
          cash -= notional + fee;
          volT.push(t[j]); volN.push(notional);
          inPos = true; entryPx = fill; entryI = j; entryFee = fee; entryNotional = notional; entryWasLimit = maker;
          entryNote = s.note[pendSig] || '';
          const si = pendSig;
          stop = NaN;
          if (!isNaN(s.slAbs[si])) stop = s.slAbs[si]; else if (!isNaN(s.slPct[si])) stop = fill * (1 - s.slPct[si]);
          tgt = NaN;
          if (!isNaN(s.tpAbs[si])) tgt = s.tpAbs[si]; else if (!isNaN(s.tpPct[si])) tgt = fill * (1 + s.tpPct[si]);
          pendType = 0;
        }
      } else if (pendType !== 0 && j > pendUntil) {
        pendType = 0;
      }
      // ---- manage position
      if (inPos) {
        let exitPx = NaN, reason = 0, maker = false;
        const tgtOk = !(entryWasLimit && j === entryI);
        if (j > entryI && s.exitSig[j - 1]) { exitPx = op[j] * (1 - SLIP_TAKER); reason = 5; }
        if (reason === 0 && !partial) {
          const hitStop = !isNaN(stop) && l[j] <= stop;
          const hitTgt = tgtOk && !isNaN(tgt) && h[j] > tgt * (1 + THROUGH);
          if (hitTgt && j > entryI && op[j] >= tgt) { exitPx = tgt; reason = 2; maker = true; }
          else if (hitStop) { exitPx = ((op[j] < stop && j > entryI) ? op[j] : stop) * (1 - SLIP_STOP); reason = 1; }
          else if (hitTgt) { exitPx = tgt; reason = 2; maker = true; }
        }
        if (reason === 0 && !partial && s.maxHold > 0 && (j - entryI + 1) >= s.maxHold) { exitPx = c[j] * (1 - SLIP_TAKER); reason = 3; }
        if (reason === 0 && !partial && s.eod[j]) { exitPx = c[j] * (1 - SLIP_TAKER); reason = 4; }
        if (reason === 0 && endExit && j === n - 1) { exitPx = c[j] * (1 - SLIP_TAKER); reason = 6; }
        if (reason !== 0) {
          const proceeds = qty * exitPx;
          const fr = feeRate(maker, feeModel, volT, volN, t[j]);
          const fee = proceeds * fr;
          cash += proceeds - fee;
          volT.push(t[j]); volN.push(proceeds);
          trades.push({
            entryT: t[entryI], exitT: t[j], entryBar: entryI, exitBar: j, entryPx, exitPx, qty,
            fees: entryFee + fee, entryFee, exitFee: fee, gross: proceeds - entryNotional,
            net: proceeds - entryNotional - entryFee - fee, reason: REASONS[reason], notional: entryNotional,
            limitEntry: entryWasLimit, makerExit: maker, bars: j - entryI + 1, why: entryNote,
            stop, target: tgt,
          });
          inPos = false; qty = 0;
        }
      }
      equity.push(cash + qty * c[j]);
      // ---- new signal at close of bar j
      // (backtests ignore a signal on the final bar, like research/bt.py; live mode keeps it as a pending order)
      if (!partial && !inPos && s.type[j] !== 0 && (j < n - 1 || !endExit)) {
        pendType = s.type[j]; pendPx = s.entPx[j];
        pendUntil = j + (s.type[j] === 1 ? 1 : s.entValid[j]); pendSig = j;
      }
    }
    const open = inPos ? { entryT: t[entryI], entryPx, qty, notional: entryNotional, entryFee, stop, target: tgt, why: entryNote, entryBar: entryI } : null;
    const pending = pendType !== 0 ? { type: pendType, px: pendPx, until: pendUntil, sig: pendSig, why: s.note[pendSig] || '' } : null;
    return { trades, equity, cash, qty, open, pending, volT, volN, i0 };
  }

  // ---------------------------------------------------------------- strategies (frozen)
  const DAY = 86400, M5 = 300;

  // Trend Swing: daily bars. Hold BTC while the daily close is above its 50-day average.
  function swing(daily, n = 50) {
    const N = daily.c.length, s = newSig(N);
    const avg = sma(daily.c, n);
    for (let i = 0; i < N; i++) {
      if (isNaN(avg[i])) continue;
      if (daily.c[i] > avg[i]) {
        s.type[i] = 1;
        s.note[i] = `Daily close $${fmt(daily.c[i])} was above the ${n}-day average $${fmt(avg[i])}, so the bot buys at the next daily open.`;
      } else {
        s.exitSig[i] = 1;
      }
    }
    return { sig: s, avg };
  }

  // Breakout Day Trader: buy-stop at yesterday's close + k * yesterday's range, only when yesterday
  // closed above its 20-day average; size = min(100%, 5% / yesterday's range%); flat at the UTC day end.
  function dayBreakout(m5, daily, k = 0.7, trendN = 20, volTarget = 0.05) {
    const N = m5.c.length, s = newSig(N);
    const avg = sma(daily.c, trendN);
    const dayIdx = new Map();
    daily.t.forEach((tt, i) => dayIdx.set(tt, i));
    const plan = new Map(); // day start -> plan for that day
    for (let i = 1; i < daily.t.length; i++) {
      const d0 = daily.t[i - 1];
      const prevClose = daily.c[i - 1], rng = daily.h[i - 1] - daily.l[i - 1];
      plan.set(d0 + DAY, {
        day: d0 + DAY, prevClose, prevHigh: daily.h[i - 1], prevLow: daily.l[i - 1], rng,
        trig: prevClose + k * rng, avg: avg[i - 1], trendOk: !isNaN(avg[i - 1]) && prevClose > avg[i - 1],
        alloc: Math.min(1, Math.max(0, volTarget / (rng / prevClose))),
      });
    }
    // also plan for "tomorrow" off the last completed daily bar
    const L = daily.t.length - 1;
    if (L >= 0) {
      const rng = daily.h[L] - daily.l[L];
      plan.set(daily.t[L] + DAY, {
        day: daily.t[L] + DAY, prevClose: daily.c[L], prevHigh: daily.h[L], prevLow: daily.l[L], rng,
        trig: daily.c[L] + k * rng, avg: avg[L], trendOk: !isNaN(avg[L]) && daily.c[L] > avg[L],
        alloc: Math.min(1, Math.max(0, volTarget / (rng / daily.c[L]))),
      });
    }
    for (let i = 0; i < N; i++) {
      const end = m5.t[i] + M5;
      if (end % DAY !== 0) continue;
      s.eod[i] = 1;
      const p = plan.get(end);
      if (!p || !p.trendOk) continue;
      // bars in the next day (normally 288)
      let cnt = 0;
      for (let j = i + 1; j < N && m5.t[j] < end + DAY; j++) cnt++;
      s.type[i] = 3;
      s.entPx[i] = p.trig;
      s.entValid[i] = Math.max(cnt, 288);
      s.alloc[i] = p.alloc;
      s.note[i] = `Price broke above today's trigger $${fmt(p.trig)} (yesterday's close $${fmt(p.prevClose)} + 0.7 × yesterday's range $${fmt(p.rng)}). Trend filter passed: yesterday's close was above the 20-day average $${fmt(p.avg)}. Position size ${Math.round(p.alloc * 100)}% of cash.`;
    }
    return { sig: s, plan };
  }

  // Old bot replica: 20-bar breakout on 5-minute candles, 1.5x ATR stop, 3x ATR target, 4-hour max hold.
  function oldBot(m5, look = 20, stopAtr = 1.5, tgtAtr = 3.0, hold = 48) {
    const N = m5.c.length, s = newSig(N);
    const a = atrWilder(m5.h, m5.l, m5.c, 14);
    for (let i = look; i < N; i++) {
      let hh = -Infinity;
      for (let j = i - look; j < i; j++) if (m5.h[j] > hh) hh = m5.h[j];
      s.slPct[i] = stopAtr * a[i] / m5.c[i];
      s.tpPct[i] = tgtAtr * a[i] / m5.c[i];
      if (m5.c[i] > hh) {
        s.type[i] = 1;
        s.note[i] = `5-minute close $${fmt(m5.c[i])} broke above the prior 20-candle high $${fmt(hh)}. Stop ${(s.slPct[i] * 100).toFixed(2)}% below, target ${(s.tpPct[i] * 100).toFixed(2)}% above.`;
      }
    }
    s.maxHold = hold;
    return { sig: s, atr: a };
  }

  /* Trend Swing v2: the 50-day-average rule on daily closes, executed on 5-minute candles with
     limit-first orders. At each day-end candle: flat and close > avg -> limit buy at that close;
     long and close <= avg -> limit sell at that close. The limit lives for K candles (maker fill only
     if price trades 2 bp through it), then becomes a market order. Mirrors research/swing2.py. */
  function swingV2(m5, daily, o) {
    const { feeModel, startEq, i0 } = o;
    const K = o.K == null ? 48 : o.K, delta = o.delta || 0, b = o.band || 0, n = o.n || 50, endExit = !!o.endExit;
    const avg = sma(daily.c, n);
    const avgByDay = new Map();
    daily.t.forEach((tt, i) => avgByDay.set(tt, avg[i]));
    const { t, o: op, h, l, c } = m5;
    const N = c.length;
    const trades = [], equity = [], volT = [], volN = [];
    let cash = startEq, qty = 0, inPos = false, entryPx = 0, entryI = -1, entryFee = 0, entryNotional = 0, entryMaker = false, entryNote = '';
    let pend = 0, pendPx = 0, pendStart = -1, pendSigT = 0, pendNote = '';
    const push = (j, px, maker, reason, fr) => {
      const proceeds = qty * px, fee = proceeds * fr;
      cash += proceeds - fee;
      volT.push(t[j]); volN.push(proceeds);
      trades.push({
        entryT: t[entryI], exitT: t[j], entryBar: entryI, exitBar: j, entryPx, exitPx: px, qty,
        fees: entryFee + fee, entryFee, exitFee: fee, gross: proceeds - entryNotional,
        net: proceeds - entryNotional - entryFee - fee, reason, notional: entryNotional,
        limitEntry: entryMaker, makerExit: maker, bars: j - entryI + 1, why: entryNote, stop: NaN, target: NaN,
      });
      inPos = false; qty = 0;
    };
    for (let j = i0; j < N; j++) {
      if (pend !== 0 && j >= pendStart) {
        const k = j - pendStart;
        let filled = false, maker = false, px = 0;
        if (K === 0 || k >= K) { px = pend === 1 ? op[j] * (1 + SLIP_TAKER) : op[j] * (1 - SLIP_TAKER); filled = true; }
        else if (pend === 1 && l[j] < pendPx * (1 - THROUGH)) { px = pendPx; filled = true; maker = true; }
        else if (pend === -1 && h[j] > pendPx * (1 + THROUGH)) { px = pendPx; filled = true; maker = true; }
        if (filled) {
          const fr = feeRate(maker, feeModel, volT, volN, t[j]);
          if (pend === 1) {
            const notional = cash, fee = notional * fr;
            qty = notional / px; cash -= notional + fee;
            volT.push(t[j]); volN.push(notional);
            inPos = true; entryPx = px; entryI = j; entryFee = fee; entryNotional = notional; entryMaker = maker; entryNote = pendNote;
          } else {
            push(j, px, maker, 'signal', fr);
          }
          pend = 0;
        }
      }
      if (endExit && j === N - 1 && inPos) push(j, c[j] * (1 - SLIP_TAKER), false, 'end', feeRate(false, feeModel, volT, volN, t[j]));
      equity.push(cash + qty * c[j]);
      if ((t[j] + M5) % DAY === 0 && pend === 0 && (j < N - 1 || !endExit)) {
        const a = avgByDay.get(t[j] + M5 - DAY);
        if (a !== undefined && !isNaN(a)) {
          if (!inPos && c[j] > a * (1 + b)) {
            pend = 1; pendPx = c[j] * (1 - delta); pendStart = j + 1; pendSigT = t[j];
            pendNote = `Daily close $${fmt(c[j])} was above the ${n}-day average $${fmt(a)}. Limit buy placed at that close for 4 hours, then a market order if it hadn't filled.`;
          } else if (inPos && c[j] <= a * (1 - b)) {
            pend = -1; pendPx = c[j] * (1 + delta); pendStart = j + 1; pendSigT = t[j];
            pendNote = `Daily close $${fmt(c[j])} was below the ${n}-day average $${fmt(a)}.`;
          }
        }
      }
    }
    const open = inPos ? { entryT: t[entryI], entryPx, qty, notional: entryNotional, entryFee, stop: NaN, target: NaN, why: entryNote, entryBar: entryI, limitEntry: entryMaker } : null;
    const pending = pend !== 0 ? { side: pend === 1 ? 'buy' : 'sell', px: pendPx, from: pendSigT + M5, limitUntil: pendSigT + M5 + K * M5, why: pendNote } : null;
    return { trades, equity, cash, qty, open, pending, volT, volN, i0 };
  }

  /* Multi-sleeve daily trend engine (Trend Swing v2, Half-Size, Leveraged, Multi-Speed).
     Mirrors research/sleeves.py: per-sleeve N-day average, weight, allocation (fixed or 100%/vol capped),
     limit-first orders, shared fee tiers, borrowing interest every 5 minutes, liquidation at maintenance margin. */
  const BAR_YEARS = 300.0 / (365.0 * 86400.0);
  function rollingVol(dc, n) {
    const N = dc.length, out = new Float64Array(N).fill(NaN), r = new Float64Array(N).fill(NaN);
    for (let i = 1; i < N; i++) r[i] = Math.log(dc[i]) - Math.log(dc[i - 1]);
    for (let i = n; i < N; i++) {
      let m = 0;
      for (let k = i - n + 1; k <= i; k++) m += r[k];
      m /= n;
      let v = 0;
      for (let k = i - n + 1; k <= i; k++) v += (r[k] - m) * (r[k] - m);
      out[i] = Math.sqrt(v / (n - 1)) * Math.sqrt(365);
    }
    return out;
  }
  /* ---------- daily buy/hold signals for the 10 lab bots (mirror research/signals.py loop for loop) ---------- */
  function sigTrend(c, n) {
    const s = sma(c, n), w = new Float64Array(c.length).fill(NaN);
    for (let i = 0; i < c.length; i++) if (!isNaN(s[i])) w[i] = c[i] > s[i] ? 1 : 0;
    return w;
  }
  function sigTurtle(h, l, c, nIn = 20, nOut = 10) {
    const w = new Float64Array(c.length).fill(NaN);
    let state = 0;
    for (let i = nIn; i < c.length; i++) {
      let hh = -Infinity, ll = Infinity;
      for (let k = i - nIn; k < i; k++) if (h[k] > hh) hh = h[k];
      for (let k = i - nOut; k < i; k++) if (l[k] < ll) ll = l[k];
      if (state === 0 && c[i] > hh) state = 1;
      else if (state === 1 && c[i] < ll) state = 0;
      w[i] = state;
    }
    return w;
  }
  function sigMomentum(c, n) {
    const w = new Float64Array(c.length).fill(NaN);
    for (let i = n; i < c.length; i++) w[i] = c[i] > c[i - n] ? 1 : 0;
    return w;
  }
  function sigGolden(c) {
    const a = sma(c, 50), b = sma(c, 200), w = new Float64Array(c.length).fill(NaN);
    for (let i = 0; i < c.length; i++) if (!(isNaN(a[i]) || isNaN(b[i]))) w[i] = a[i] > b[i] ? 1 : 0;
    return w;
  }
  function sigWeekly(t, c, n = 50) {
    const s = sma(c, n), w = new Float64Array(c.length).fill(NaN);
    let state = NaN;
    for (let i = 0; i < c.length; i++) {
      const weekday = (Math.floor(t[i] / DAY) + 3) % 7; // 0 = Monday ... 6 = Sunday (UTC)
      if (weekday === 6 && !isNaN(s[i])) state = c[i] > s[i] ? 1 : 0;
      w[i] = state;
    }
    return w;
  }
  function sigChandelier(h, l, c, n = 50, atrN = 22, mult = 3.0) {
    const atr = atrWilder(h, l, c, atrN), w = new Float64Array(c.length).fill(NaN);
    let state = 0, hc = 0;
    for (let i = n; i < c.length; i++) {
      if (state === 0) {
        let hh = -Infinity;
        for (let k = i - n; k < i; k++) if (h[k] > hh) hh = h[k];
        if (c[i] > hh) { state = 1; hc = c[i]; }
      } else {
        hc = Math.max(hc, c[i]);
        if (c[i] < hc - mult * atr[i]) state = 0;
      }
      w[i] = state;
    }
    return w;
  }
  function rsiLoop(c, n) {
    const out = new Float64Array(c.length).fill(NaN), a = 1.0 / n;
    let up = 0, dn = 0;
    for (let i = 1; i < c.length; i++) {
      const d = c[i] - c[i - 1], u = d > 0 ? d : 0, v = d < 0 ? -d : 0;
      if (i === 1) { up = u; dn = v; } else { up = up + a * (u - up); dn = dn + a * (v - dn); }
      out[i] = dn === 0 ? (up > 0 ? 100 : NaN) : 100.0 - 100.0 / (1.0 + up / dn);
    }
    return out;
  }
  function sigRsi2(c) {
    const r = rsiLoop(c, 2), s200 = sma(c, 200), s5 = sma(c, 5), w = new Float64Array(c.length).fill(NaN);
    let state = 0;
    for (let i = 0; i < c.length; i++) {
      if (isNaN(s200[i])) continue;
      if (state === 0 && !isNaN(r[i]) && r[i] < 10 && c[i] > s200[i]) state = 1;
      else if (state === 1 && c[i] > s5[i]) state = 0;
      w[i] = state;
    }
    return w;
  }
  function sigBollinger(c, n = 20, k = 2.0) {
    const s200 = sma(c, 200), w = new Float64Array(c.length).fill(NaN);
    let state = 0;
    for (let i = 0; i < c.length; i++) {
      if (i < n - 1 || isNaN(s200[i])) continue;
      let m = 0;
      for (let j = i - n + 1; j <= i; j++) m += c[j];
      m /= n;
      let v = 0;
      for (let j = i - n + 1; j <= i; j++) v += (c[j] - m) * (c[j] - m);
      const sd = Math.sqrt(v / n);
      if (state === 0 && c[i] < m - k * sd && c[i] > s200[i]) state = 1;
      else if (state === 1 && c[i] > m) state = 0;
      w[i] = state;
    }
    return w;
  }
  function sigVolBelow(c, thresh) {
    const v = rollingVol(c, 30), w = new Float64Array(c.length).fill(NaN);
    for (let i = 0; i < c.length; i++) if (!isNaN(v[i])) w[i] = v[i] < thresh ? 1 : 0;
    return w;
  }
  const VOL_STEPS = [0.40, 0.55, 0.70, 0.85];
  function labBots(daily) {
    const { t, h, l, c } = daily;
    return {
      turtle: [[1.0, sigTurtle(h, l, c)]],
      mom4w: [[1.0, sigMomentum(c, 28)]],
      mom12m: [[1.0, sigMomentum(c, 365)]],
      golden: [[1.0, sigGolden(c)]],
      weekly: [[1.0, sigWeekly(t, c)]],
      chand: [[1.0, sigChandelier(h, l, c)]],
      rsi2: [[1.0, sigRsi2(c)]],
      boll: [[1.0, sigBollinger(c)]],
      volman: VOL_STEPS.map(th => [0.25, sigVolBelow(c, th)]),
      committee: [[0.25, sigTrend(c, 50)], [0.25, sigTurtle(h, l, c)], [0.25, sigMomentum(c, 28)], [0.25, sigGolden(c)]],
    };
  }

  function sleeves(m5, daily, cfg) {
    const { t, o: op, h, l, c } = m5;
    const N = c.length, S = (cfg.wants || cfg.lens).length;
    const K = cfg.K == null ? 48 : cfg.K;
    const maint = cfg.maint == null ? 0.10 : cfg.maint, liqPen = cfg.liqPen == null ? 0.01 : cfg.liqPen;
    const endExit = !!cfg.endExit, feeModel = cfg.feeModel, i0 = cfg.i0;
    const borrow = cfg.borrow || new Array(S).fill(0);
    const avgMaps = cfg.wants ? null : cfg.lens.map(n => { const a = sma(daily.c, n), m = new Map(); daily.t.forEach((tt, i) => m.set(tt, a[i])); return m; });
    // decision grid: daily closes by default; cfg.step (seconds) + cfg.wantT (keys = candle start times) for other timeframes
    const step = cfg.step || DAY, keyT = cfg.wantT || daily.t;
    const wantMaps = cfg.wants ? cfg.wants.map(wv => { const m = new Map(); keyT.forEach((tt, i) => m.set(tt, wv[i])); return m; }) : null;
    const vols = rollingVol(daily.c, 30), volMap = new Map();
    daily.t.forEach((tt, i) => volMap.set(tt, vols[i]));
    const allocAt = (s, day) => {
      const x = cfg.allocs[s];
      if (typeof x === 'number') return x;
      const v = volMap.get(day);
      const a = Math.min(x.cap, x.target / v);
      return isNaN(a) ? 1.0 : a;
    };
    const cash = cfg.weights.map(w => w * cfg.startEq);
    const qty = new Array(S).fill(0), inPos = new Array(S).fill(false);
    const entryPx = new Array(S).fill(0), entryI = new Array(S).fill(-1), entryFee = new Array(S).fill(0);
    const entryNotional = new Array(S).fill(0), entryMaker = new Array(S).fill(false), entryNote = new Array(S).fill('');
    const pend = new Array(S).fill(0), pendPx = new Array(S).fill(0), pendStart = new Array(S).fill(-1), pendAlloc = new Array(S).fill(1);
    const pendSigT = new Array(S).fill(0), pendNote = new Array(S).fill('');
    const trades = [], equity = [], inMkt = [], volT = [], volN = [];
    const record = (s, j, px, fee, pen, reason, maker) => {
      const proceeds = qty[s] * px;
      trades.push({
        sleeve: s, entryT: t[entryI[s]], exitT: t[j], entryBar: entryI[s], exitBar: j, entryPx: entryPx[s], exitPx: px, qty: qty[s],
        fees: entryFee[s] + fee + pen, entryFee: entryFee[s], exitFee: fee + pen, gross: proceeds - entryNotional[s],
        net: proceeds - entryNotional[s] - entryFee[s] - fee - pen, reason, notional: entryNotional[s],
        limitEntry: entryMaker[s], makerExit: maker, bars: j - entryI[s] + 1, why: entryNote[s], stop: NaN, target: NaN,
      });
    };
    for (let j = i0; j < N; j++) {
      // 1) pending orders
      for (let s = 0; s < S; s++) {
        if (pend[s] !== 0 && j >= pendStart[s]) {
          const k = j - pendStart[s];
          let filled = false, maker = false, px = 0;
          if (K === 0 || k >= K) { px = pend[s] === 1 ? op[j] * (1 + SLIP_TAKER) : op[j] * (1 - SLIP_TAKER); filled = true; }
          else if (pend[s] === 1 && l[j] < pendPx[s] * (1 - THROUGH)) { px = pendPx[s]; filled = true; maker = true; }
          else if (pend[s] === -1 && h[j] > pendPx[s] * (1 + THROUGH)) { px = pendPx[s]; filled = true; maker = true; }
          if (filled) {
            const fr = feeRate(maker, feeModel, volT, volN, t[j]);
            if (pend[s] === 1) {
              const notional = pendAlloc[s] * cash[s], fee = notional * fr;
              qty[s] = notional / px;
              cash[s] -= notional + fee;
              volT.push(t[j]); volN.push(notional);
              inPos[s] = true; entryPx[s] = px; entryI[s] = j; entryFee[s] = fee; entryNotional[s] = notional; entryMaker[s] = maker;
              entryNote[s] = pendNote[s];
            } else {
              const proceeds = qty[s] * px, fee = proceeds * fr;
              cash[s] += proceeds - fee;
              volT.push(t[j]); volN.push(proceeds);
              record(s, j, px, fee, 0, 'signal', maker);
              inPos[s] = false; qty[s] = 0;
            }
            pend[s] = 0;
          }
        }
      }
      // 2) liquidation
      for (let s = 0; s < S; s++) {
        if (borrow[s] > 0 && inPos[s] && cash[s] < 0) {
          const pLiq = -cash[s] / ((1.0 - maint) * qty[s]);
          if (l[j] <= pLiq) {
            const base = op[j] < pLiq ? op[j] : pLiq;
            const px = base * (1 - SLIP_STOP);
            const proceeds = qty[s] * px;
            const fee = proceeds * feeRate(false, feeModel, volT, volN, t[j]);
            const pen = proceeds * liqPen;
            cash[s] += proceeds - fee - pen;
            volT.push(t[j]); volN.push(proceeds);
            record(s, j, px, fee, pen, 'liquidated', false);
            if (cash[s] < 0) cash[s] = 0.0;
            inPos[s] = false; qty[s] = 0; pend[s] = 0;
          }
        }
      }
      // 3) interest on borrowed cash
      for (let s = 0; s < S; s++) if (borrow[s] > 0 && cash[s] < 0) cash[s] -= (-cash[s]) * borrow[s] * BAR_YEARS;
      // 4) backtest end
      if (endExit && j === N - 1) {
        for (let s = 0; s < S; s++) {
          if (inPos[s]) {
            const px = c[j] * (1 - SLIP_TAKER), proceeds = qty[s] * px;
            const fee = proceeds * feeRate(false, feeModel, volT, volN, t[j]);
            cash[s] += proceeds - fee;
            volT.push(t[j]); volN.push(proceeds);
            record(s, j, px, fee, 0, 'end', false);
            inPos[s] = false; qty[s] = 0;
          }
        }
      }
      let tot = 0, any = false;
      for (let s = 0; s < S; s++) { tot += cash[s] + qty[s] * c[j]; if (qty[s] > 0) any = true; }
      equity.push(tot); inMkt.push(any);
      // 5) decisions at each daily (or cfg.step) close (backtests skip the final candle like research/sleeves.py)
      if ((t[j] + M5) % step === 0 && (j < N - 1 || !endExit)) {
        const day = t[j] + M5 - step;
        for (let s = 0; s < S; s++) {
          if (wantMaps) {
            const wv = wantMaps[s].get(day);
            if (pend[s] !== 0 || wv === undefined || isNaN(wv)) continue;
            if (!inPos[s] && wv > 0.5 && cash[s] > 0) {
              pend[s] = 1; pendPx[s] = c[j]; pendStart[s] = j + 1; pendAlloc[s] = allocAt(s, day); pendSigT[s] = t[j];
              pendNote[s] = cfg.noteFn ? cfg.noteFn('buy', s, day, c[j]) : `Buy signal at the daily close $${fmt(c[j])}: ${cfg.desc ? cfg.desc[s] : 'rule turned on'}. Limit buy at that close for 4 hours, then market.`;
            } else if (inPos[s] && wv < 0.5) {
              pend[s] = -1; pendPx[s] = c[j]; pendStart[s] = j + 1; pendSigT[s] = t[j];
              pendNote[s] = cfg.noteFn ? cfg.noteFn('sell', s, day, c[j]) : `Sell signal at the daily close $${fmt(c[j])}.`;
            }
            continue;
          }
          const a = avgMaps[s].get(day);
          if (pend[s] !== 0 || a === undefined || isNaN(a)) continue;
          const nDays = cfg.lens[s];
          if (!inPos[s] && c[j] > a && cash[s] > 0) {
            pend[s] = 1; pendPx[s] = c[j]; pendStart[s] = j + 1; pendAlloc[s] = allocAt(s, day); pendSigT[s] = t[j];
            const lev = typeof cfg.allocs[s] === 'number' ? '' : ` Leverage ${pendAlloc[s].toFixed(2)}x (100% ÷ 30-day volatility ${(volMap.get(day) * 100).toFixed(0)}%, capped at ${cfg.allocs[s].cap}x).`;
            pendNote[s] = `Daily close $${fmt(c[j])} was above the ${nDays}-day average $${fmt(a)}. Limit buy at that close for 4 hours, then market.${lev}`;
          } else if (inPos[s] && c[j] <= a) {
            pend[s] = -1; pendPx[s] = c[j]; pendStart[s] = j + 1; pendSigT[s] = t[j];
            pendNote[s] = `Daily close $${fmt(c[j])} was at or below the ${nDays}-day average $${fmt(a)}.`;
          }
        }
      }
    }
    const opens = [], pendings = [], sl = [];
    const lastDay = daily.t.length ? daily.t[daily.t.length - 1] : NaN;
    const lastKey = cfg.wantT ? cfg.wantT[cfg.wantT.length - 1] : lastDay;
    for (let s = 0; s < S; s++) {
      if (inPos[s]) opens.push({ sleeve: s, entryT: t[entryI[s]], entryPx: entryPx[s], qty: qty[s], notional: entryNotional[s], entryFee: entryFee[s], stop: NaN, target: NaN, why: entryNote[s], entryBar: entryI[s], limitEntry: entryMaker[s], liqPx: borrow[s] > 0 && cash[s] < 0 ? -cash[s] / ((1.0 - maint) * qty[s]) : NaN, borrowed: cash[s] < 0 ? -cash[s] : 0 });
      if (pend[s] !== 0) pendings.push({ sleeve: s, side: pend[s] === 1 ? 'buy' : 'sell', px: pendPx[s], from: pendSigT[s] + M5, limitUntil: pendSigT[s] + M5 + K * M5, alloc: pendAlloc[s], why: pendNote[s] });
      sl.push({ len: cfg.lens ? cfg.lens[s] : null, inPos: inPos[s], cash: cash[s], qty: qty[s], avg: avgMaps ? avgMaps[s].get(lastDay) : NaN, want: wantMaps ? wantMaps[s].get(lastKey) : NaN, nextAlloc: allocAt(s, lastDay) });
    }
    return { trades, equity, inMkt, cash: cash.reduce((x, y) => x + y, 0), opens, pendings, sleeves: sl, volT, volN, i0, open: opens[0] || null, pending: pendings[0] || null };
  }

  /* ---------- 1h/15m Trader (mirrors research/mtf_live.py loop for loop) ----------
     Context: the last FINISHED 1-hour candle vs its 200-hour average (+/-1% band).
     Execution: decisions only at 15-minute closes; buy on a 15-minute RSI(14) dip under 35 while the
     1-hour close is more than 1% above the average; sell when a 1-hour close is more than 1% below it. */
  const MTF = { rsiN: 14, rsiBuy: 35, smaN: 200, band: 0.01, K: 6, step: 900 };
  function bars15(m5) {
    // 15-minute candles from 5-minute candles; bucket = floor(t / 900) * 900 (pandas resample, label/closed left)
    const t = [], o = [], h = [], l = [], c = [];
    for (let i = 0; i < m5.t.length; i++) {
      const b = Math.floor(m5.t[i] / 900) * 900, k = t.length - 1;
      if (k >= 0 && t[k] === b) { if (m5.h[i] > h[k]) h[k] = m5.h[i]; if (m5.l[i] < l[k]) l[k] = m5.l[i]; c[k] = m5.c[i]; }
      else { t.push(b); o.push(m5.o[i]); h.push(m5.h[i]); l.push(m5.l[i]); c.push(m5.c[i]); }
    }
    return { t, o, h, l, c };
  }
  function mtfWant(m15, h1, start, P = MTF) {
    const N = m15.t.length;
    const rsi = rsiLoop(m15.c, P.rsiN), avg = sma(h1.c, P.smaN);
    const want = new Float64Array(N).fill(NaN), hClose = new Float64Array(N).fill(NaN), hAvg = new Float64Array(N).fill(NaN);
    const hT = new Float64Array(N).fill(NaN);
    let j = -1, st = 0;
    for (let k = 0; k < N; k++) {
      const T = m15.t[k] + P.step; // decision time = this 15m candle's close
      while (j + 1 < h1.t.length && h1.t[j + 1] + 3600 <= T) j++;
      if (j >= 0) { hClose[k] = h1.c[j]; hAvg[k] = avg[j]; hT[k] = h1.t[j]; }
      if (T < start || isNaN(rsi[k]) || isNaN(hAvg[k])) continue;
      const allow = hClose[k] > hAvg[k] * (1 + P.band), force = hClose[k] < hAvg[k] * (1 - P.band);
      if (st === 0 && allow && rsi[k] < P.rsiBuy) st = 1;
      else if (st === 1 && force) st = 0;
      want[k] = st;
    }
    return { t: m15.t, want, rsi, hClose, hAvg, hT };
  }

  /* ---------- Futures Breakout (mirrors research/futb_live.py and research/s_engine.run_sim) ----------
     Each UTC day: trigger = day's open + 0.6 x previous UTC day's range. First 5-minute close above it = long at
     the next open (market), stop = that close - 0.5 x previous range, exit at the UTC day's end. 1.5x of equity.
     Per-trade return on notional = exit/entry - 1 - taker in - taker out - funding (prices include slippage). */
  const FUTB = { k: 0.6, stopR: 0.5, lev: 1.5, taker: 0.0005, slipM: 0.0002, slipS: 0.0005, fund: 0.0001 / 96 };
  function utcSessions(t, o, h, l) {
    const N = t.length, sid = new Float64Array(N), sopen = new Float64Array(N), prng = new Float64Array(N).fill(NaN), send = new Uint8Array(N);
    let cur = -1, so = 0, hi = 0, lo = 0, last = NaN;
    for (let i = 0; i < N; i++) {
      const s = Math.floor(t[i] / 86400);
      sid[i] = s;
      if (s !== cur) {
        if (cur !== -1) last = hi - lo;
        cur = s; so = o[i]; hi = h[i]; lo = l[i];
      } else {
        if (h[i] > hi) hi = h[i];
        if (l[i] < lo) lo = l[i];
      }
      sopen[i] = so; prng[i] = last;
    }
    for (let i = 0; i < N - 1; i++) if (sid[i + 1] !== sid[i]) send[i] = 1;
    return { sid, sopen, prng, send };
  }
  function futBreakout(m5, cfg) {
    const { t, o: op, h, l, c } = m5;
    const N = c.length, P = FUTB, endExit = !!cfg.endExit, i0 = cfg.i0;
    const S = utcSessions(t, op, h, l);
    const side = new Uint8Array(N);
    let cur = -1, done = false;
    for (let i = 0; i < N; i++) {
      if (S.sid[i] !== cur) { cur = S.sid[i]; done = false; }
      if (isNaN(S.prng[i]) || S.send[i]) continue;
      if (!done && c[i] > S.sopen[i] + P.k * S.prng[i]) { side[i] = 1; done = true; }
    }
    let cash = cfg.startEq, pos = 0, ent = 0, entI = -1, st = NaN, notional = 0, entNote = '';
    let pend = false, pst = NaN, pSigT = 0, pNote = '';
    const trades = [], equity = [], inMkt = [];
    for (let j = i0; j < N; j++) {
      if (pos === 0 && pend) {
        const px = op[j] * (1 + P.slipM);
        if (px - pst > 0) { pos = 1; ent = px; entI = j; st = pst; notional = P.lev * cash; entNote = pNote; }
        pend = false;
      }
      if (pos === 1) {
        let xp = 0, why = '';
        const same = j === entI;
        if (!same && S.send[j - 1]) { xp = op[j] * (1 - P.slipM); why = 'session'; }
        else if (l[j] <= st) { const b = (!same && op[j] < st) ? op[j] : st; xp = b * (1 - P.slipS); why = 'stop'; }
        else if (endExit && j === N - 1) { xp = c[j] * (1 - P.slipM); why = 'end'; }
        if (why) {
          const bars = j - entI + 1, gross = xp / ent - 1, net = gross - P.taker - P.taker - P.fund * bars;
          const qty = notional / ent, fees = notional * (2 * P.taker), fund = notional * P.fund * bars;
          cash += notional * net;
          trades.push({
            entryT: t[entI], exitT: t[j], entryBar: entI, exitBar: j, entryPx: ent, exitPx: xp, qty, notional,
            fees: fees + fund, entryFee: notional * P.taker, exitFee: notional * P.taker + fund, gross: notional * gross,
            net: notional * net, ret: net, reason: why, bars, why: entNote, stop: st, target: NaN, limitEntry: false, makerExit: false, side: 1,
          });
          pos = 0;
        }
      }
      equity.push(cash + (pos === 1 ? notional * (c[j] / ent - 1) : 0)); inMkt.push(pos === 1);
      if (pos === 0 && !pend && side[j] === 1 && (j < N - 1 || !endExit)) {
        pend = true; pst = c[j] - P.stopR * S.prng[j]; pSigT = t[j];
        const trg = S.sopen[j] + P.k * S.prng[j];
        pNote = cfg.noteFn ? cfg.noteFn(t[j], c[j], S.sopen[j], S.prng[j], trg, pst) : '';
      }
    }
    const open = pos === 1 ? { entryT: t[entI], entryPx: ent, qty: notional / ent, notional, entryFee: notional * P.taker, stop: st, target: NaN, why: entNote, entryBar: entI, limitEntry: false, bars: N - entI, side: 1 } : null;
    const pending = pend ? { side: 'buy', px: NaN, from: pSigT + M5, limitUntil: pSigT + M5, stop: pst, why: pNote, market: true } : null;
    const L = N - 1;
    const plan = L >= 0 ? { dayStart: S.sid[L] * 86400, open: S.sopen[L], prevRange: S.prng[L], trigger: S.sopen[L] + P.k * S.prng[L], tradedToday: done } : null;
    return { trades, equity, inMkt, cash, opens: open ? [open] : [], pendings: pending ? [pending] : [], open, pending, i0, volT: [], volN: [], futures: true, takerFee: P.taker, plan };
  }

  /* ---------- generalized breakout bot (mirrors research/vbo_live.py) ----------
     P: anchor (UTC hour the 24 h session starts), k, side (1 long, -1 short, 0 both), filt (daily SMA length, 0 = none),
     stop ('none' | 'open' | 'R'), stop_m, hold_h (0 = until the session ends), lev. daily = finished UTC daily candles. */
  function vboFut(m5, daily, cfg) {
    const { t, o: op, h, l, c } = m5;
    const N = c.length, P = { ...FUTB, anchor: 0, side: 1, filt: 0, stop: 'R', stop_m: FUTB.stopR, hold_h: 0, ...cfg.P };
    const endExit = !!cfg.endExit, i0 = cfg.i0, maxHold = P.hold_h * 12;
    const sid = new Float64Array(N), sopen = new Float64Array(N), prng = new Float64Array(N).fill(NaN), send = new Uint8Array(N);
    {
      let cur = -1, so = 0, hi = 0, lo = 0, last = NaN;
      for (let i = 0; i < N; i++) {
        const s = Math.floor((t[i] - P.anchor * 3600) / 86400);
        sid[i] = s;
        if (s !== cur) { if (cur !== -1) last = hi - lo; cur = s; so = op[i]; hi = h[i]; lo = l[i]; }
        else { if (h[i] > hi) hi = h[i]; if (l[i] < lo) lo = l[i]; }
        sopen[i] = so; prng[i] = last;
      }
      for (let i = 0; i < N - 1; i++) if (sid[i + 1] !== sid[i]) send[i] = 1;
    }
    // daily trend filter: latest finished UTC daily close vs its SMA, known at each 5-minute close
    const fu = new Uint8Array(N).fill(1), fd = new Uint8Array(N).fill(1);
    let dClose = NaN, dAvg = NaN;
    if (P.filt) {
      const avg = sma(daily.c, P.filt);
      let j = -1;
      for (let i = 0; i < N; i++) {
        const E = t[i] + M5;
        while (j + 1 < daily.t.length && daily.t[j + 1] + DAY <= E) j++;
        const dc = j >= 0 ? daily.c[j] : NaN, ds = j >= 0 ? avg[j] : NaN;
        fu[i] = dc > ds ? 1 : 0; fd[i] = dc < ds ? 1 : 0;
        if (i === N - 1) { dClose = dc; dAvg = ds; }
      }
    }
    const side = new Int8Array(N);
    let cur = -1, dl = false, dsh = false;
    for (let i = 0; i < N; i++) {
      if (sid[i] !== cur) { cur = sid[i]; dl = false; dsh = false; }
      if (isNaN(prng[i]) || send[i]) continue;
      const lt = sopen[i] + P.k * prng[i], stt = sopen[i] - P.k * prng[i];
      if (P.side !== -1 && !dl && c[i] > lt && fu[i]) { side[i] = 1; dl = true; }
      else if (P.side !== 1 && !dsh && c[i] < stt && fd[i]) { side[i] = -1; dsh = true; }
    }
    let cash = cfg.startEq, pos = 0, ent = 0, entI = -1, st = NaN, notional = 0, entNote = '';
    let ps = 0, pst = NaN, pSigT = 0, pNote = '';
    const trades = [], equity = [], inMkt = [];
    for (let j = i0; j < N; j++) {
      if (pos === 0 && ps !== 0) {
        const px = op[j] * (1 + ps * P.slipM);
        if (isNaN(pst) || ps * (px - pst) > 0) { pos = ps; ent = px; entI = j; st = pst; notional = P.lev * cash; entNote = pNote; }
        ps = 0;
      }
      if (pos !== 0) {
        let xp = 0, why = '';
        const same = j === entI;
        if (!same && send[j - 1]) { xp = op[j] * (1 - pos * P.slipM); why = 'session'; }
        else if (!isNaN(st) && ((pos === 1 && l[j] <= st) || (pos === -1 && h[j] >= st))) {
          const b = pos === 1 ? ((!same && op[j] < st) ? op[j] : st) : ((!same && op[j] > st) ? op[j] : st);
          xp = b * (1 - pos * P.slipS); why = 'stop';
        } else if (maxHold > 0 && (j - entI + 1) >= maxHold) { xp = c[j] * (1 - pos * P.slipM); why = 'time'; }
        else if (endExit && j === N - 1) { xp = c[j] * (1 - pos * P.slipM); why = 'end'; }
        if (why) {
          const bars = j - entI + 1, gross = pos * (xp / ent - 1), net = gross - P.taker - P.taker - P.fund * bars;
          const fund = notional * P.fund * bars;
          cash += notional * net;
          trades.push({
            entryT: t[entI], exitT: t[j], entryBar: entI, exitBar: j, entryPx: ent, exitPx: xp, qty: notional / ent, notional,
            fees: notional * 2 * P.taker + fund, entryFee: notional * P.taker, exitFee: notional * P.taker + fund, gross: notional * gross,
            net: notional * net, ret: net, reason: why, bars, why: entNote, stop: st, target: NaN, limitEntry: false, makerExit: false, side: pos,
          });
          pos = 0;
        }
      }
      equity.push(cash + (pos !== 0 ? notional * pos * (c[j] / ent - 1) : 0)); inMkt.push(pos !== 0);
      if (pos === 0 && ps === 0 && side[j] !== 0 && (j < N - 1 || !endExit)) {
        ps = side[j]; pSigT = t[j];
        pst = P.stop === 'open' ? sopen[j] : P.stop === 'R' ? c[j] - side[j] * P.stop_m * prng[j] : NaN;
        pNote = cfg.noteFn ? cfg.noteFn(side[j], t[j], c[j], sopen[j], prng[j], sopen[j] + side[j] * P.k * prng[j], pst) : '';
      }
    }
    const open = pos !== 0 ? { entryT: t[entI], entryPx: ent, qty: notional / ent, notional, entryFee: notional * P.taker, stop: st, target: NaN, why: entNote, entryBar: entI, limitEntry: false, bars: N - entI, side: pos } : null;
    const pending = ps !== 0 ? { side: ps === 1 ? 'buy' : 'sell', px: NaN, from: pSigT + M5, limitUntil: pSigT + M5, stop: pst, why: pNote, market: true } : null;
    const L = N - 1;
    const plan = L >= 0 ? { sessStart: sid[L] * 86400 + P.anchor * 3600, open: sopen[L], prevRange: prng[L], longTrig: sopen[L] + P.k * prng[L],
      shortTrig: sopen[L] - P.k * prng[L], doneLong: dl, doneShort: dsh, dClose, dAvg, filterUp: P.filt ? dClose > dAvg : true } : null;
    return { trades, equity, inMkt, cash, opens: open ? [open] : [], pendings: pending ? [pending] : [], open, pending, i0, volT: [], volN: [], futures: true, takerFee: P.taker, plan, P };
  }

  /* ---------- Combo 50/50 (v7): two independent halves of the money, never rebalanced ----------
     Half 1 = Trend Swing v2 (spot, limit-first, Kraken tiers on its own volume). Half 2 = Futures Breakout (1.5x of its own
     equity). Each half runs exactly its own engine above; the bot's equity is the sum. Trades carry part: 'swing' | 'futb'. */
  function combo(m5, daily, cfg) {
    const half = cfg.startEq / 2;
    const A = sleeves(m5, daily, { lens: [50], weights: [1], allocs: [1], feeModel: cfg.feeModel, startEq: half, i0: cfg.i0, K: 48, endExit: cfg.endExit });
    const B = futBreakout(m5, { i0: cfg.i0, startEq: half, endExit: cfg.endExit, noteFn: cfg.futNoteFn });
    const tag = (arr, part, fut) => arr.map(x => ({ ...x, part, futures: fut }));
    const trades = tag(A.trades, 'swing', false).concat(tag(B.trades, 'futb', true)).sort((x, y) => (x.exitT - y.exitT) || (x.entryT - y.entryT));
    const opens = tag(A.opens, 'swing', false).concat(tag(B.opens, 'futb', true));
    const pendings = tag(A.pendings, 'swing', false).concat(tag(B.pendings, 'futb', true));
    const equity = A.equity.map((v, k) => v + B.equity[k]);
    const inMkt = A.inMkt.map((v, k) => v || B.inMkt[k]);
    return {
      trades, equity, inMkt, cash: A.cash + B.cash, opens, pendings, open: opens[0] || null, pending: pendings[0] || null, i0: cfg.i0,
      volT: A.volT, volN: A.volN, futTaker: B.takerFee, plan: B.plan, parts: { swing: A, futb: B }, mixed: true,
    };
  }

  function buyHold(N, i0) {
    const s = newSig(N);
    s.type[i0] = 1;
    s.note[i0] = 'Benchmark: buys once at the start and never sells.';
    return { sig: s };
  }

  function fmt(x) { return Number(x).toLocaleString('en-US', { maximumFractionDigits: 0 }); }

  return { simulate, swing, swingV2, sleeves, labBots, VOL_STEPS, rollingVol, dayBreakout, oldBot, buyHold, sma, atrWilder, tierInfo, feeRate, KR_TH, KR_MK, KR_TK, SLIP_TAKER, SLIP_STOP, MTF, bars15, mtfWant, rsiLoop, FUTB, futBreakout, utcSessions, vboFut, combo };
})();
if (typeof module !== 'undefined') module.exports = ENGINE;
