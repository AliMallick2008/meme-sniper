(() => {
  'use strict';
  // ======================================================================= constants
  const START = Date.UTC(2026, 9, 17, 0, 0, 0) / 1000; // Fri Oct 16 2026, 8:00 PM Toronto
  const START_EQ = 8000;
  const TZ = 'America/Toronto';
  const M5 = 300, DAY = 86400;
  const CB = 'https://api.exchange.coinbase.com';
  const BS = 'https://www.bitstamp.net/api/v2';
  const HIST_5M = START - 2 * DAY;
  const HIST_1D = START - 430 * DAY; // 12-month momentum needs 365+ finished days
  // 1h/15m Trader (added in v5): rules locked Fri Oct 16 2026, 10:04 PM Toronto; starts 3 hours after the others
  const MTF_START = START + 3 * 3600; // Fri Oct 16 2026, 11:00 PM Toronto
  const MTF_LOCKED = Date.UTC(2026, 9, 17, 2, 4, 0) / 1000;
  const H1 = 3600, M15 = 900;
  const HIST_1H = MTF_START - 12 * DAY; // the 200-hour average needs 200 finished hours before the start
  // Futures Breakout (added in v6): best survivor of the 20,070-strategy search; rules locked Sat Oct 17 2026, 2:18 AM Toronto
  const FUTB_START = START + 7 * 3600; // Sat Oct 17 2026, 3:00 AM Toronto
  const FUTB_LOCKED = Date.UTC(2026, 9, 17, 6, 18, 0) / 1000;
  // Combo 50/50 (added in v7): Trend Swing + Futures Breakout on two independent halves; rules locked Sat Oct 17 2026, 3:18 AM Toronto
  const COMBO_START = START + DAY; // Sat Oct 17 2026, 8:00 PM Toronto (next daily close)
  const COMBO_LOCKED = Date.UTC(2026, 9, 17, 7, 18, 0) / 1000;
  // Meme Coin Trader (added in v8): 30-day momentum rotation across Coinbase meme coins; rules locked Mon Oct 19 2026, 5:16 PM Toronto
  const MEME_START = Date.UTC(2026, 9, 20, 0, 0, 0) / 1000; // Mon Oct 19 2026, 8:00 PM Toronto (next daily close)
  const MEME_LOCKED = Date.UTC(2026, 9, 19, 21, 16, 0) / 1000;
  const MEME_HIST = MEME_START - 100 * DAY;
  const MEME_COINS = ['DOGE', 'SHIB', 'PEPE', 'BONK', 'FLOKI', 'WIF', 'MOG', 'MOODENG', 'PNUT', 'POPCAT', 'FARTCOIN', 'TRUMP', 'PENGU', 'SPX', 'TURBO', 'GIGA', 'DEGEN', 'TOSHI', 'DOGINME', 'TROLL', 'USELESS', 'KEYCAT'];
  const MEME_P = { fam: 'rot', L: 30, k: 1, buf: 2, trend: 20, btcF: 50, cad: 'd' };
  const MEME_CFG = { slip: 0.0015, liqMin: 1e6 };
  const MEME_REFRESH = 300; // seconds between full meme candle refreshes (the held coin refreshes every 30 s)
  // Solana Meme Trader (added in v9): 10 paper SOL, always in the Solana meme coin with the best 7-day gain measured in SOL;
  // rules locked Mon Oct 19 2026, 5:40 PM Toronto; first trade at its start, then a check every daily close
  const SOLB_START = Date.UTC(2026, 9, 19, 22, 0, 0) / 1000; // Mon Oct 19 2026, 6:00 PM Toronto
  const SOLB_LOCKED = Date.UTC(2026, 9, 19, 21, 40, 0) / 1000;
  const SOLB_HIST = SOLB_START - 10 * 86400; // 240 hours: the 7-day ranking needs 168 finished hours before the start
  const SOLB_COINS = ['BONK', 'WIF', 'POPCAT', 'PNUT', 'MOODENG', 'FARTCOIN', 'TRUMP', 'GIGA', 'USELESS', 'TROLL', 'PENGU'];
  const SOLB_P = { fam: 'rot', L: 168, k: 1, buf: 2, trend: 0, every: 24, anyGain: true };
  const SOLB_CFG = { startEq: 10, slip: 0.0025, flatFee: 0.0025, liqMin: 50, minTrade: 0.01, decideAtStart: true };
  const REFRESH_MS = 30000;
  const SETTLE = 15; // a candle counts as final 15 s after it closes
  const FEES = {
    kraken: { kind: 'kraken', label: 'Kraken Pro tiers' },
    f20: { kind: 'flat', maker: 0.002, taker: 0.002, label: '0.20% flat' },
    f10: { kind: 'flat', maker: 0.001, taker: 0.001, label: '0.10% flat' },
  };
  const BOTS = [
    { id: 'combo', name: 'Combo 50/50', role: 'Swing + Futures', color: 'var(--c-combo)' },
    { id: 'swing', name: 'Trend Swing', role: 'Main bot', color: 'var(--c-swing)' },
    { id: 'futb', name: 'Futures Breakout', role: 'Futures 1.5x', color: 'var(--c-futb)' },
    { id: 'meme', name: 'Meme Coin Trader', role: 'Meme coins', color: 'var(--c-meme)', meme: true },
    { id: 'mtf', name: '1h/15m Trader', role: 'Your design', color: 'var(--c-mtf)' },
    { id: 'half', name: 'Half-Size Swing', role: 'Lower risk', color: 'var(--c-half)' },
    { id: 'lev', name: 'Leveraged Swing', role: 'High risk', color: 'var(--c-lev)' },
    { id: 'multi', name: 'Multi-Speed Trend', role: 'New idea', color: 'var(--c-multi)' },
    { id: 'day', name: 'Breakout Day Trader', role: 'Experiment', color: 'var(--c-day)' },
    { id: 'hold', name: 'Buy & Hold', role: 'Benchmark', color: 'var(--c-hold)' },
    { id: 'old', name: 'Old Bot Replica', role: 'Control', color: 'var(--c-old)' },
    { id: 'turtle', name: 'Turtle Breakout', role: 'Lab', color: 'var(--l1)', lab: true },
    { id: 'mom4w', name: '4-Week Momentum', role: 'Lab', color: 'var(--l2)', lab: true },
    { id: 'mom12m', name: '12-Month Momentum', role: 'Lab', color: 'var(--l3)', lab: true },
    { id: 'golden', name: 'Golden Cross', role: 'Lab', color: 'var(--l4)', lab: true },
    { id: 'weekly', name: 'Weekly Trend', role: 'Lab', color: 'var(--l5)', lab: true },
    { id: 'chand', name: 'Chandelier Trend', role: 'Lab', color: 'var(--l6)', lab: true },
    { id: 'rsi2', name: 'RSI-2 Dip Buyer', role: 'Lab', color: 'var(--l7)', lab: true },
    { id: 'boll', name: 'Bollinger Bounce', role: 'Lab', color: 'var(--l8)', lab: true },
    { id: 'volman', name: 'Volatility-Managed Hold', role: 'Lab', color: 'var(--l9)', lab: true },
    { id: 'committee', name: 'Committee Vote', role: 'Lab', color: 'var(--l10)', lab: true },
  ];
  const CORE = BOTS.filter(b => !b.lab), LABS = BOTS.filter(b => b.lab);
  const LAB_DESC = {
    turtle: ['new 20-day high'], mom4w: ['above its price 28 days ago'], mom12m: ['above its price 365 days ago'],
    golden: ['50-day average above the 200-day'], weekly: ['Sunday close above the 50-day average'], chand: ['new 50-day high'],
    rsi2: ['2-day RSI under 10 while above the 200-day average'], boll: ['2 standard deviations under its 20-day average while above the 200-day'],
    volman: ['30-day volatility under 40%', '30-day volatility under 55%', '30-day volatility under 70%', '30-day volatility under 85%'],
    committee: ['50-day trend', 'Turtle breakout', '4-week momentum', 'golden cross'],
  };
  const LAB_IDEA = {
    turtle: 'Buys a close above the highest high of the prior 20 days. Sells a close below the lowest low of the prior 10 days.',
    mom4w: 'Holds while BTC closes above where it was 28 days ago.',
    mom12m: 'Holds while BTC closes above where it was 365 days ago.',
    golden: 'Holds while the 50-day average is above the 200-day average.',
    weekly: 'The 50-day rule, but it only checks at the Sunday close and holds its decision all week.',
    chand: 'Buys a close above the prior 50-day high. Sells if price closes 3 \u00d7 ATR(22) below its highest close since buying.',
    rsi2: 'Buys when the 2-day RSI drops under 10 while BTC is above its 200-day average. Sells on a close above the 5-day average.',
    boll: 'Buys a close 2 standard deviations below the 20-day average while above the 200-day average. Sells on a close back above the 20-day average.',
    volman: 'Four quarters of the money. Each quarter holds BTC only while 30-day volatility is under its limit: 40%, 55%, 70% or 85%.',
    committee: 'Four quarters, each following a different rule: 50-day trend, Turtle breakout, 4-week momentum and golden cross.',
  };
  const BOT = Object.fromEntries(BOTS.map(b => [b.id, b]));
  const REASON = {
    stop: 'Stop-loss', target: 'Profit target', time: '4-hour time limit', session: 'End of day (8 PM ET)',
    signal: 'Closed below its average', end: 'Still open', liquidated: 'Liquidated: borrowed money wiped out the margin',
  };
  const reasonOf = (id, t) => id === 'meme' ? (t.whyOut ? t.whyOut.charAt(0).toUpperCase() + t.whyOut.slice(1) : 'Rule exit') : (id === 'mtf' && t.reason === 'signal') ? '1-hour trend broke' : (REASON[t.reason] || t.reason);
  const PART = { swing: 'Swing half (spot)', futb: 'Futures half (1.5x)' };
  const partOf = (id, t) => id === 'combo' && t.part ? PART[t.part] : '';
  const SLEEVE_BOTS = new Set(['swing', 'mtf', 'half', 'lev', 'multi', 'turtle', 'mom4w', 'mom12m', 'golden', 'weekly', 'chand', 'rsi2', 'boll', 'volman', 'committee']);
  const SPEEDS = [20, 50, 100, 200];
  const LEV = { target: 1.0, cap: 3, borrow: 0.15 };

  // ======================================================================= state
  const S = {
    src: 'coinbase', m5: [], d1: [], h1: [], price: NaN, open24: NaN, priceT: 0, offset: 0,
    lastOk: 0, err: '', fee: 'kraken', tab: 'sniper', win: '12h', filter: 'all', out: null, tradeSig: '', eqSet: 'core', pxBot: 'all',
    meme: {}, memeT: 0, memeHeld: [], memeErr: '',
    solb: {}, solbT: 0, solbHeld: [], solbErr: '',
  };
  const $ = id => document.getElementById(id);
  const nowSec = () => Math.floor(Date.now() / 1000 + S.offset);

  // ======================================================================= formatting
  const nf2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const nf0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
  const MINUS = '−';
  const usd = v => (v < 0 ? MINUS : '') + '$' + nf2.format(Math.abs(v));
  const usd0 = v => (v < 0 ? MINUS : '') + '$' + nf0.format(Math.abs(v));
  const susd = v => (v > 0.004 ? '+' : v < -0.004 ? MINUS : '') + '$' + nf2.format(Math.abs(v));
  const spct = (v, d = 2) => (v > 0.00005 ? '+' : v < -0.00005 ? MINUS : '') + Math.abs(v * 100).toFixed(d) + '%';
  const pct = (v, d = 1) => (v < 0 ? MINUS : '') + Math.abs(v * 100).toFixed(d) + '%';
  const btc = v => v.toFixed(v < 0.1 ? 5 : 4);
  // meme coin prices run from $2 down to $0.0000001: enough decimals to show 4 significant digits, no exponents
  const pxF = v => { if (!isFinite(v)) return '–'; if (v >= 1000) return nf2.format(v); if (v >= 1) return v.toFixed(4); const dec = Math.min(12, Math.max(4, Math.ceil(-Math.log10(v)) + 3)); return v.toFixed(dec).replace(/0+$/, '').replace(/\.$/, ''); };
  const qtyF = v => v >= 1e9 ? (v / 1e9).toFixed(2) + 'B' : v >= 1e6 ? (v / 1e6).toFixed(2) + 'M' : v >= 1e3 ? nf0.format(v) : v.toFixed(2);
  const cls = v => (v > 0.004 ? 'up' : v < -0.004 ? 'down' : 'flat');
  const dtf = o => new Intl.DateTimeFormat('en-US', { timeZone: TZ, ...o });
  const F = {
    dt: dtf({ month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }),
    t: dtf({ hour: 'numeric', minute: '2-digit' }),
    ts: dtf({ hour: 'numeric', minute: '2-digit', second: '2-digit' }),
    day: dtf({ weekday: 'short', month: 'short', day: 'numeric' }),
    md: dtf({ month: 'short', day: 'numeric' }),
    full: dtf({ weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }),
    hms: dtf({ hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }),
  };
  const keyFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
  const fdt = t => F.dt.format(new Date(t * 1000));
  const ft = t => F.t.format(new Date(t * 1000));
  const etKey = t => keyFmt.format(new Date(t * 1000));
  const etSecOfDay = t => { const [h, m, s] = F.hms.format(new Date(t * 1000)).split(':').map(Number); return h * 3600 + m * 60 + s; };
  const etMidnight = t => t - etSecOfDay(t);
  const dur = s => {
    s = Math.max(0, Math.floor(s));
    const d = Math.floor(s / DAY), h = Math.floor((s % DAY) / 3600), m = Math.floor((s % 3600) / 60);
    if (d) return `${d}d ${h}h`;
    if (h) return `${h}h ${m}m`;
    if (m) return `${m}m ${s % 60}s`;
    return `${s}s`;
  };
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const sum = a => a.reduce((x, y) => x + y, 0);

  // ======================================================================= storage (optional)
  const store = {
    get(k) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage unavailable or full */ } },
  };

  // ======================================================================= data sources
  async function getJSON(url) {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status} from ${new URL(url).host}`);
    return r.json();
  }
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const iso = t => new Date(t * 1000).toISOString();

  const SOURCES = {
    coinbase: {
      name: 'Coinbase',
      async candles(gran, from, to, product = 'BTC-USD', withVol = false) {
        const rows = new Map();
        const span = 300 * gran;
        for (let s = from; s < to; s += span) {
          const e = Math.min(to, s + span) - gran;
          const j = await getJSON(`${CB}/products/${product}/candles?granularity=${gran}&start=${iso(s)}&end=${iso(Math.max(s, e))}`);
          if (!Array.isArray(j)) throw new Error('Unexpected candle data from Coinbase');
          for (const k of j) rows.set(k[0], withVol ? [k[0], +k[3], +k[2], +k[1], +k[4], +k[5]] : [k[0], +k[3], +k[2], +k[1], +k[4]]);
          if (s + span < to) await sleep(140);
        }
        return [...rows.values()];
      },
      async ticker() {
        const [t, st] = await Promise.all([getJSON(`${CB}/products/BTC-USD/ticker`), getJSON(`${CB}/products/BTC-USD/stats`)]);
        return { price: +t.price, time: Date.parse(t.time) / 1000, open24: +st.open };
      },
      async time() { const j = await getJSON(`${CB}/time`); return +j.epoch; },
    },
    bitstamp: {
      name: 'Bitstamp',
      async candles(gran, from, to) {
        const rows = new Map();
        const span = 1000 * gran;
        for (let s = from; s < to; s += span) {
          const e = Math.min(to, s + span) - gran;
          const j = await getJSON(`${BS}/ohlc/btcusd/?step=${gran}&limit=1000&start=${s}&end=${Math.max(s, e)}`);
          for (const k of (j.data && j.data.ohlc) || []) rows.set(+k.timestamp, [+k.timestamp, +k.open, +k.high, +k.low, +k.close]);
          if (s + span < to) await sleep(200);
        }
        return [...rows.values()];
      },
      async ticker() {
        const j = await getJSON(`${BS}/ticker/btcusd/`);
        return { price: +j.last, time: +j.timestamp, open24: +(j.open_24 || j.open) };
      },
      async time() { return null; },
    },
  };

  // merge cached + fresh candles, keep a regular grid, cache completed candles only
  async function loadSeries(gran, from) {
    const src = SOURCES[S.src];
    const key = `bpl1_${S.src}_${gran}`;
    const now = nowSec();
    const cached = store.get(key);
    let rows = cached && cached.from <= from && Array.isArray(cached.rows) ? cached.rows.filter(r => r[0] >= from) : [];
    const lastT = rows.length ? rows[rows.length - 1][0] : null;
    const fetchFrom = lastT !== null ? Math.max(from, lastT - 2 * gran) : from;
    const fresh = await src.candles(gran, fetchFrom, Math.floor(now / gran) * gran + gran);
    const m = new Map(rows.map(r => [r[0], r]));
    for (const r of fresh) if (r[0] >= from) m.set(r[0], r);
    let all = [...m.values()].sort((a, b) => a[0] - b[0]);
    // fill missing 5-minute candles (no trades) with a flat candle so the grid stays regular
    if (gran === M5 && all.length) {
      const filled = [all[0]];
      for (let i = 1; i < all.length; i++) {
        let prev = filled[filled.length - 1];
        while (all[i][0] - prev[0] > gran) { const c = prev[4]; prev = [prev[0] + gran, c, c, c, c]; filled.push(prev); }
        filled.push(all[i]);
      }
      all = filled;
    }
    store.set(key, { from, rows: all.filter(r => r[0] + gran + SETTLE <= now) });
    return all;
  }

  // meme coins (Coinbase only): daily candles with volume, cached in the browser. All 22 coins refresh every 5 minutes and at each
  // new UTC day; in between only the coin the Meme Coin Trader holds (its live price) is refreshed.
  async function loadMemeCoin(sym, now) {
    const key = `bpl1_meme_${sym}`;
    const cached = store.get(key);
    const rows = cached && cached.from <= MEME_HIST && Array.isArray(cached.rows) ? cached.rows.filter(r => r[0] >= MEME_HIST) : [];
    const lastT = rows.length ? rows[rows.length - 1][0] : null;
    const fetchFrom = lastT !== null ? Math.max(MEME_HIST, lastT - 2 * DAY) : MEME_HIST;
    const fresh = await SOURCES.coinbase.candles(DAY, fetchFrom, Math.floor(now / DAY) * DAY + DAY, `${sym}-USD`, true);
    const m = new Map(rows.map(r => [r[0], r]));
    for (const r of fresh) if (r[0] >= MEME_HIST) m.set(r[0], r);
    const all = [...m.values()].sort((a, b) => a[0] - b[0]);
    store.set(key, { from: MEME_HIST, rows: all.filter(r => r[0] + DAY + SETTLE <= now) });
    return all;
  }
  async function refreshMeme(now) {
    if (S.src !== 'coinbase') return;
    const dayOf = t => Math.floor((t - SETTLE) / DAY);
    const full = !S.memeT || now - S.memeT >= MEME_REFRESH || dayOf(S.memeT) !== dayOf(now);
    const queue = (full ? MEME_COINS : S.memeHeld || []).slice();
    if (!queue.length) return;
    const fails = [];
    const work = async () => {
      while (queue.length) {
        const sym = queue.shift();
        try { S.meme[sym] = await loadMemeCoin(sym, now); } catch (e) { fails.push(sym); }
      }
    };
    await Promise.all([work(), work(), work()]);
    S.memeErr = fails.length ? `Couldn't update ${fails.join(', ')} from Coinbase. Retrying shortly.` : '';
    if (full && !fails.length) S.memeT = now;
  }

  // Solana meme coins + SOL: hourly candles with volume from SOLB_HIST, cached in the browser. Everything refreshes every
  // 5 minutes and at each new hour; in between only SOL and the coin the Solana Meme Trader holds.
  async function loadSolbCoin(sym, now) {
    const key = `bpl1_solb_${sym}`;
    const cached = store.get(key);
    const rows = cached && cached.from <= SOLB_HIST && Array.isArray(cached.rows) ? cached.rows.filter(r => r[0] >= SOLB_HIST) : [];
    const lastT = rows.length ? rows[rows.length - 1][0] : null;
    const fetchFrom = lastT !== null ? Math.max(SOLB_HIST, lastT - 2 * H1) : SOLB_HIST;
    const fresh = await SOURCES.coinbase.candles(H1, fetchFrom, Math.floor(now / H1) * H1 + H1, `${sym}-USD`, true);
    const m = new Map(rows.map(r => [r[0], r]));
    for (const r of fresh) if (r[0] >= SOLB_HIST) m.set(r[0], r);
    const all = [...m.values()].sort((a, b) => a[0] - b[0]);
    store.set(key, { from: SOLB_HIST, rows: all.filter(r => r[0] + H1 + SETTLE <= now) });
    return all;
  }
  async function refreshSolb(now) {
    if (S.src !== 'coinbase') return;
    const hourOf = t => Math.floor((t - SETTLE) / H1);
    const full = !S.solbT || now - S.solbT >= MEME_REFRESH || hourOf(S.solbT) !== hourOf(now);
    const queue = ['SOL', ...(full ? SOLB_COINS : S.solbHeld || [])];
    const fails = [];
    const work = async () => {
      while (queue.length) {
        const sym = queue.shift();
        try { S.solb[sym] = await loadSolbCoin(sym, now); } catch (e) { fails.push(sym); }
      }
    };
    await Promise.all([work(), work(), work()]);
    S.solbErr = fails.length ? `Couldn't update ${fails.join(', ')} from Coinbase. Retrying shortly.` : '';
    if (full && !fails.length) S.solbT = now;
  }

  let busy = false;
  async function refresh() {
    if (busy) return;
    busy = true;
    try { await doRefresh(); } finally { busy = false; }
  }
  async function doRefresh() {
    try {
      if (!S.offset) {
        try { const st = await SOURCES[S.src].time(); if (st) S.offset = st - Date.now() / 1000; } catch (e) { /* use local clock */ }
      }
      const tk = await SOURCES[S.src].ticker();
      S.price = tk.price; S.open24 = tk.open24; S.priceT = tk.time;
      S.d1 = await loadSeries(DAY, HIST_1D);
      S.m5 = await loadSeries(M5, HIST_5M);
      S.h1 = await loadSeries(H1, HIST_1H);
      S.lastOk = nowSec(); S.err = '';
      if (S.m5.length && S.d1.length && !Object.keys(S.meme).length) { compute(); render(); renderStatus(); } // show the BTC bots before the first meme load
      await refreshMeme(nowSec());
      await refreshSolb(nowSec());
    } catch (e) {
      if (S.src === 'coinbase' && !S.lastOk) {
        // a phone's first request can fail while its network wakes up: retry Coinbase twice before switching sources
        S.cbFails = (S.cbFails || 0) + 1;
        if (S.cbFails < 3) { await sleep(2000); return doRefresh(); }
        S.src = 'bitstamp';
        S.err = '';
        return doRefresh();
      }
      S.err = `Couldn't update prices (${e.message}). Showing the last data${S.lastOk ? ' from ' + F.ts.format(new Date(S.lastOk * 1000)) : ''}. Retrying in 30 seconds.`;
    }
    if (S.m5.length && S.d1.length) { compute(); render(); }
    renderStatus();
  }

  // ======================================================================= compute
  const arrays = rows => ({ t: rows.map(r => r[0]), o: rows.map(r => r[1]), h: rows.map(r => r[2]), l: rows.map(r => r[3]), c: rows.map(r => r[4]) });

  function compute() {
    const now = nowSec();
    const fee = FEES[S.fee];
    const m5c = S.m5.filter(r => r[0] + M5 + SETTLE <= now);
    const m5 = arrays(m5c);
    const dc = S.d1.filter(r => r[0] + DAY + SETTLE <= now);
    const lastDc = dc.length ? dc[dc.length - 1][0] : -Infinity;
    const dp = S.d1.filter(r => r[0] === lastDc + DAY && r[0] <= now); // the day still forming (or settling)
    const daily = arrays(dc);
    const dailyP = arrays(dc.concat(dp));
    const price = isFinite(S.price) ? S.price : (S.m5.length ? S.m5[S.m5.length - 1][4] : NaN);
    const started = now >= START + SETTLE;

    // indicator snapshot from completed daily candles
    const sma50 = ENGINE.sma(daily.c, 50), sma20 = ENGINE.sma(daily.c, 20);
    const L = daily.c.length - 1;
    // provisional values for the day still forming (used only for "what happens next" text)
    const todayStart = Math.floor(now / DAY) * DAY;
    const tdRows = S.m5.filter(r => r[0] >= todayStart);
    const prov = {
      close: price,
      high: Math.max(price, ...tdRows.map(r => r[2])),
      low: Math.min(price, ...tdRows.map(r => r[3])),
      sma50: (sum(daily.c.slice(-49)) + price) / 50,
      sma20: (sum(daily.c.slice(-19)) + price) / 20,
    };
    const dayRun = ENGINE.dayBreakout(m5, daily, 0.7, 20, 0.05);
    const volNow = ENGINE.rollingVol(daily.c, 30)[L];
    const labSig = ENGINE.labBots(daily);
    const labNow = Object.fromEntries(LABS.map(b => [b.id, labSig[b.id].map(x => x[1][L])]));
    const smaN = {}, provN = {};
    for (const n of SPEEDS) { smaN[n] = ENGINE.sma(daily.c, n)[L]; provN[n] = (sum(daily.c.slice(-(n - 1))) + price) / n; }
    // 1h/15m Trader inputs: finished 1-hour candles, and 15-minute candles built from the finished 5-minute ones
    const h1c = arrays(S.h1.filter(r => r[0] + H1 + SETTLE <= now));
    const m15 = ENGINE.bars15(m5);
    const mw = ENGINE.mtfWant(m15, h1c, MTF_START);
    const lastEnd = m5.t.length ? m5.t[m5.t.length - 1] + M5 : -Infinity;
    let kL = m15.t.length - 1;
    while (kL >= 0 && m15.t[kL] + M15 > lastEnd) kL--; // last COMPLETE 15-minute candle
    const hL = h1c.c.length - 1;
    const mtfNow = {
      w: mw, rsi: kL >= 0 ? mw.rsi[kL] : NaN, rsiT: kL >= 0 ? m15.t[kL] + M15 : NaN,
      hClose: hL >= 0 ? h1c.c[hL] : NaN, hT: hL >= 0 ? h1c.t[hL] : NaN, hAvg: hL >= 0 ? ENGINE.sma(h1c.c, ENGINE.MTF.smaN)[hL] : NaN,
      started: now >= MTF_START + SETTLE,
    };
    // Futures Breakout plan for the current UTC day (open, previous day's range, trigger), from finished candles
    const futPlan = m5.t.length ? ENGINE.futBreakout(m5, { i0: m5.t.length, startEq: START_EQ }).plan : null;
    const o = {
      now, price, started, fee, m5c, daily, snap: { close: daily.c[L], t: daily.t[L], sma50: sma50[L], sma20: sma20[L] },
      prov, planToday: dayRun.plan.get(todayStart), todayStart, res: null, acc: null, err: '',
      volNow, levNow: Math.min(LEV.cap, LEV.target / volNow), smaN, provN, labNow, mtf: mtfNow, futPlan,
      memeData: memeCompute(now, dailyP),
      solbData: solbCompute(now),
    };
    S.memeHeld = o.memeData.res ? o.memeData.res.opens.map(op => op.sym) : [];
    S.solbHeld = o.solbData.res ? [...new Set([...o.solbData.res.opens.map(op => op.sym), ...o.solbData.res.pendBuy, ...(o.solbData.resF ? o.solbData.resF.pendBuy : [])])] : [];
    o.solbAcc = solbAcc(o.solbData, now);
    if (!started && now >= START) o.err = 'Starting: waiting for the first candles after the start to settle.';
    if (started) {
      const i5 = m5.t.indexOf(START - M5);
      const iD = dailyP.t.indexOf(START - DAY);
      if (i5 < 0 || iD < 0) {
        o.err = 'Waiting for the first candle after the start.';
      } else {
        const partial = dp.length > 0;
        const SL = cfg => ENGINE.sleeves(m5, daily, { ...cfg, feeModel: fee, startEq: START_EQ, i0: i5, K: 48 });
        o.res = {
          swing: SL({ lens: [50], weights: [1], allocs: [1] }),
          half: SL({ lens: [50], weights: [1], allocs: [0.5] }),
          lev: SL({ lens: [50], weights: [1], allocs: [{ target: LEV.target, cap: LEV.cap }], borrow: [LEV.borrow] }),
          multi: SL({ lens: SPEEDS, weights: [0.25, 0.25, 0.25, 0.25], allocs: [1, 1, 1, 1] }),
          ...Object.fromEntries(LABS.map(b => [b.id, SL({ wants: labSig[b.id].map(x => x[1]), weights: labSig[b.id].map(x => x[0]), allocs: labSig[b.id].map(() => 1), desc: LAB_DESC[b.id] })])),
          day: ENGINE.simulate(m5, dayRun.sig, { feeModel: fee, startEq: START_EQ, i0: i5 }),
          hold: ENGINE.simulate(dailyP, ENGINE.buyHold(dailyP.c.length, iD).sig, { feeModel: fee, startEq: START_EQ, i0: iD, partialLast: partial }),
          old: ENGINE.simulate(m5, ENGINE.oldBot(m5).sig, { feeModel: fee, startEq: START_EQ, i0: i5 }),
        };
        // 1h/15m Trader: same limit-first engine, decisions at every 15-minute close from its own start
        const iM = m5.t.indexOf(MTF_START - M5);
        const mtfLive = mtfNow.started && iM >= 0;
        o.res.mtf = mtfLive
          ? ENGINE.sleeves(m5, daily, { wants: [mw.want], wantT: mw.t, step: ENGINE.MTF.step, weights: [1], allocs: [1], feeModel: fee, startEq: START_EQ, i0: iM, K: ENGINE.MTF.K, noteFn: mtfNote(mw) })
          : { trades: [], equity: [], inMkt: [], cash: START_EQ, opens: [], pendings: [], volT: [], volN: [], i0: m5c.length, open: null, pending: null };
        // Futures Breakout: futures account at 1.5x, long only, from its own start
        const iF = m5.t.indexOf(FUTB_START - M5);
        const futLive = now >= FUTB_START + SETTLE && iF >= 0;
        o.res.futb = futLive
          ? ENGINE.futBreakout(m5, { i0: iF, startEq: START_EQ, noteFn: futNote })
          : { trades: [], equity: [], inMkt: [], cash: START_EQ, opens: [], pendings: [], volT: [], volN: [], i0: m5c.length, open: null, pending: null, futures: true, takerFee: ENGINE.FUTB.taker, plan: null };
        // Combo 50/50: two independent halves ($4,000 Trend Swing spot + $4,000 Futures Breakout), from its own start
        const iC = m5.t.indexOf(COMBO_START - M5);
        const comboLive = now >= COMBO_START + SETTLE && iC >= 0;
        o.res.combo = comboLive
          ? ENGINE.combo(m5, daily, { feeModel: fee, startEq: START_EQ, i0: iC, futNoteFn: futNote })
          : { trades: [], equity: [], inMkt: [], cash: START_EQ, opens: [], pendings: [], volT: [], volN: [], i0: m5c.length, open: null, pending: null, mixed: true, futTaker: ENGINE.FUTB.taker, parts: null };
        const startOf = { mtf: MTF_START, futb: FUTB_START, combo: COMBO_START };
        o.acc = {};
        for (const b of BOTS) if (!b.meme) o.acc[b.id] = summarize(o.res[b.id], o, m5c, startOf[b.id] || START);
        o.acc.meme = memeAcc(o.memeData, now);
        o.acc.mtf.notStarted = !mtfLive;
        o.acc.futb.notStarted = !futLive;
        o.acc.combo.notStarted = !comboLive;
        if (comboLive) o.acc.combo.parts = { swing: summarize(o.res.combo.parts.swing, o, m5c, COMBO_START, START_EQ / 2), futb: summarize(o.res.combo.parts.futb, o, m5c, COMBO_START, START_EQ / 2) };
      }
    }
    S.out = o;
  }

  function mtfNote(mw) {
    const idx = new Map(mw.t.map((t, k) => [t, k]));
    return (side, s, key, px) => {
      const k = idx.get(key);
      if (k == null) return '';
      const hc = mw.hClose[k], ha = mw.hAvg[k], ht = mw.hT[k];
      const hour = `${ft(ht)} to ${ft(ht + H1)} ET candle`;
      return side === 'buy'
        ? `The 15-minute candle closing at ${ft(key + M15)} ET ended at $${nf2.format(px)} with RSI(14) ${mw.rsi[k].toFixed(1)}, under 35. The last finished 1-hour close was $${nf0.format(hc)} (${hour}), ${pct(hc / ha - 1, 2)} above the 200-hour average $${nf0.format(ha)}, past the 1% buy line. Limit buy at $${nf2.format(px)} for 30 minutes, then market.`
        : `The last finished 1-hour close was $${nf0.format(hc)} (${hour}), ${pct(1 - hc / ha, 2)} below the 200-hour average $${nf0.format(ha)}, past the 1% sell line. Limit sell at the 15-minute close $${nf2.format(px)} for 30 minutes, then market.`;
    };
  }

  function futNote(tSig, close, open, rng, trg, stop) {
    return `The 5-minute candle closing at ${ft(tSig + M5)} ET ended at $${nf2.format(close)}, above today's trigger $${nf2.format(trg)} (today's open $${nf2.format(open)} + 0.6 × yesterday's range $${nf0.format(rng)}). Bought BTC futures at the next open with 1.5x leverage. Stop $${nf2.format(stop)}, half of yesterday's range under that close. Sells at the end of the UTC day (${ft((Math.floor(tSig / DAY) + 1) * DAY)} ET) if the stop doesn't hit first.`;
  }

  function summarize(res, o, m5c, st = START, eq0 = START_EQ) {
    const { now, price, fee } = o;
    const closed = res.trades;
    const opens = res.opens || (res.open ? [res.open] : []);
    const realized = sum(closed.map(t => t.net));
    const gross = sum(closed.map(t => t.gross));
    let fees = sum(closed.map(t => t.fees));
    let closeVal = 0, posVal = 0, estFee = 0;
    const ti = ENGINE.tierInfo(res.volT, res.volN, now);
    const taker = res.futures ? res.takerFee : fee.kind === 'flat' ? fee.taker : ti.taker;
    const FB = ENGINE.FUTB;
    const openRows = opens.map(op => {
      if (res.futures || op.futures) {
        // futures: cash stays as margin; closing now = the price move minus both fees and funding so far
        const bars = Math.max(1, Math.round((now - op.entryT) / M5));
        const u = op.notional * (price * (1 - FB.slipM) / op.entryPx - 1 - 2 * FB.taker - FB.fund * bars);
        posVal += op.qty * price; estFee += op.notional * FB.taker; closeVal += u; fees += op.entryFee;
        return { ...op, unreal: u };
      }
      const pv = op.qty * price, sale = pv * (1 - ENGINE.SLIP_TAKER), f = sale * taker;
      posVal += pv; estFee += f; closeVal += sale - f; fees += op.entryFee;
      return { ...op, unreal: sale - f - op.notional - op.entryFee };
    });
    const balance = res.cash + closeVal;
    const unreal = opens.length ? balance - eq0 - realized : 0;
    const wins = closed.filter(t => t.net > 0), losses = closed.filter(t => t.net <= 0);
    const lossSum = -sum(losses.map(t => t.net));
    // equity curve on the 5-minute grid (mark-to-market)
    let inMkt = 0, n = 0, peak = eq0, mdd = 0;
    const curve = [[st, eq0]];
    const add = (tEnd, eq, held) => {
      curve.push([tEnd, eq]);
      n++; if (held) inMkt++;
      if (eq > peak) peak = eq;
      mdd = Math.min(mdd, eq / peak - 1);
    };
    if (res.inMkt) {
      // sleeve engine: its own per-candle equity (includes borrowing interest and liquidations)
      for (let j = res.i0; j < m5c.length; j++) if (m5c[j][0] >= st) add(m5c[j][0] + M5, res.equity[j - res.i0], res.inMkt[j - res.i0]);
    } else {
      const ev = [];
      for (const t of closed) { ev.push([t.entryT, -(t.notional + t.entryFee), t.qty]); ev.push([t.exitT, t.qty * t.exitPx - t.exitFee, -t.qty]); }
      for (const op of opens) ev.push([op.entryT, -(op.notional + op.entryFee), op.qty]);
      ev.sort((a, b) => a[0] - b[0]);
      let cash = eq0, qty = 0, k = 0;
      for (const r of m5c) {
        if (r[0] < st) continue;
        while (k < ev.length && ev[k][0] <= r[0]) { cash += ev[k][1]; qty += ev[k][2]; k++; }
        add(r[0] + M5, cash + qty * r[4], qty > 1e-12);
      }
    }
    const liveEq = res.cash + posVal;
    if (now > curve[curve.length - 1][0]) curve.push([now, liveEq]);
    if (liveEq > peak) peak = liveEq;
    mdd = Math.min(mdd, liveEq / peak - 1);
    return {
      balance, pnl: balance - eq0, realized, unreal, gross, fees, trades: closed, opens: openRows, open: openRows[0] || null,
      pending: res.pending, pendings: res.pendings || (res.pending ? [res.pending] : []),
      wins: wins.length, losses: losses.length, winRate: closed.length ? wins.length / closed.length : NaN,
      avgWin: wins.length ? sum(wins.map(t => t.net)) / wins.length : NaN,
      avgLoss: losses.length ? -lossSum / losses.length : NaN,
      pf: lossSum > 0 ? sum(wins.map(t => t.net)) / lossSum : (wins.length ? Infinity : NaN),
      mdd, exposure: n ? inMkt / n : 0, curve, tier: ti, taker, posVal, estFee,
    };
  }

  // ======================================================================= Meme Coin Trader
  // Same engine as research/meme_engine.js: decisions at each UTC daily close on finished candles, fills at the next day's open.
  function memeCompute(now, dP) {
    const syms = MEME_COINS.filter(s => S.meme[s] && S.meme[s].length);
    if (syms.length < MEME_COINS.length / 2 || !dP.t.length) return { ready: false, res: null };
    const U = syms.map(sym => {
      const rows = S.meme[sym].filter(r => r[0] <= now);
      return { sym, t: rows.map(r => r[0]), o: rows.map(r => r[1]), h: rows.map(r => r[2]), l: rows.map(r => r[3]), c: rows.map(r => r[4]), v: rows.map(r => r[5]) };
    });
    const G = MEME.grid(U, { sym: 'BTC', t: dP.t, o: dP.o, h: dP.h, l: dP.l, c: dP.c });
    const dLast = G.n - 1, forming = G.T[dLast] + DAY > now, dF = forming ? dLast - 1 : dLast;
    const board = memeBoard(G, dF);
    const d0 = Math.round((MEME_START - DAY - G.t0) / DAY);
    const live = now >= MEME_START + SETTLE && d0 >= 0 && d0 <= dLast;
    const res = live ? MEME.sim(G, MEME_P, { d0, d1: dLast, startEq: START_EQ, slip: MEME_CFG.slip, liqMin: MEME_CFG.liqMin, live: forming, noteFn: memeNote(G) }) : null;
    return { ready: true, G, board, res, live, forming, dF, missing: MEME_COINS.filter(s => !syms.includes(s)) };
  }
  function memeBoard(G, d) {
    const P = MEME_P, rows = [];
    const btcAvg = MEME.sma(G.B, P.btcF)[d], btcClose = G.B.c[d];
    for (const x of G.C) {
      const c = x.c[d];
      if (!(c > 0)) continue;
      const elig = x.age[d] >= Math.max(30, P.L, P.trend) && x.dv[d] >= MEME_CFG.liqMin;
      const gain = c / x.c[d - P.L] - 1, avg = MEME.sma(x, P.trend)[d];
      rows.push({ sym: x.sym, c, gain, avg, above: c > avg, dv: x.dv[d], elig, cand: elig && gain > 0 && c > avg });
    }
    const g = r => isFinite(r.gain) ? r.gain : -9;
    rows.sort((a, b) => (b.cand - a.cand) || (g(b) - g(a)));
    return { d, t: G.T[d], btcClose, btcAvg, btcOk: btcClose > btcAvg, rows, nElig: rows.filter(r => r.elig).length };
  }
  function memeNote(G) {
    return (P, sym, d, m) => {
      const x = G.C.find(c => c.sym === sym);
      return `At the ${F.md.format(new Date((G.T[d] + DAY) * 1000))} daily close (${ft(G.T[d] + DAY)} ET) ${sym} had the best ${P.L}-day gain of the eligible meme coins: +${(m * 100).toFixed(1)}%, closing at $${pxF(x.c[d])}, above its ${P.trend}-day average $${pxF(MEME.sma(x, P.trend)[d])}. BTC closed at $${nf0.format(G.B.c[d])}, above its ${P.btcF}-day average $${nf0.format(MEME.sma(G.B, P.btcF)[d])}. Bought at the next daily open with all the cash (market order).`;
    };
  }
  function memeAcc(md, now) {
    const ti0 = ENGINE.tierInfo([], [], now);
    if (!md || !md.live || !md.res) {
      return { notStarted: true, balance: START_EQ, pnl: 0, realized: 0, unreal: 0, gross: 0, fees: 0, trades: [], opens: [], open: null, pending: null, pendings: [],
        wins: 0, losses: 0, winRate: NaN, avgWin: NaN, avgLoss: NaN, pf: NaN, mdd: 0, exposure: 0, curve: [[MEME_START, START_EQ]], tier: ti0, taker: ti0.taker, posVal: 0, estFee: 0 };
    }
    const r = md.res, G = md.G, ti = ENGINE.tierInfo(r.volT, r.volN, now), fr = ti.taker;
    const trades = r.trades.map(t => ({ ...t, reason: 'signal' }));
    let closeVal = 0, posVal = 0, estFee = 0, fees = sum(trades.map(t => t.fees));
    const opens = r.opens.map(op => {
      const pv = op.qty * op.last, sale = pv * (1 - MEME_CFG.slip), f = sale * fr;
      posVal += pv; closeVal += sale - f; estFee += f; fees += op.entryFee;
      return { ...op, pxNow: op.last, unreal: sale - f - op.notional - op.entryFee };
    });
    const balance = r.cash + closeVal, realized = sum(trades.map(t => t.net));
    const wins = trades.filter(t => t.net > 0), losses = trades.filter(t => t.net <= 0), lossSum = -sum(losses.map(t => t.net));
    const curve = [[MEME_START, START_EQ]];
    let peak = START_EQ, mdd = 0;
    for (let i = 1; i < r.eq.length; i++) {
      const d = r.d0 + i;
      curve.push([md.forming && d === r.d1 ? now : G.T[d] + DAY, r.eq[i]]);
      if (r.eq[i] > peak) peak = r.eq[i];
      mdd = Math.min(mdd, r.eq[i] / peak - 1);
    }
    let held = 0;
    for (const t of trades) held += t.exitD - t.entryD;
    for (const op of opens) held += r.d1 - op.entryD + 1;
    const days = Math.max(1, r.d1 - r.d0);
    const pendings = r.pendBuy.map(sym => ({ side: 'buy', sym })).concat(r.pendSell.map(sym => ({ side: 'sell', sym })));
    return {
      balance, pnl: balance - START_EQ, realized, unreal: opens.length ? balance - START_EQ - realized : 0, gross: sum(trades.map(t => t.gross)), fees,
      trades, opens, open: opens[0] || null, pending: pendings[0] || null, pendings, wins: wins.length, losses: losses.length,
      winRate: trades.length ? wins.length / trades.length : NaN, avgWin: wins.length ? sum(wins.map(t => t.net)) / wins.length : NaN,
      avgLoss: losses.length ? -lossSum / losses.length : NaN, pf: lossSum > 0 ? sum(wins.map(t => t.net)) / lossSum : (wins.length ? Infinity : NaN),
      mdd, exposure: Math.min(1, held / days), curve, tier: ti, taker: fr, posVal, estFee,
    };
  }

  // ======================================================================= Solana Meme Trader (10 paper SOL)
  // Same engine (MEME.sim) on an hourly grid with every price turned into SOL; the account is kept in SOL.
  function solbFill(rows) { // missing hours (no trades on Coinbase) become flat zero-volume candles, as in the research
    const out = [];
    for (const r of rows) {
      while (out.length && r[0] - out[out.length - 1][0] > H1) { const p = out[out.length - 1], c = p[4]; out.push([p[0] + H1, c, c, c, c, 0]); }
      out.push(r);
    }
    return out;
  }
  function solbCompute(now) {
    const have = SOLB_COINS.filter(s => S.solb[s] && S.solb[s].length);
    if (!S.solb.SOL || !S.solb.SOL.length || have.length < SOLB_COINS.length / 2) return { ready: false, res: null };
    const solRows = solbFill(S.solb.SOL.filter(r => r[0] <= now)), sol = new Map(solRows.map(r => [r[0], r]));
    const U = have.map(sym => {
      const u = { sym, t: [], o: [], h: [], l: [], c: [], v: [], usd: [] };
      let last = null;
      for (const r of solbFill(S.solb[sym].filter(r => r[0] <= now))) {
        const s = sol.get(r[0]) || last;
        if (!s) continue;
        last = s;
        u.t.push(r[0]); u.o.push(r[1] / s[1]); u.c.push(r[4] / s[4]); u.h.push(r[2] / s[4]); u.l.push(r[3] / s[4]); u.v.push(r[5]); u.usd.push(r[4]);
      }
      return u;
    });
    const G = MEME.grid(U, null, H1);
    const dLast = G.n - 1, forming = G.T[dLast] + H1 > now, dF = forming ? dLast - 1 : dLast;
    const d0 = Math.round((SOLB_START - H1 - G.t0) / H1);
    const live = now >= SOLB_START + SETTLE && d0 >= 0 && d0 <= dLast;
    const solNow = solRows.length ? solRows[solRows.length - 1][4] : NaN;
    const solAt = t => { const r = sol.get(t); return r ? r[1] : NaN; }; // SOL price at an hour's open (for $ equivalents of fills)
    const usdNow = Object.fromEntries(U.map(u => [u.sym, u.usd[u.usd.length - 1]]));
    const res = live ? MEME.sim(G, SOLB_P, { d0, d1: dLast, ...SOLB_CFG, live: forming, noteFn: solbNote(G) }) : null;
    // Display only: a buy waits while its coin has no candle yet for the forming hour (no trade so far this hour).
    const resF = live && forming && dF >= d0 ? MEME.sim(G, SOLB_P, { d0, d1: dF, ...SOLB_CFG, live: false }) : null;
    return { ready: true, G, res, resF, live, forming, dF, board: solbBoard(G, dF), solNow, solAt, usdNow, missing: SOLB_COINS.filter(s => !have.includes(s)),
      solStart: solAt(SOLB_START) };
  }
  function solbBoard(G, d) {
    const rows = [];
    for (const x of G.C) {
      if (!(x.c[d] > 0)) continue;
      const elig = x.age[d] >= Math.max(30, SOLB_P.L) && x.dv[d] >= SOLB_CFG.liqMin;
      rows.push({ sym: x.sym, c: x.c[d], g7: x.c[d] / x.c[d - SOLB_P.L] - 1, g24: x.c[d] / x.c[d - 24] - 1, dv: x.dv[d], elig });
    }
    const g = r => isFinite(r.g7) ? r.g7 : -9;
    rows.sort((a, b) => (b.elig - a.elig) || (g(b) - g(a)));
    return { d, t: G.T[d], rows };
  }
  function solbNote(G) {
    return (P, sym, d, m) => `At ${ft(G.T[d] + H1)} ET (${F.md.format(new Date((G.T[d] + H1) * 1000))}) ${sym} had the best 7-day change against SOL of the eligible Solana meme coins: ${spct(m, 1)}${m < 0 ? ' (the least bad: this bot always holds a coin)' : ''}. Swapped all the SOL into it at the next hourly open, paying about 0.5% in swap fee and price impact.`;
  }
  function solbAcc(sd, now) {
    const blank = { notStarted: true, bal: SOLB_CFG.startEq, pnl: 0, realized: 0, unreal: 0, fees: 0, trades: [], opens: [], open: null, pendings: [], wins: 0, mdd: 0, curve: [[SOLB_START, SOLB_CFG.startEq]] };
    if (!sd || !sd.live || !sd.res) return blank;
    const r = sd.res, G = sd.G, keep = (1 - SOLB_CFG.slip) * (1 - SOLB_CFG.flatFee);
    const trades = r.trades;
    let closeVal = 0, fees = sum(trades.map(t => t.fees));
    const opens = r.opens.map(op => {
      const v = op.qty * op.last * keep;
      closeVal += v; fees += op.entryFee;
      return { ...op, value: v, unreal: v - op.notional - op.entryFee };
    });
    const bal = r.cash + closeVal, realized = sum(trades.map(t => t.net));
    const curve = [[SOLB_START, SOLB_CFG.startEq]];
    let peak = SOLB_CFG.startEq, mdd = 0;
    for (let i = 1; i < r.eq.length; i++) {
      const d = r.d0 + i;
      curve.push([sd.forming && d === r.d1 ? now : G.T[d] + H1, r.eq[i]]);
      if (r.eq[i] > peak) peak = r.eq[i];
      mdd = Math.min(mdd, r.eq[i] / peak - 1);
    }
    let pendings = r.pendBuy.map(sym => ({ side: 'buy', sym })).concat(r.pendSell.map(sym => ({ side: 'sell', sym })));
    if (!opens.length && !pendings.length && sd.resF && sd.resF.pendBuy.length) pendings = sd.resF.pendBuy.map(sym => ({ side: 'buy', sym, waiting: true }));
    return { bal, pnl: bal - SOLB_CFG.startEq, realized, unreal: opens.length ? bal - SOLB_CFG.startEq - realized : 0, fees, trades, opens, open: opens[0] || null, pendings,
      wins: trades.filter(t => t.net > 0).length, mdd, curve };
  }

  // ======================================================================= charts
  function niceTicks(lo, hi, n) {
    if (!(hi > lo)) { hi = lo + 1; lo = lo - 1; }
    const raw = (hi - lo) / Math.max(1, n - 1);
    const p = Math.pow(10, Math.floor(Math.log10(raw)));
    const f = raw / p;
    const step = (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * p;
    const out = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(+v.toFixed(10));
    return out;
  }
  function timeTicks(x0, x1, W) {
    const span = x1 - x0, maxN = Math.max(2, Math.floor(W / 95));
    const steps = [900, 1800, 3600, 7200, 10800, 21600, 43200, DAY, 2 * DAY, 7 * DAY, 14 * DAY, 30 * DAY, 91 * DAY, 365 * DAY];
    let step = steps.find(s => span / s <= maxN) || 365 * DAY;
    const out = [];
    if (step >= 365 * DAY) {
      const ys = [];
      for (let y = new Date(x0 * 1000).getUTCFullYear(); ; y++) { const t = Date.UTC(y, 0, 1) / 1000; if (t > x1) break; if (t >= x0) ys.push({ t, lab: String(y) }); }
      const stride = Math.ceil(ys.length / maxN);
      return ys.filter((_, i) => i % stride === 0);
    }
    if (step >= DAY) {
      let t = etMidnight(x0) + DAY;
      while (t <= x1) { out.push({ t, lab: F.md.format(new Date(t * 1000)) }); t = etMidnight(t + step + 7200); }
      return out;
    }
    let t = Math.ceil(x0 / step) * step;
    for (; t <= x1; t += step) {
      const mid = etSecOfDay(t) === 0;
      out.push({ t, lab: mid ? F.md.format(new Date(t * 1000)) : ft(t), strong: mid });
    }
    return out;
  }

  function lineChart(el, cfg) {
    const W = Math.max(300, Math.floor(el.clientWidth || el.parentElement.clientWidth || 640));
    const H = cfg.height || 260;
    const padL = cfg.padL || 66, padR = 14, padT = 14, padB = 26;
    const pts = cfg.series.flatMap(s => s.pts);
    if (!pts.length) { el.innerHTML = `<div class="empty">${cfg.empty || 'No data yet.'}</div>`; return; }
    let x0 = cfg.x0 != null ? cfg.x0 : Math.min(...pts.map(p => p[0]));
    let x1 = cfg.x1 != null ? cfg.x1 : Math.max(...pts.map(p => p[0]));
    if (x1 <= x0) x1 = x0 + 3600;
    const vals = pts.filter(p => p[0] >= x0 && p[0] <= x1).map(p => p[1]).concat((cfg.hlines || []).filter(h => h.inRange !== false).map(h => h.v));
    let y0 = Math.min(...vals), y1 = Math.max(...vals);
    const log = !!cfg.logY;
    if (log) { y0 = Math.max(y0, cfg.logFloor || 1); }
    if (!log) { const pad = (y1 - y0) * 0.08 || Math.abs(y1) * 0.002 || 1; y0 -= pad; y1 += pad; }
    const ly = v => Math.log10(Math.max(v, cfg.logFloor || 1));
    const Y0 = log ? ly(y0) : y0, Y1 = log ? ly(y1) * 1.0 + 0.05 : y1;
    const sx = t => padL + (t - x0) / (x1 - x0) * (W - padL - padR);
    const sy = v => padT + (1 - ((log ? ly(v) : v) - Y0) / (Y1 - Y0)) * (H - padT - padB);
    let g = '';
    // y grid
    let yt;
    if (log) { yt = []; const ms = (Y1 - Y0) > 3 ? [1] : [1, 2, 5]; for (let e = Math.floor(Y0); e <= Math.ceil(Y1); e++) for (const m of ms) { const v = m * 10 ** e; if (ly(v) >= Y0 && ly(v) <= Y1) yt.push(v); } }
    else yt = niceTicks(y0, y1, cfg.yTicks || 5);
    for (const v of yt) {
      const y = sy(v);
      g += `<line x1="${padL}" x2="${W - padR}" y1="${y}" y2="${y}" style="stroke:var(--line-2)"/>`;
      g += `<text x="${padL - 8}" y="${y + 4}" text-anchor="end" style="fill:var(--muted);font:11px var(--font-num)">${esc(cfg.yFmt(v))}</text>`;
    }
    for (const tk of (cfg.xTicks || timeTicks)(x0, x1, W)) {
      const x = sx(tk.t);
      if (x < padL || x > W - padR) continue;
      g += `<line x1="${x}" x2="${x}" y1="${padT}" y2="${H - padB}" style="stroke:var(--line-2)${tk.strong ? '' : ';stroke-dasharray:2 3'}"/>`;
      g += `<text x="${x}" y="${H - 8}" text-anchor="middle" style="fill:var(--muted);font:11px var(--font-body)">${esc(tk.lab)}</text>`;
    }
    for (const v of cfg.vlines || []) {
      if (v.t < x0 || v.t > x1) continue;
      const x = sx(v.t);
      g += `<line x1="${x}" x2="${x}" y1="${padT}" y2="${H - padB}" style="stroke:var(--ink);stroke-width:1;stroke-dasharray:4 3;opacity:.5"/>`;
      g += `<text x="${x + 5}" y="${H - padB - 6}" style="fill:var(--muted);font:600 11px var(--font-body)">${esc(v.label)}</text>`;
    }
    for (const h of cfg.hlines || []) {
      const y = sy(h.v);
      if (y < padT - 1 || y > H - padB + 1) continue;
      g += `<line x1="${padL}" x2="${W - padR}" y1="${y}" y2="${y}" style="stroke:${h.color};stroke-width:1.4;stroke-dasharray:6 4;opacity:${h.dim ? .45 : .9}"/>`;
      g += `<text x="${W - padR - 4}" y="${y - 5}" text-anchor="end" style="fill:${h.color};font:600 11px var(--font-body);opacity:${h.dim ? .7 : 1}">${esc(h.label)}</text>`;
    }
    for (const s of cfg.series) {
      const p = s.pts.filter(q => q[0] >= x0 - 1 && q[0] <= x1 + 1);
      if (!p.length) continue;
      let d = '';
      p.forEach((q, i) => { d += (i ? 'L' : 'M') + sx(q[0]).toFixed(1) + ' ' + sy(q[1]).toFixed(1); });
      if (s.area && !log) {
        const yb = H - padB;
        g += `<path d="${d}L${sx(p[p.length - 1][0]).toFixed(1)} ${yb}L${sx(p[0][0]).toFixed(1)} ${yb}Z" style="fill:${s.color};opacity:.08;stroke:none"/>`;
      }
      g += `<path d="${d}" style="fill:none;stroke:${s.color};stroke-width:${s.width || 1.8};stroke-linejoin:round;stroke-linecap:round;${s.dash ? 'stroke-dasharray:' + s.dash : ''}"/>`;
      const last = p[p.length - 1];
      if (s.endDot) g += `<circle cx="${sx(last[0])}" cy="${sy(last[1])}" r="3.5" style="fill:${s.color};stroke:var(--panel);stroke-width:1.5"/>`;
    }
    for (const m of cfg.markers || []) {
      if (m.t < x0 || m.t > x1) continue;
      const x = sx(m.t), y = sy(m.v);
      const d = m.buy ? `M${x} ${y - 1}l-5 9h10z` : `M${x} ${y + 1}l-5 -9h10z`;
      g += `<path d="${d}" style="fill:${m.color};stroke:var(--panel);stroke-width:1"><title>${esc(m.title || '')}</title></path>`;
    }
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(cfg.aria || 'chart')}">${g}<line class="xh" x1="0" x2="0" y1="${padT}" y2="${H - padB}" style="stroke:var(--muted);stroke-width:1;opacity:0"/><rect class="hit" x="${padL}" y="${padT}" width="${W - padL - padR}" height="${H - padT - padB}" style="fill:transparent"/></svg><div class="tip" hidden></div>`;
    const svg = el.querySelector('svg'), tip = el.querySelector('.tip'), xh = el.querySelector('.xh');
    const inv = px => x0 + (px - padL) / (W - padL - padR) * (x1 - x0);
    const near = (arr, t) => { let lo = 0, hi = arr.length - 1; if (hi < 0) return null; while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid][0] < t) lo = mid + 1; else hi = mid; } const c = arr[lo], p = arr[Math.max(0, lo - 1)]; return Math.abs(p[0] - t) < Math.abs(c[0] - t) ? p : c; };
    const move = ev => {
      const r = svg.getBoundingClientRect();
      const px = (ev.clientX - r.left) * (W / r.width);
      const t = inv(px);
      if (t < x0 || t > x1) return hide();
      let rows = '';
      for (const s of cfg.series) { const q = near(s.pts.filter(p => p[0] >= x0 && p[0] <= x1), t); if (q && !s.noTip) rows += `<div><span style="color:${s.color}">●</span> ${esc(s.name)} <b class="num">${esc(cfg.tipFmt ? cfg.tipFmt(q[1]) : cfg.yFmt(q[1]))}</b></div>`; }
      tip.innerHTML = `<div class="note">${esc(cfg.tipTime ? cfg.tipTime(t) : fdt(t))}</div>${rows}`;
      tip.hidden = false;
      const left = Math.min(r.width - tip.offsetWidth - 4, Math.max(4, ev.clientX - r.left + 12));
      tip.style.left = left + 'px'; tip.style.top = '8px';
      xh.setAttribute('x1', sx(t)); xh.setAttribute('x2', sx(t)); xh.style.opacity = .6;
    };
    const hide = () => { tip.hidden = true; xh.style.opacity = 0; };
    svg.addEventListener('pointermove', move);
    svg.addEventListener('pointerleave', hide);
  }

  function spark(pts, color, base = START_EQ) {
    if (pts.length < 2) return `<svg class="spark" viewBox="0 0 200 34" preserveAspectRatio="none" width="100%" height="34"><line x1="0" x2="200" y1="17" y2="17" style="stroke:var(--line);stroke-dasharray:3 3"/></svg>`;
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    const x0 = xs[0], x1 = xs[xs.length - 1] || x0 + 1;
    let y0 = Math.min(...ys, base), y1 = Math.max(...ys, base);
    if (y1 - y0 < base * 1.25e-4) { y0 -= base * 1.25e-4; y1 += base * 1.25e-4; }
    const sx = t => (t - x0) / (x1 - x0 || 1) * 200, sy = v => 31 - (v - y0) / (y1 - y0) * 28;
    const d = pts.map((p, i) => (i ? 'L' : 'M') + sx(p[0]).toFixed(1) + ' ' + sy(p[1]).toFixed(1)).join('');
    return `<svg class="spark" viewBox="0 0 200 34" preserveAspectRatio="none" width="100%" height="34" aria-hidden="true"><line x1="0" x2="200" y1="${sy(base)}" y2="${sy(base)}" style="stroke:var(--line);stroke-dasharray:3 3"/><path d="${d}" style="fill:none;stroke:${color};stroke-width:1.8" vector-effect="non-scaling-stroke"/></svg>`;
  }

  // ======================================================================= render: status + clock
  function renderStatus() {
    const o = S.out, now = nowSec();
    if (isFinite(S.price)) {
      $('px').textContent = '$' + nf2.format(S.price);
      if (isFinite(S.open24) && S.open24 > 0) {
        const c = S.price / S.open24 - 1;
        $('chg').className = 'chg ' + cls(c * 1e4);
        $('chg').textContent = spct(c) + ' 24h';
      }
    }
    const ok = !S.err && S.lastOk;
    $('dot').className = 'dot ' + (ok ? 'ok' : S.lastOk ? 'bad' : '');
    $('feed').textContent = S.lastOk ? `${SOURCES[S.src].name} · updated ${F.ts.format(new Date(S.lastOk * 1000))} ET` : 'Connecting to Coinbase…';
    $('errBox').innerHTML = S.err ? `<div class="err">${esc(S.err)}</div>` : (o && o.err ? `<div class="callout">${esc(o.err)}</div>` : '');
    tickClock();
  }
  function tickClock() {
    const now = nowSec();
    if (now < START) {
      $('clockBig').textContent = `Starts in ${dur(START - now)}`;
      $('clockSub').textContent = `${F.full.format(new Date(START * 1000))} ET. Each bot gets $8,000 of paper money.`;
    } else {
      $('clockBig').textContent = `Running for ${dur(now - START)}`;
      $('clockSub').textContent = `Started ${F.full.format(new Date(START * 1000))} ET with $8,000 per bot.`;
    }
  }

  // ======================================================================= render: live
  const nextDecision = now => Math.floor(now / DAY) * DAY + DAY;

  function botState(id, o) {
    const a = o.acc && o.acc[id];
    const p = o.price;
    const nd = nextDecision(o.now);
    const ndTxt = `${ft(nd)} ET`;
    if (id === 'mtf') return mtfState(a, o);
    if (id === 'futb') return futState(a, o);
    if (id === 'combo') return comboState(a, o);
    if (id === 'meme') return memeState(a, o, ndTxt);
    if (!o.started || !a) {
      const firstDay = { swing: 'Places a limit buy at the start if BTC closes above its 50-day average.', half: 'Same signal as Trend Swing, with half the money.', lev: `Same signal, with borrowed money: about ${o.levNow.toFixed(1)}x right now.`, multi: 'Four mini-bots on the 20, 50, 100 and 200-day averages.', day: 'First trading day begins at the start.', hold: 'Buys at the start and holds.', old: 'Starts watching 5-minute candles at the start.' };
      return { pill: ['wait', `Starts ${ft(START)} ET`], text: firstDay[id] };
    }
    if (SLEEVE_BOTS.has(id)) return sleeveState(id, a, o, ndTxt);
    if (a.open) {
      const u = a.unreal;
      const sell = a.pending && a.pending.side === 'sell'
        ? ` Selling: ${o.now < a.pending.limitUntil ? `limit at $${nf2.format(a.pending.px)} until ${ft(a.pending.limitUntil)} ET, then market.` : 'at market on the next candle.'}` : '';
      return { pill: ['in', sell ? 'Selling' : 'In a trade'], text: `Holding ${btc(a.open.qty)} BTC bought at $${nf2.format(a.open.entryPx)} (${fdt(a.open.entryT)}). Unrealized <b class="${cls(u)}">${susd(u)}</b> after the estimated sell fee.${sell}` };
    }
    if (a.pending && a.pending.side === 'buy') {
      return { pill: ['wait', 'Buy order waiting'], text: o.now < a.pending.limitUntil
        ? `Limit buy at $${nf2.format(a.pending.px)} until ${ft(a.pending.limitUntil)} ET. If it hasn't filled by then, it buys at market.`
        : 'Limit window ended. Buying at market on the next candle.' };
    }
    if (a.pending) {
      if (a.pending.type === 3) return { pill: ['wait', 'Buy order waiting'], text: `Buy-stop at $${nf2.format(a.pending.px)} until ${ndTxt}. BTC is ${pct(p / a.pending.px - 1, 2)} from it.` };
      return { pill: ['wait', 'Buying next candle'], text: 'Signal fired. It buys at the open of the next candle.' };
    }
    if (id === 'day') return { pill: ['off', 'Sitting out'], text: o.planToday && !o.planToday.trendOk ? `Trend filter is off today. Next plan at ${ndTxt}.` : `No trade right now. Next plan at ${ndTxt}.` };
    if (id === 'swing') return { pill: ['off', 'In cash'], text: `Below its 50-day average. Next check ${ndTxt}.` };
    if (id === 'old') return { pill: ['off', 'Watching'], text: 'Waiting for a 5-minute close above the prior 20-candle high.' };
    return { pill: ['off', 'Flat'], text: '' };
  }

  function futState(a, o) {
    const p = o.futPlan, dayEnd = p ? p.dayStart + DAY : NaN;
    if (!o.started || !a || a.notStarted) {
      return { pill: ['wait', `Starts ${ft(FUTB_START)} ET`], text: `Rules locked at ${ft(FUTB_LOCKED)} ET. Each day it waits for BTC to break above the day's open + 0.6 × yesterday's range, buys futures at 1.5x, and is out by the end of the day.` };
    }
    if (a.open) {
      return { pill: ['in', 'Long 1.5x'], text: `Long ${btc(a.open.qty)} BTC ($${nf0.format(a.open.notional)} position) since ${fdt(a.open.entryT)} at $${nf2.format(a.open.entryPx)}. Stop $${nf0.format(a.open.stop)}. Closes at ${ft(dayEnd)} ET if the stop doesn't hit. Unrealized <b class="${cls(a.unreal)}">${susd(a.unreal)}</b> after fees.` };
    }
    if (a.pendings.length) return { pill: ['wait', 'Buying next candle'], text: 'Breakout! It buys at the open of the next 5-minute candle.' };
    if (!p || !isFinite(p.trigger)) return { pill: ['off', 'Waiting'], text: 'Waiting for a full day of candles.' };
    if (p.tradedToday) return { pill: ['off', 'Done for today'], text: `Today's breakout already happened. A new day starts at ${ft(dayEnd)} ET.` };
    return { pill: ['off', 'Waiting for breakout'], text: `Buys on a 5-minute close above <b>$${nf0.format(p.trigger)}</b>. BTC is ${pct(Math.abs(o.price / p.trigger - 1), 2)} ${o.price >= p.trigger ? 'above' : 'below'} it. Day ends ${ft(dayEnd)} ET.` };
  }

  function memeState(a, o, ndTxt) {
    const md = o.memeData;
    if (!md || !md.ready) return { pill: ['wait', S.src === 'coinbase' ? 'Loading coins' : 'Needs Coinbase'], text: S.src === 'coinbase' ? 'Loading meme coin prices from Coinbase.' : 'Meme coin prices come from Coinbase, which is not reachable right now.' };
    if (!a || a.notStarted) return { pill: ['wait', `Starts ${ft(MEME_START)} ET`], text: `Rules locked at ${ft(MEME_LOCKED)} ET. Each daily close it holds the meme coin with the best 30-day run, while BTC's trend is up.` };
    const sells = a.pendings.filter(p => p.side === 'sell'), buys = a.pendings.filter(p => p.side === 'buy');
    if (a.open) {
      let text = `Holding ${qtyF(a.open.qty)} ${a.open.sym} bought at $${pxF(a.open.entryPx)} (${fdt(a.open.entryT)}), now $${pxF(a.open.pxNow)}. Unrealized <b class="${cls(a.unreal)}">${susd(a.unreal)}</b> after the estimated sell fee.`;
      if (sells.length) text += ` Selling at the next daily open${buys.length ? `, then buying ${buys[0].sym}` : ''}.`;
      return { pill: ['in', sells.length ? `Selling ${a.open.sym}` : `Holding ${a.open.sym}`], text };
    }
    if (buys.length) return { pill: ['wait', `Buying ${buys[0].sym}`], text: `Buys ${buys[0].sym} at the next daily open with all the cash.` };
    const b = md.board;
    if (!b.btcOk) return { pill: ['off', 'In cash'], text: `BTC closed under its 50-day average, so it stays out of meme coins. Next check ${ndTxt}.` };
    return { pill: ['off', 'In cash'], text: `No meme coin is up over 30 days and above its 20-day average. Next check ${ndTxt}.` };
  }
  function comboHalves(a, o) {
    const sw = a.parts.swing, fu = a.parts.futb, p = o.futPlan;
    const swTxt = sw.open ? `holding BTC, ${susd(sw.unreal)}` : sw.pendings.length ? `${sw.pendings[0].side} order working` : 'in cash';
    const fuTxt = fu.open ? `long 1.5x, ${susd(fu.unreal)}` : fu.pendings.length ? 'buying next candle' : p && p.tradedToday ? 'done for today'
      : p && isFinite(p.trigger) ? `waiting for $${nf0.format(p.trigger)}` : 'waiting';
    return { sw, fu, swTxt, fuTxt };
  }
  function comboState(a, o) {
    if (!o.started || !a || a.notStarted) {
      return { pill: ['wait', `Starts ${F.dt.format(new Date(COMBO_START * 1000))} ET`], text: `Rules locked at ${ft(COMBO_LOCKED)} ET. $4,000 follows Trend Swing (spot) and $4,000 follows the Futures Breakout (1.5x). The two halves never share money.` };
    }
    const { sw, fu, swTxt, fuTxt } = comboHalves(a, o);
    const nIn = (sw.open ? 1 : 0) + (fu.open ? 1 : 0);
    const pill = nIn ? ['in', `${nIn} of 2 halves in`] : (sw.pendings.length || fu.pendings.length) ? ['wait', 'Order waiting'] : ['off', 'Both halves flat'];
    return { pill, text: `Swing half $${nf0.format(sw.balance)}: <b>${swTxt}</b>. Futures half $${nf0.format(fu.balance)}: <b>${fuTxt}</b>.` };
  }

  function mtfState(a, o) {
    const m = o.mtf, P = ENGINE.MTF;
    if (!o.started || !a || a.notStarted) {
      return { pill: ['wait', `Starts ${ft(MTF_START)} ET`], text: `Starts 3 hours after the others because its rules were locked at ${ft(MTF_LOCKED)} ET. Then it checks every 15-minute close.` };
    }
    const buys = a.pendings.filter(p => p.side === 'buy'), sells = a.pendings.filter(p => p.side === 'sell');
    const until = p => o.now < p.limitUntil ? `limit at $${nf2.format(p.px)} until ${ft(p.limitUntil)} ET, then market` : 'at market on the next candle';
    const ok = isFinite(m.hAvg) && isFinite(m.hClose);
    const buyLine = m.hAvg * (1 + P.band), sellLine = m.hAvg * (1 - P.band);
    if (a.open) {
      let text = `Holding ${btc(a.open.qty)} BTC bought at $${nf2.format(a.open.entryPx)} (${fdt(a.open.entryT)}).${ok ? ` Sells if a 1-hour close drops under $${nf0.format(sellLine)}.` : ''} Unrealized <b class="${cls(a.unreal)}">${susd(a.unreal)}</b> after the estimated sell fee.`;
      if (sells.length) text += ` Selling: ${until(sells[0])}.`;
      return { pill: ['in', sells.length ? 'Selling' : 'In a trade'], text };
    }
    if (buys.length) return { pill: ['wait', 'Buy order waiting'], text: `Buying: ${until(buys[0])}.` };
    if (!ok) return { pill: ['off', 'In cash'], text: 'Waiting for 1-hour candles.' };
    if (!(m.hClose > buyLine)) return { pill: ['off', 'In cash'], text: `1-hour trend not up enough. A 1-hour close above $${nf0.format(buyLine)} turns buying on.` };
    return { pill: ['off', 'Waiting for a dip'], text: `1-hour trend is up. It buys when a 15-minute RSI(14) closes under 35 (last close: ${isFinite(m.rsi) ? m.rsi.toFixed(1) : '–'}).` };
  }

  function sleeveState(id, a, o, ndTxt) {
    const buys = a.pendings.filter(p => p.side === 'buy'), sells = a.pendings.filter(p => p.side === 'sell');
    const until = p => o.now < p.limitUntil ? `limit at $${nf2.format(p.px)} until ${ft(p.limitUntil)} ET, then market` : 'at market on the next candle';
    const un = `Unrealized <b class="${cls(a.unreal)}">${susd(a.unreal)}</b> after the estimated sell fee${id === 'lev' ? ' and interest' : ''}.`;
    if (id === 'multi') {
      const inS = a.opens.map(op => SPEEDS[op.sleeve]);
      let text = inS.length ? `Holding on the ${inS.join(', ')}-day ${inS.length > 1 ? 'speeds' : 'speed'} (${inS.length} of 4 quarters invested). ${un}` : 'All four speeds in cash.';
      if (buys.length) text += ` Buying on ${buys.map(p => SPEEDS[p.sleeve]).join(', ')}-day: ${until(buys[0])}.`;
      if (sells.length) text += ` Selling on ${sells.map(p => SPEEDS[p.sleeve]).join(', ')}-day: ${until(sells[0])}.`;
      return { pill: inS.length ? ['in', `${inS.length} of 4 in`] : buys.length ? ['wait', 'Buy orders waiting'] : ['off', 'In cash'], text };
    }
    if (a.open) {
      let text = `Holding ${btc(a.open.qty)} BTC bought at $${nf2.format(a.open.entryPx)} (${fdt(a.open.entryT)}).`;
      if (id === 'lev') text += ` Leverage now ${(a.posVal / a.balance).toFixed(2)}x with $${nf0.format(a.open.borrowed)} borrowed. <b>Liquidated if BTC hits $${nf0.format(a.open.liqPx)}.</b>`;
      text += ` ${un}`;
      if (sells.length) text += ` Selling: ${until(sells[0])}.`;
      return { pill: ['in', sells.length ? 'Selling' : 'In a trade'], text };
    }
    if (buys.length) return { pill: ['wait', 'Buy order waiting'], text: `Buying: ${until(buys[0])}.${id === 'lev' ? ` It will borrow to hold ${buys[0].alloc.toFixed(2)}x its cash.` : id === 'half' ? ' It invests half its cash.' : ''}` };
    return { pill: ['off', 'In cash'], text: `Below its 50-day average. Next check ${ndTxt}.` };
  }

  function renderBays(o) {
    $('bays').innerHTML = CORE.map(b => {
      const a = o.acc && o.acc[b.id];
      const bal = a ? a.balance : START_EQ, pnl = a ? a.pnl : 0;
      const st = botState(b.id, o);
      const minis = [
        ['Trades', a ? String(a.trades.length) : '0'],
        ['Win rate', a && a.trades.length ? Math.round(a.winRate * 100) + '%' : '–'],
        ['Fees paid', a ? usd(a.fees) : '$0.00'],
        ['Max drop', a ? pct(a.mdd) : '0.0%'],
      ];
      return `<article class="bay" style="--bc:${b.color}">
        <div class="head"><span class="role">${b.role}</span><span class="name">${b.name}</span></div>
        <div><div class="label">Balance if closed now</div><div class="bal">${usd(bal)}</div>
        <div class="pnl ${cls(pnl)}">${susd(pnl)} (${spct(pnl / START_EQ)})</div></div>
        <span class="pill ${st.pill[0]}">${esc(st.pill[1])}</span>
        <div class="state">${st.text}</div>
        ${spark(a ? a.curve : [], b.color)}
        <div class="minis">${minis.map(m => `<div><div class="k">${m[0]}</div><div class="v">${m[1]}</div></div>`).join('')}</div>
      </article>`;
    }).join('');
  }

  function renderNow(o) {
    const p = o.price, sn = o.snap, pv = o.prov;
    const rows = [];
    const nd = nextDecision(o.now);
    const ndTxt = `${ft(nd)} ET`;
    const rel = (a, b) => `${pct(Math.abs(a / b - 1), 2)} ${a >= b ? 'above' : 'below'}`;
    // Combo 50/50
    {
      const a = o.acc && o.acc.combo;
      let what, why;
      if (!o.started || !a || a.notStarted) {
        what = `Starts ${F.full.format(new Date(COMBO_START * 1000))} ET with $4,000 in each half.`;
        why = 'At that daily close the spot half acts on the Trend Swing signal, and the futures half starts watching for the next day’s breakout. In testing (2020 to 2026) the mix had a smoother ride than either part alone, because the two often win and lose on different days.';
      } else {
        const { sw, fu, swTxt, fuTxt } = comboHalves(a, o);
        what = `<b>Swing half</b> $${nf2.format(sw.balance)}: ${swTxt}. <b>Futures half</b> $${nf2.format(fu.balance)}: ${fuTxt}.`;
        why = 'Each half follows its own bot’s rules with its own money: same signals as Trend Swing and the Futures Breakout, half the size. Money never moves between the halves.';
      }
      rows.push(['combo', what, why]);
    }
    // Meme Coin Trader
    {
      const md = o.memeData, a = o.acc && o.acc.meme;
      let what = S.src === 'coinbase' ? 'Loading meme coin prices from Coinbase.' : 'Needs Coinbase for meme coin prices.', why = '';
      if (md && md.ready) {
        const b = md.board, top = b.rows.filter(r => r.cand).slice(0, 3);
        const gainTxt = r => `${r.sym} ${spct(r.gain, 0)}`;
        const lead = top.length ? `Leader at the last close: <b>${top[0].sym}</b>, ${spct(top[0].gain, 0)} in 30 days${top.length > 1 ? ` (next: ${top.slice(1).map(gainTxt).join(', ')})` : ''}.` : 'At the last close no meme coin was up over 30 days and above its 20-day average.';
        const btcTxt = `BTC is ${b.btcOk ? 'above' : 'under'} its 50-day average ($${nf0.format(b.btcClose)} vs $${nf0.format(b.btcAvg)} at the last close)`;
        const sells = a ? a.pendings.filter(p => p.side === 'sell') : [], buys = a ? a.pendings.filter(p => p.side === 'buy') : [];
        if (!a || a.notStarted) {
          what = `Starts ${F.full.format(new Date(MEME_START * 1000))} ET. ${lead}`;
          why = `${btcTxt}. From the start, at each daily close it holds the #1 coin while BTC's trend is up.`;
        } else if (a.open) {
          what = `<b>${sells.length ? 'Selling' : 'Holding'} ${a.open.sym}</b> since ${fdt(a.open.entryT)}. ${lead}`;
          why = `${btcTxt}. It keeps ${a.open.sym} while it stays in the top 3, up over 30 days and above its 20-day average.`;
        } else if (buys.length) {
          what = `<b>Buying ${buys[0].sym}</b> at the next daily open. ${lead}`;
          why = `${btcTxt}.`;
        } else {
          what = `<b>In cash.</b> ${lead}`;
          why = `${btcTxt}. ${b.btcOk ? 'It buys the #1 coin at the next daily close if one qualifies.' : 'No meme coins until BTC closes back above its 50-day average.'}`;
        }
      }
      rows.push(['meme', what, why]);
    }
    // Trend Swing
    {
      let what, why;
      const a = o.acc && o.acc.swing;
      if (!o.started) {
        what = `At ${ft(START)} ET it compares tonight's daily close with the 50-day average.`;
        why = `BTC is $${nf2.format(p)}, about ${rel(p, pv.sma50)} the 50-day average (≈$${nf0.format(pv.sma50)} including today). If it stays above, the bot places a limit buy at that closing price at ${ft(START)} ET.`;
      } else if (a && a.open && a.pending && a.pending.side === 'sell') {
        what = `<b>Selling.</b> Last daily close $${nf0.format(sn.close)} was ${rel(sn.close, sn.sma50)} the 50-day average $${nf0.format(sn.sma50)}.`;
        why = `Limit sell at $${nf2.format(a.pending.px)} until ${ft(a.pending.limitUntil)} ET, then a market sell if it hasn't filled. Limit orders pay the lower maker fee.`;
      } else if (a && a.open) {
        what = `<b>Holding.</b> Last daily close $${nf0.format(sn.close)} was ${rel(sn.close, sn.sma50)} the 50-day average $${nf0.format(sn.sma50)}.`;
        why = `It sells only after a daily close below the average. Next check ${ndTxt}; BTC is now ${rel(p, pv.sma50)} today's provisional average ≈$${nf0.format(pv.sma50)}.`;
      } else if (a && a.pending && a.pending.side === 'buy') {
        what = `<b>Buy order placed.</b> Last daily close $${nf0.format(sn.close)} was ${rel(sn.close, sn.sma50)} the 50-day average $${nf0.format(sn.sma50)}.`;
        why = `Limit buy at $${nf2.format(a.pending.px)} until ${ft(a.pending.limitUntil)} ET, then a market buy if it hasn't filled. Limit orders pay the lower maker fee.`;
      } else {
        what = `<b>In cash.</b> Last daily close $${nf0.format(sn.close)} was ${rel(sn.close, sn.sma50)} the 50-day average $${nf0.format(sn.sma50)}.`;
        why = `Next check ${ndTxt}. BTC is now ${rel(p, pv.sma50)} the provisional average ≈$${nf0.format(pv.sma50)}.`;
      }
      rows.push(['swing', what, why]);
    }
    // 1h/15m Trader
    {
      const m = o.mtf, a = o.acc && o.acc.mtf, P = ENGINE.MTF;
      const buyLine = m.hAvg * (1 + P.band), sellLine = m.hAvg * (1 - P.band);
      let what, why;
      if (!isFinite(m.hAvg) || !isFinite(m.hClose)) { what = 'Waiting for 1-hour candles.'; why = ''; }
      else {
        const allow = m.hClose > buyLine;
        const ctx = `Last finished 1-hour close $${nf0.format(m.hClose)} (${ft(m.hT)} to ${ft(m.hT + H1)} ET) is ${rel(m.hClose, m.hAvg)} the 200-hour average $${nf0.format(m.hAvg)}. Buy line $${nf0.format(buyLine)}, sell line $${nf0.format(sellLine)}.`;
        const rsiTxt = isFinite(m.rsi) ? `15-minute RSI(14) at the ${ft(m.rsiT)} ET close: <b>${m.rsi.toFixed(1)}</b>` : '15-minute RSI not ready yet';
        const sp = a && !a.notStarted ? a.pendings.find(p => p.side === 'sell') : null;
        const bp = a && !a.notStarted ? a.pendings.find(p => p.side === 'buy') : null;
        if (!o.started || !a || a.notStarted) {
          what = `Starts at ${ft(MTF_START)} ET. ${ctx}`;
          why = `${rsiTxt}. Once running, it buys when that RSI closes under 35 while the 1-hour close is above the buy line.`;
        } else if (a.open) {
          what = `<b>${sp ? 'Selling' : 'Holding'}.</b> ${ctx}`;
          why = sp ? `Limit sell at $${nf2.format(sp.px)} until ${ft(sp.limitUntil)} ET, then a market sell if it hasn't filled.`
            : `It sells only when a 1-hour close falls under the sell line ($${nf0.format(sellLine)}). It checks at every 15-minute close.`;
        } else if (bp) {
          what = `<b>Buy order placed.</b> ${ctx}`;
          why = `Limit buy at $${nf2.format(bp.px)} until ${ft(bp.limitUntil)} ET, then a market buy if it hasn't filled. Limit orders pay the lower maker fee.`;
        } else {
          what = `<b>In cash${allow ? ', buying allowed' : ''}.</b> ${ctx}`;
          why = allow ? `${rsiTxt}. It buys at the next 15-minute close with RSI under 35.` : `No buys until a 1-hour close is above $${nf0.format(buyLine)}. ${rsiTxt}.`;
        }
      }
      rows.push(['mtf', what, why]);
    }
    // Futures Breakout
    {
      const p = o.futPlan, a = o.acc && o.acc.futb;
      let what, why;
      if (!p || !isFinite(p.trigger)) { what = 'Waiting for a full day of candles.'; why = ''; }
      else {
        const dayEnd = p.dayStart + DAY;
        const plan = `Today (from ${ft(p.dayStart)} ET): open $${nf0.format(p.open)}, yesterday's range $${nf0.format(p.prevRange)}, trigger <b>$${nf0.format(p.trigger)}</b> (open + 0.6 × range).`;
        if (!o.started || !a || a.notStarted) {
          what = `Starts at ${ft(FUTB_START)} ET. ${plan}`;
          why = `Once running: on the first 5-minute close above the trigger it buys BTC futures at 1.5x, stop half a range below, and it sells by ${ft(dayEnd)} ET.`;
        } else if (a.open) {
          what = `<b>Long at 1.5x.</b> ${plan}`;
          why = `Bought at $${nf2.format(a.open.entryPx)}. Stop $${nf0.format(a.open.stop)}. It sells at ${ft(dayEnd)} ET (end of the UTC day) unless the stop hits first.`;
        } else if (a.pendings.length) {
          what = `<b>Breakout.</b> ${plan}`;
          why = 'It buys at the open of the next 5-minute candle.';
        } else if (p.tradedToday) {
          what = `<b>Done for today.</b> ${plan}`;
          why = `One trade a day at most. The next day starts at ${ft(dayEnd)} ET with a new trigger.`;
        } else {
          what = `<b>Waiting for the breakout.</b> ${plan}`;
          why = `BTC is $${nf2.format(o.price)}, ${pct(Math.abs(o.price / p.trigger - 1), 2)} ${o.price >= p.trigger ? 'above' : 'below'} the trigger. It needs a 5-minute candle to close above it before ${ft(dayEnd)} ET.`;
        }
      }
      rows.push(['futb', what, why]);
    }
    // Half-Size, Leveraged, Multi-Speed
    {
      const NB = RESEARCH.newBots || {};
      const a = o.acc && o.acc.half;
      const what = !o.started ? 'Same signal as Trend Swing, with only half the money invested.'
        : a && a.open ? `<b>Holding</b> with half its cash in BTC.` : a && a.pendings.length ? '<b>Buy order placed</b> for half its cash.' : '<b>In cash.</b> Same 50-day rule as Trend Swing.';
      const why = NB.half ? `In testing its worst drop was ${pct(NB.half.dev_dd / 100, 0)} vs ${pct(NB.swing.dev_dd / 100, 0)} for Trend Swing (2020\u201324), with smaller gains too.` : '';
      rows.push(['half', what, why]);
    }
    {
      const a = o.acc && o.acc.lev;
      let what;
      if (!o.started) what = `If it buys at ${ft(START)} ET, it borrows to hold <b>${o.levNow.toFixed(2)}x</b> its cash.`;
      else if (a && a.open) what = `<b>Holding at ${(a.posVal / a.balance).toFixed(2)}x</b> with $${nf0.format(a.open.borrowed)} borrowed. Liquidated if BTC hits <b>$${nf0.format(a.open.liqPx)}</b>.`;
      else if (a && a.pendings.length) what = `<b>Buy order placed</b> at ${a.pendings[0].alloc.toFixed(2)}x leverage.`;
      else what = '<b>In cash.</b> Same 50-day rule as Trend Swing.';
      const why = `Leverage = 100% \u00f7 BTC's 30-day volatility (${(o.volNow * 100).toFixed(0)}% now), capped at 3x. Borrowing costs 15% a year. A big enough drop wipes out the margin and forces a sale.`;
      rows.push(['lev', what, why]);
    }
    {
      const a = o.acc && o.acc.multi;
      const base = o.started ? o.snap.close : p;
      const avgs = o.started ? o.smaN : o.provN;
      const parts = SPEEDS.map(n => `${n}-day $${nf0.format(avgs[n])} ${base > avgs[n] ? '<b>above</b>' : 'below'}`);
      const nIn = SPEEDS.filter(n => base > avgs[n]).length;
      const what = (o.started ? `Last daily close $${nf0.format(base)} vs each average: ` : `BTC now $${nf0.format(base)} vs each average (\u2248 including today): `) + parts.join(' \u00b7 ') + '.';
      const why = o.started && a ? `${a.opens.length} of 4 quarters invested. Each speed runs a quarter of the money and trades on its own, so no single setting decides everything.`
        : `About ${nIn} of 4 quarters would buy at ${ft(START)} ET if prices stay here. Each speed runs a quarter of the money on its own.`;
      rows.push(['multi', what, why]);
    }
    // Day trader
    {
      let what, why;
      const a = o.acc && o.acc.day;
      const pl = o.planToday;
      if (!o.started) {
        const rng = pv.high - pv.low, trig = pv.close + 0.7 * rng;
        const on = pv.close > pv.sma20;
        what = `First trading day runs ${ft(START)} ET to ${ft(START + DAY)} ET tomorrow.`;
        why = `If BTC finishes today near $${nf0.format(p)} (today's range so far $${nf0.format(rng)}), the buy trigger would be ≈$${nf0.format(trig)} and the trend filter would be <b>${on ? 'on' : 'off'}</b> (20-day average ≈$${nf0.format(pv.sma20)}).${on ? '' : ' Off means no trade that day.'}`;
      } else if (a && a.open) {
        what = `<b>In today's trade.</b> Bought at $${nf2.format(a.open.entryPx)} when price crossed the trigger.`;
        why = `It sells at ${ndTxt} at the latest (end of the UTC day). No intraday stop: testing showed stops cut more winners than losers.`;
      } else if (pl) {
        if (!pl.trendOk) {
          what = `<b>Sitting out today.</b> Yesterday's close $${nf0.format(pl.prevClose)} was below its 20-day average $${nf0.format(pl.avg)}.`;
          why = `The trigger would have been $${nf0.format(pl.trig)}. New plan at ${ndTxt}.`;
        } else {
          const doneToday = a && a.trades.some(t => t.entryT >= o.todayStart);
          what = doneToday ? `<b>Today's trade is finished.</b>` : p >= pl.trig ? `<b>Price is above the $${nf2.format(pl.trig)} trigger.</b> The buy is recorded when this 5-minute candle closes.` : `<b>Waiting for $${nf2.format(pl.trig)}.</b> BTC is ${pct(Math.abs(p / pl.trig - 1), 2)} below it.`;
          why = `Trigger = yesterday's close $${nf0.format(pl.prevClose)} + 0.7 × yesterday's range $${nf0.format(pl.rng)}. Size if it fires: ${Math.round(pl.alloc * 100)}% of cash. Trend filter on: $${nf0.format(pl.prevClose)} > 20-day average $${nf0.format(pl.avg)}.`;
        }
      } else { what = 'Waiting for daily data.'; why = ''; }
      rows.push(['day', what, why]);
    }
    // Buy & hold
    {
      const a = o.acc && o.acc.hold;
      const what = !o.started ? `Buys at ${ft(START)} ET at the market price and never sells.` : a && a.open ? `<b>Holding</b> ${btc(a.open.qty)} BTC bought at $${nf2.format(a.open.entryPx)}.` : `<b>Buying at the next daily open.</b>`;
      rows.push(['hold', what, 'The yardstick. A bot that cannot beat this is not adding anything.']);
    }
    // Old bot
    {
      const a = o.acc && o.acc.old;
      let what, why;
      if (!o.started || !a) { what = 'Starts trading 5-minute breakouts at the start.'; why = 'Expected to lose: in testing its trades averaged −0.06% before fees, so every fee is a straight loss.'; }
      else {
        const today = a.trades.filter(t => t.entryT >= etMidnight(o.now));
        what = a.open ? `<b>In a trade</b> since ${ft(a.open.entryT)}. Stop $${nf0.format(a.open.stop)}, target $${nf0.format(a.open.target)}.` : `<b>Watching</b> for the next breakout.`;
        why = `${a.trades.length} trades so far (${today.length} today). Before fees: <b class="${cls(a.gross)}">${susd(a.gross)}</b>. Fees: <b>${usd(a.fees)}</b>.`;
      }
      rows.push(['old', what, why]);
    }
    $('nowList').innerHTML = rows.map(([id, w, y]) => `<div class="row" style="--bc:${BOT[id].color}"><div class="who"><i></i>${BOT[id].name}</div><div><div class="what">${w}</div><div class="why">${y}</div></div></div>`).join('');
  }

  // ---------- Solana Meme Trader panel (10 paper SOL; balances in SOL)
  // The engine's sell text is written for the daily dollar bot; with anyGain the only other way out is dropping off the eligible list.
  const solbOut = w => { const m = /^fell to #(\d+)/.exec(w || ''); return m ? `Fell to #${m[1]} by 7-day change against SOL` : 'Dropped off the eligible list (under 50 SOL of hourly volume, or no price)'; };
  function renderSolb(o) {
    const sd = o.solbData, a = o.solbAcc, el = $('solbBody');
    if (!sd || !sd.ready) {
      $('solbSub').textContent = S.src === 'coinbase' ? 'Loading Solana meme coin prices from Coinbase…' : 'Needs Coinbase for Solana meme coin prices.';
      $('solbPill').className = 'pill wait'; $('solbPill').textContent = 'Loading';
      el.innerHTML = '';
      return;
    }
    const b = sd.board, nd = Math.floor(o.now / DAY) * DAY + DAY, solNow = sd.solNow;
    const sol = v => `${v.toFixed(3)} SOL`, ssol = v => `${v > 0.0005 ? '+' : v < -0.0005 ? MINUS : ''}${Math.abs(v).toFixed(3)} SOL`;
    const elig = b.rows.filter(r => r.elig), lead = elig[0];
    let pill, state;
    if (a.notStarted) {
      pill = ['wait', `Starts ${ft(SOLB_START)} ET`];
      state = `Rules locked at ${ft(SOLB_LOCKED)} ET. At ${ft(SOLB_START)} ET it swaps all 10 SOL into the Solana meme coin with the best 7-day run against SOL${lead ? ` (right now: <b>${lead.sym}</b>, ${spct(lead.g7, 1)})` : ''}.`;
    } else if (a.open) {
      const op = a.open, buyUsd = op.entryPx * sd.solAt(op.entryT);
      pill = ['in', `Holding ${op.sym}`];
      state = `Holding ${qtyF(op.qty)} ${op.sym} since ${fdt(op.entryT)}, bought at ${pxF(op.entryPx)} SOL (≈$${pxF(buyUsd)}). Swapping it back now would give ${sol(op.value)}: <b class="${cls(op.unreal * 1000)}">${ssol(op.unreal)}</b> on this coin after costs. Next check ${ft(nd)} ET: it keeps ${op.sym} while it stays in the top 3 by 7-day change.`;
      if (a.pendings.some(p => p.side === 'sell')) state += ' Swapping out at the next hourly open.';
    } else if (a.pendings.length) {
      pill = ['wait', `Buying ${a.pendings[0].sym}`];
      state = a.pendings[0].waiting ? `Swapping all the SOL into ${a.pendings[0].sym} at its first trade of this hour (Coinbase has no ${a.pendings[0].sym} trade yet this hour).`
        : `Swapping all the SOL into ${a.pendings[0].sym} at the next hourly open.`;
    } else {
      pill = ['off', 'In SOL'];
      state = 'No eligible coin to hold right now (too thin or missing data). It holds SOL until one qualifies.';
    }
    $('solbPill').className = 'pill ' + pill[0];
    $('solbPill').textContent = pill[1];
    $('solbSub').innerHTML = `10 paper SOL, always in one Solana meme coin: the one with the best 7-day change against SOL, picked at the start and then re-checked every day at ${ft(nd)} ET. Swaps pay about 0.5% each way. Nothing here touches a real wallet.`
      + (sd.missing.length ? ` Not loaded yet: ${sd.missing.join(', ')}.` : '') + (S.solbErr ? ' ' + esc(S.solbErr) : '');
    const minis = [['Trades', String(a.trades.length)], ['Win rate', a.trades.length ? Math.round(a.wins / a.trades.length * 100) + '%' : '–'], ['Swap costs', a.fees.toFixed(3) + ' SOL'], ['Max drop', pct(a.mdd)]];
    const held = a.open ? a.open.sym : null;
    const rows = b.rows.map((r, i) => `<tr${r.sym === held ? ' class="open"' : ''}><td class="n">${r.elig ? elig.indexOf(r) + 1 : ''}</td><td><b>${r.sym}</b>${r.sym === held ? ' <span class="pill in">held</span>' : ''}</td>
      <td class="n">$${pxF(sd.usdNow[r.sym])}</td><td class="n ${cls(r.g7)}">${isFinite(r.g7) ? spct(r.g7, 1) : '–'}</td><td class="n ${cls(r.g24)}">${isFinite(r.g24) ? spct(r.g24, 1) : '–'}</td>
      <td class="n">${nf0.format(r.dv)} SOL</td><td>${r.elig ? (i === 0 ? 'Leader' : 'Eligible') : 'Too thin'}</td></tr>`).join('');
    const tr = a.trades.slice().reverse().map(t => `<tr><td class="n">${fdt(t.entryT)}</td><td><b>${t.sym}</b></td><td class="n">${pxF(t.entryPx)}<div class="note">$${pxF(t.entryPx * sd.solAt(t.entryT))}</div></td>
      <td class="n">${fdt(t.exitT)}</td><td class="n">${pxF(t.exitPx)}<div class="note">$${pxF(t.exitPx * sd.solAt(t.exitT))}</div></td>
      <td class="n ${cls(t.net * 1000)}"><b>${ssol(t.net)}</b><div class="note">${spct(t.net / t.notional)}</div></td>
      <td style="white-space:normal;min-width:22ch">${esc(solbOut(t.whyOut))}${t.why ? `<details><summary>Why it bought</summary><p>${esc(t.why)}</p></details>` : ''}</td></tr>`).join('');
    el.innerHTML = `<div class="solb-top">
        <div><div class="label">Balance if swapped back to SOL now</div><div class="bal">${sol(a.bal)}</div>
          <div class="pnl ${cls(a.pnl * 1000)}">${ssol(a.pnl)} (${spct(a.pnl / SOLB_CFG.startEq)})</div>
          <div class="note" style="margin-top:4px">≈ $${nf2.format(a.bal * solNow)} at $${nf2.format(solNow)} per SOL.${isFinite(sd.solStart) ? ` The 10 SOL were worth ≈ $${nf2.format(10 * sd.solStart)} at the start.` : ''}</div></div>
        <div><div class="state">${state}</div>${spark(a.curve, 'var(--c-solb)', SOLB_CFG.startEq)}
          <div class="minis">${minis.map(m => `<div><div class="k">${m[0]}</div><div class="v">${m[1]}</div></div>`).join('')}</div></div>
      </div>
      <h3 style="margin:16px 0 6px">Solana meme coins by 7-day change against SOL</h3>
      <div class="tablewrap"><table><thead><tr><th class="n">#</th><th>Coin</th><th class="n">Price</th><th class="n">7 days vs SOL</th><th class="n">24 h vs SOL</th><th class="n">Hourly volume</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table></div>
      <p class="note">As of the hour ending ${ft(b.t + H1)} ET. Hourly volume is the median over the last 30 hours on Coinbase; a coin needs 50 SOL to count. In testing, switching coins every hour wiped out the 10 SOL within 6 months, so this bot only re-checks once a day.</p>
      ${a.trades.length ? `<h3 style="margin:16px 0 6px">Closed trades</h3><div class="tablewrap"><table><thead><tr><th class="n">Bought (ET)</th><th>Coin</th><th class="n">Buy, SOL</th><th class="n">Sold (ET)</th><th class="n">Sell, SOL</th><th class="n">P&amp;L</th><th>Why it sold</th></tr></thead><tbody>${tr}</tbody></table></div>` : ''}`;
  }

  // ---------- meme coin leaderboard (the Meme Coin Trader's view at the last daily close)
  function renderMeme(o) {
    const md = o.memeData;
    if (!md || !md.ready) {
      $('memeSub').textContent = S.src === 'coinbase' ? 'Loading meme coin prices from Coinbase…' : 'Meme coin prices come from Coinbase, which is not reachable right now.';
      $('memeTable').innerHTML = '';
      return;
    }
    const b = md.board, a = o.acc && o.acc.meme, held = a && a.open ? a.open.sym : null;
    const cands = b.rows.filter(r => r.cand);
    $('memeSub').innerHTML = `The ${MEME_COINS.length} Coinbase meme coins at the ${F.md.format(new Date((b.t + DAY) * 1000))} daily close (${ft(b.t + DAY)} ET). The Meme Coin Trader holds the top candidate while BTC is above its 50-day average: <b>${b.btcOk ? 'yes' : 'no'}</b> ($${nf0.format(b.btcClose)} vs $${nf0.format(b.btcAvg)}). A candidate is up over 30 days, closed above its 20-day average, and has 30+ days of history and a $1M+ median daily volume.`
      + (md.missing.length ? ` Not loaded yet: ${md.missing.join(', ')}.` : '') + (S.memeErr ? ' ' + esc(S.memeErr) : '');
    const st = r => !r.elig ? 'Too new or too thin' : r.cand ? 'Candidate' : !(r.gain > 0) ? 'Down over 30 days' : 'Under its 20-day avg';
    const vol = v => !(v > 0) ? '–' : v >= 1e6 ? '$' + (v / 1e6).toFixed(1) + 'M' : '$' + nf0.format(v / 1e3) + 'K';
    const rows = b.rows.map(r => `<tr${r.sym === held ? ' class="open"' : ''}><td class="n">${r.cand ? cands.indexOf(r) + 1 : ''}</td><td><b>${r.sym}</b>${r.sym === held ? ' <span class="pill in">held</span>' : ''}</td>
      <td class="n">$${pxF(r.c)}</td><td class="n ${cls(r.gain)}">${isFinite(r.gain) ? spct(r.gain, 1) : '–'}</td><td class="n ${cls(r.c / r.avg - 1)}">${isFinite(r.avg) ? spct(r.c / r.avg - 1, 1) : '–'}</td>
      <td class="n">${vol(r.dv)}</td><td>${st(r)}</td></tr>`).join('');
    $('memeTable').innerHTML = `<table><thead><tr><th class="n">#</th><th>Coin</th><th class="n">Close</th><th class="n">30-day gain</th><th class="n">vs 20-day avg</th><th class="n">Daily volume</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>
      <p class="note">${b.btcOk ? (cands.length ? `If nothing changes, the bot holds ${cands[0].sym}. ` : 'No candidates, so the bot is in cash. ') : 'BTC is under its 50-day average, so the bot is in cash whatever the leaderboard says. '}Meme coins can halve in days: in testing this bot lost 83% from its peak once before recovering.</p>`;
  }

  // ---------- price chart with every bot's trades
  function tradeChart(el, cfg) {
    const W = Math.max(300, Math.floor(el.clientWidth || el.parentElement.clientWidth || 640));
    const H = cfg.height || 340, padL = 66, padR = 14, padT = 18, padB = 26;
    const { x0, x1 } = cfg;
    const cs = cfg.candles.filter(r => r[0] + M5 > x0 && r[0] <= x1);
    if (!cs.length) { el.innerHTML = '<div class="empty">No price data yet.</div>'; return; }
    const vals = [];
    for (const r of cs) vals.push(r[2], r[3]);
    for (const m of cfg.markers) if (m.t >= x0 && m.t <= x1) vals.push(m.v);
    for (const h of cfg.hlines) if (h.inRange !== false) vals.push(h.v);
    let y0 = Math.min(...vals), y1 = Math.max(...vals);
    const pad = (y1 - y0) * 0.12 || y1 * 0.002;
    y0 -= pad; y1 += pad;
    const sx = t => padL + (t - x0) / (x1 - x0) * (W - padL - padR);
    const sy = v => padT + (1 - (v - y0) / (y1 - y0)) * (H - padT - padB);
    const cw = (W - padL - padR) * M5 / (x1 - x0);
    const candles = cw >= 3;
    let g = '';
    for (const v of niceTicks(y0, y1, 5)) {
      const y = sy(v);
      g += `<line x1="${padL}" x2="${W - padR}" y1="${y}" y2="${y}" style="stroke:var(--line-2)"/>`;
      g += `<text x="${padL - 8}" y="${y + 4}" text-anchor="end" style="fill:var(--muted);font:11px var(--font-num)">$${nf0.format(v)}</text>`;
    }
    for (const tk of timeTicks(x0, x1, W)) {
      const x = sx(tk.t);
      if (x < padL || x > W - padR) continue;
      g += `<line x1="${x}" x2="${x}" y1="${padT}" y2="${H - padB}" style="stroke:var(--line-2)${tk.strong ? '' : ';stroke-dasharray:2 3'}"/>`;
      g += `<text x="${x}" y="${H - 8}" text-anchor="middle" style="fill:var(--muted);font:11px var(--font-body)">${esc(tk.lab)}</text>`;
    }
    for (const v of cfg.vlines) {
      if (v.t < x0 || v.t > x1) continue;
      const x = sx(v.t);
      g += `<line x1="${x}" x2="${x}" y1="${padT}" y2="${H - padB}" style="stroke:var(--ink);stroke-dasharray:4 3;opacity:.45"/>`;
      g += `<text x="${x + 5}" y="${H - padB - 6}" style="fill:var(--muted);font:600 11px var(--font-body)">${esc(v.label)}</text>`;
    }
    let hlab = ''; // line labels go on top of the price, with a halo so the price line can't hide them
    for (const h of cfg.hlines) {
      const y = sy(h.v);
      if (y < padT - 1 || y > H - padB + 1) continue;
      g += `<line x1="${padL}" x2="${W - padR}" y1="${y}" y2="${y}" style="stroke:${h.color};stroke-width:1.3;stroke-dasharray:6 4;opacity:${h.dim ? .45 : .85}"/>`;
      hlab += `<text x="${W - padR - 4}" y="${y - 5}" text-anchor="end" style="fill:${h.color};font:600 11px var(--font-body);opacity:${h.dim ? .8 : 1};paint-order:stroke;stroke:var(--panel);stroke-width:3px;stroke-linejoin:round">${esc(h.label)}</text>`;
    }
    if (candles) {
      const bw = Math.max(1.2, cw * 0.62);
      for (const r of cs) {
        const xc = sx(r[0] + M5 / 2);
        const col = r[4] >= r[1] ? 'var(--gain)' : 'var(--loss)';
        g += `<line x1="${xc}" x2="${xc}" y1="${sy(r[2])}" y2="${sy(r[3])}" style="stroke:${col};stroke-width:1;opacity:.7"/>`;
        const yt = sy(Math.max(r[1], r[4])), yb = sy(Math.min(r[1], r[4]));
        g += `<rect x="${xc - bw / 2}" y="${yt}" width="${bw}" height="${Math.max(1, yb - yt)}" style="fill:${col};opacity:.7"/>`;
      }
    } else {
      let d = '';
      cs.forEach((r, k) => { d += (k ? 'L' : 'M') + sx(Math.min(r[0] + M5, x1)).toFixed(1) + ' ' + sy(r[4]).toFixed(1); });
      g += `<path d="${d}L${sx(Math.min(cs[cs.length - 1][0] + M5, x1)).toFixed(1)} ${H - padB}L${sx(Math.min(cs[0][0] + M5, x1)).toFixed(1)} ${H - padB}Z" style="fill:var(--ink);opacity:.06;stroke:none"/>`;
      g += `<path d="${d}" style="fill:none;stroke:var(--ink);stroke-width:1.4;stroke-linejoin:round"/>`;
    }
    for (const k of cfg.links) {
      if (k.t1 < x0 || k.t0 > x1) continue;
      const xa = sx(Math.max(k.t0, x0)), xb = sx(Math.min(k.t1, x1));
      g += `<line x1="${xa}" x2="${xb}" y1="${sy(k.v0)}" y2="${sy(k.v1)}" style="stroke:${k.color};stroke-width:2;stroke-dasharray:${k.open ? '6 4' : '3 3'};opacity:.95"/>`;
      if (k.label) g += `<text x="${xb - 4}" y="${sy(k.v1) - 6}" text-anchor="end" style="fill:${k.color};font:600 11px var(--font-body)">${esc(k.label)}</text>`;
    }
    const mpos = [];
    cfg.markers.forEach((m, i) => {
      if (m.t < x0 || m.t > x1) return;
      const x = sx(m.t), y = sy(m.v), s = 7;
      const d = m.buy ? `M${x} ${y + 2}l${-s} ${s * 1.6}h${2 * s}z` : `M${x} ${y - 2}l${-s} ${-s * 1.6}h${2 * s}z`;
      g += `<path d="${d}" style="fill:${m.color};stroke:var(--panel);stroke-width:1.5"/>`;
      if (m.count > 1) g += `<text x="${x + s + 3}" y="${m.buy ? y + s * 1.6 + 1 : y - s * 0.7}" style="fill:var(--ink);font:700 11px var(--font-num)">${m.count}</text>`;
      mpos.push({ i, x, y: m.buy ? y + s : y - s });
    });
    g += hlab;
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="BTC price with every bot's buys and sells">${g}<line class="xh" x1="0" x2="0" y1="${padT}" y2="${H - padB}" style="stroke:var(--muted);stroke-width:1;opacity:0"/></svg><div class="tip" hidden></div>`;
    const svg = el.querySelector('svg'), tip = el.querySelector('.tip'), xh = el.querySelector('.xh');
    const show = ev => {
      const r = svg.getBoundingClientRect();
      const px = (ev.clientX - r.left) * (W / r.width), py = (ev.clientY - r.top) * (H / r.height);
      if (px < padL || px > W - padR) return hide();
      let best = null, bd = 16;
      for (const p of mpos) { const d = Math.hypot(p.x - px, p.y - py); if (d < bd) { bd = d; best = p; } }
      let html;
      if (best) {
        const m = cfg.markers[best.i];
        html = `<div class="note">${esc(fdt(m.time))} · ${m.buy ? 'buy' : 'sell'}${m.count > 1 ? ` · ${m.count} trades` : ''}</div>` + m.lines.map(L => `<div><span style="color:${L.color}">●</span> ${esc(L.text)}</div>`).join('');
        xh.style.opacity = 0;
      } else {
        const t = x0 + (px - padL) / (W - padL - padR) * (x1 - x0);
        let c = cs[0];
        for (const q of cs) if (Math.abs(q[0] + M5 / 2 - t) < Math.abs(c[0] + M5 / 2 - t)) c = q;
        html = `<div class="note">${esc(fdt(c[0]))} candle</div><div class="num">O $${nf2.format(c[1])} · H $${nf2.format(c[2])}</div><div class="num">L $${nf2.format(c[3])} · C $${nf2.format(c[4])}</div>`;
        xh.setAttribute('x1', sx(c[0] + M5 / 2)); xh.setAttribute('x2', sx(c[0] + M5 / 2)); xh.style.opacity = .5;
      }
      tip.innerHTML = html;
      tip.hidden = false;
      tip.style.left = Math.min(r.width - tip.offsetWidth - 4, Math.max(4, ev.clientX - r.left + 12)) + 'px';
      tip.style.top = '8px';
    };
    const hide = () => { tip.hidden = true; xh.style.opacity = 0; };
    svg.addEventListener('pointermove', show);
    svg.addEventListener('pointerdown', show);
    svg.addEventListener('pointerleave', hide);
  }

  function renderPriceChart(o) {
    const now = o.now;
    const span = { '12h': 12 * 3600, '2d': 2 * DAY, '7d': 7 * DAY }[S.win];
    const x0 = S.win === 'all' ? Math.min(START - 3 * 3600, now - 6 * 3600) : now - span;
    const candles = S.m5.filter(r => r[0] <= now).map(r => r.slice());
    if (candles.length && isFinite(o.price)) {
      const last = candles[candles.length - 1];
      if (last[0] + M5 > now) { last[4] = o.price; last[2] = Math.max(last[2], o.price); last[3] = Math.min(last[3], o.price); }
    }
    const one = S.pxBot !== 'all' && BOT[S.pxBot] && !BOT[S.pxBot].meme ? BOT[S.pxBot] : null;
    const sel = one ? [one] : BOTS.filter(b => !b.meme); // meme coin trades don't belong on the BTC chart
    const evs = [];
    if (o.acc) for (const b of sel) {
      const a = o.acc[b.id];
      const off = b.id === 'hold' ? 0 : M5 / 2;
      const tag = (t) => (b.id === 'combo' && t.part) ? ` (${t.part === 'futb' ? 'futures half' : 'swing half'})` : (b.id === 'multi' && t.sleeve != null) ? ` (${SPEEDS[t.sleeve]}-day)` : ((b.id === 'volman' || b.id === 'committee') && t.sleeve != null ? ` (${LAB_DESC[b.id][t.sleeve]})` : '');
      for (const t of a.trades) {
        evs.push({ t: t.entryT + off, when: t.entryT, v: t.entryPx, side: 'buy', b, text: `${b.name}${tag(t)}: bought ${btc(t.qty)} BTC at $${nf2.format(t.entryPx)}` });
        evs.push({ t: t.exitT + M5 / 2, when: t.exitT, v: t.exitPx, side: 'sell', b, text: `${b.name}${tag(t)}: sold at $${nf2.format(t.exitPx)}, ${susd(t.net)} (${reasonOf(b.id, t)})` });
      }
      for (const op of a.opens) evs.push({ t: op.entryT + off, when: op.entryT, v: op.entryPx, side: 'buy', b, text: `${b.name}${tag(op)}: bought ${btc(op.qty)} BTC at $${nf2.format(op.entryPx)}, still holding` });
    }
    const groups = new Map();
    for (const e of evs) {
      const k = e.side + ':' + Math.floor(e.when / M5);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(e);
    }
    const markers = [...groups.values()].map(gr => ({
      t: gr[0].t, time: gr[0].when, v: gr.reduce((x, e) => x + e.v, 0) / gr.length, buy: gr[0].side === 'buy', count: gr.length,
      color: new Set(gr.map(e => e.b.id)).size === 1 ? gr[0].b.color : 'var(--ink)',
      lines: gr.map(e => ({ color: e.b.color, text: e.text })),
    }));
    const links = [];
    const hl = [];
    if (one && o.acc) {
      const a = o.acc[one.id];
      const off = one.id === 'hold' ? 0 : M5 / 2;
      for (const t of a.trades) links.push({ t0: t.entryT + off, v0: t.entryPx, t1: t.exitT + M5 / 2, v1: t.exitPx, color: t.net >= 0 ? 'var(--gain)' : 'var(--loss)' });
      for (const op of a.opens) links.push({ t0: op.entryT + off, v0: op.entryPx, t1: now, v1: op.entryPx, color: one.color, open: true, label: `Bought at $${nf2.format(op.entryPx)}` });
      if (one.id === 'lev' && a.open && isFinite(a.open.liqPx)) hl.push({ v: a.open.liqPx, color: 'var(--loss)', label: `Liquidation $${nf0.format(a.open.liqPx)}`, inRange: false });
    }
    const pl = o.planToday;
    if (o.started && pl && (!one || one.id === 'day')) hl.push({ v: pl.trig, color: 'var(--c-day)', label: `Day trigger $${nf0.format(pl.trig)}${pl.trendOk ? '' : ' (off today)'}`, dim: !pl.trendOk, inRange: pl.trendOk });
    const avg = o.started ? o.snap.sma50 : o.prov.sma50;
    if (isFinite(avg) && (!one || ['swing', 'half', 'lev', 'weekly', 'combo'].includes(one.id))) hl.push({ v: avg, color: 'var(--c-swing)', label: `50-day avg $${nf0.format(avg)}`, inRange: Math.abs(avg / o.price - 1) < 0.06 });
    if (one && one.id === 'mtf' && isFinite(o.mtf.hAvg)) {
      const bl = o.mtf.hAvg * (1 + ENGINE.MTF.band), sl = o.mtf.hAvg * (1 - ENGINE.MTF.band);
      hl.push({ v: bl, color: 'var(--c-mtf)', label: `1h buy line $${nf0.format(bl)}`, inRange: Math.abs(bl / o.price - 1) < 0.05 });
      hl.push({ v: sl, color: 'var(--c-mtf)', label: `1h sell line $${nf0.format(sl)}`, dim: true, inRange: Math.abs(sl / o.price - 1) < 0.05 });
    }
    if (one && (one.id === 'futb' || one.id === 'combo') && o.futPlan && isFinite(o.futPlan.trigger)) {
      const tr = o.futPlan.trigger;
      hl.push({ v: tr, color: 'var(--c-futb)', label: `Breakout trigger $${nf0.format(tr)}`, inRange: Math.abs(tr / o.price - 1) < 0.05 });
      const ao = o.acc && o.acc[one.id] && (one.id === 'futb' ? o.acc.futb.open : o.acc.combo.opens.find(op => op.part === 'futb'));
      if (ao && isFinite(ao.stop)) hl.push({ v: ao.stop, color: 'var(--loss)', label: `Stop $${nf0.format(ao.stop)}`, inRange: true });
    }
    const vl = one && one.id === 'mtf' ? [{ t: MTF_START, label: '1h/15m start' }] : one && one.id === 'futb' ? [{ t: FUTB_START, label: 'Futures start' }]
      : one && one.id === 'combo' ? [{ t: COMBO_START, label: 'Combo start' }] : [{ t: START, label: 'Start' }];
    tradeChart($('pxChart'), { candles, x0, x1: now, markers, links, hlines: hl, vlines: vl, height: 340 });
    const nTr = evs.length;
    $('pxLegend').innerHTML = (one ? `<span style="--bc:${one.color}"><i></i>${one.name}: ${o.acc ? o.acc[one.id].trades.length : 0} closed trades, ${o.acc ? o.acc[one.id].opens.length : 0} open</span><span style="--bc:var(--gain)"><i class="dash"></i>closed at a profit</span><span style="--bc:var(--loss)"><i class="dash"></i>closed at a loss</span>`
      : `<span>▲ buy · ▼ sell · a number = that many trades in the same 5 minutes</span><span>${nTr} buys and sells so far</span>`)
      + (hl.length ? hl.map(h => `<span style="--bc:${h.color}"><i class="dash"></i>${esc(h.label.replace(/ \$[\d,]+.*$/, ''))}</span>`).join('') : '');
  }

  function renderEquity(o) {
    if (!o.acc) {
      $('eqChart').innerHTML = `<div class="empty">Balances start moving at ${ft(START)} ET. Until then every bot sits at $8,000.00.</div>`;
      $('eqLegend').innerHTML = '';
      return;
    }
    lineChart($('eqChart'), {
      series: (S.eqSet === 'lab' ? LABS : ['old', 'hold', 'day', 'multi', 'lev', 'half', 'mtf', 'futb', 'swing', 'meme', 'combo'].map(id => BOT[id])).map(b => ({ name: b.name, pts: o.acc[b.id].curve, color: b.color, endDot: true, width: b.id === 'swing' || b.id === 'combo' ? 2.4 : 1.7 })),
      hlines: [{ v: START_EQ, color: 'var(--muted)', label: '$8,000 start', dim: true }],
      x0: START, x1: o.now, yFmt: v => usd0(v), tipFmt: v => usd(v), aria: 'Balance of each bot since the start', height: 260,
    });
    $('eqLegend').innerHTML = (S.eqSet === 'lab' ? LABS : CORE).map(b => `<span style="--bc:${b.color}"><i></i>${b.name}</span>`).join('');
  }

  function renderDaily(o) {
    if (!o.acc) { $('dailyTable').innerHTML = `<div class="empty">The first day row appears at ${ft(START)} ET.</div>`; return; }
    const days = new Map();
    for (const b of CORE) {
      let prev = START_EQ, lastKey = null;
      const ends = new Map();
      for (const [t, v] of o.acc[b.id].curve) { if (t <= START) continue; ends.set(etKey(t - 1), v); }
      for (const [k, v] of ends) {
        if (!days.has(k)) days.set(k, {});
        days.get(k)[b.id] = v - prev; prev = v; lastKey = k;
      }
    }
    const keys = [...days.keys()].sort().reverse();
    const tot = Object.fromEntries(CORE.map(b => [b.id, o.acc[b.id].balance - START_EQ]));
    const green = Object.fromEntries(CORE.map(b => [b.id, keys.filter(k => (days.get(k)[b.id] || 0) > 0.004).length]));
    const head = `<tr><th>Day</th>${CORE.map(b => `<th class="n"><span class="botchip" style="--bc:${b.color}"><i></i>${b.name.split(' ')[0]}</span></th>`).join('')}</tr>`;
    const body = keys.map(k => {
      const d = new Date(k + 'T12:00:00');
      const lab = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) + (k === etKey(o.now) ? ' (today)' : '');
      return `<tr><td>${lab}</td>${CORE.map(b => { const v = days.get(k)[b.id] || 0; return `<td class="n ${cls(v)}">${susd(v)}</td>`; }).join('')}</tr>`;
    }).join('');
    const foot = `<tr><td><b>Total (if closed now)</b></td>${CORE.map(b => `<td class="n ${cls(tot[b.id])}"><b>${susd(tot[b.id])}</b></td>`).join('')}</tr>
      <tr><td class="note">Green days</td>${CORE.map(b => `<td class="n note">${green[b.id]} of ${keys.length}</td>`).join('')}</tr>`;
    $('dailyTable').innerHTML = `<table><thead>${head}</thead><tbody>${body}${foot}</tbody></table>`;
  }

  function renderScore(o) {
    if (!o.acc) { $('scoreTable').innerHTML = `<div class="empty">Scores fill in after the start.</div>`; return; }
    const A = o.acc;
    const rows = [
      ['Balance if closed now', b => usd(A[b].balance)],
      ['Profit / loss', b => `<span class="${cls(A[b].pnl)}">${susd(A[b].pnl)}</span>`],
      ['Realized (closed trades)', b => `<span class="${cls(A[b].realized)}">${susd(A[b].realized)}</span>`],
      ['Unrealized (open trade)', b => A[b].open ? `<span class="${cls(A[b].unreal)}">${susd(A[b].unreal)}</span>` : '–'],
      ['Closed trades', b => String(A[b].trades.length)],
      ['Win rate', b => A[b].trades.length ? Math.round(A[b].winRate * 100) + '%' : '–'],
      ['Average win', b => isFinite(A[b].avgWin) ? susd(A[b].avgWin) : '–'],
      ['Average loss', b => isFinite(A[b].avgLoss) ? susd(A[b].avgLoss) : '–'],
      ['Profit factor', b => isFinite(A[b].pf) ? A[b].pf.toFixed(2) : (A[b].pf === Infinity ? '∞' : '–')],
      ['Before fees', b => `<span class="${cls(A[b].gross)}">${susd(A[b].gross)}</span>`],
      ['Fees paid', b => usd(A[b].fees)],
      ['Max drop from peak', b => pct(A[b].mdd)],
      ['Time in the market', b => Math.round(A[b].exposure * 100) + '%'],
      ['BTC exposure now', b => Math.round(A[b].posVal / A[b].balance * 100) + '%' + (b === 'meme' ? `<div class="note">${A[b].open ? A[b].open.sym + ', not BTC' : 'meme coins'}</div>` : '')],
      ['Fee now (sell side)', b => (A[b].taker * 100).toFixed(2) + '%' + (b === 'futb' ? '<div class="note">futures</div>' : b === 'combo' ? `<div class="note">spot half${o.fee.kind === 'kraken' ? `, tier ${A[b].tier.tier + 1}` : ''}; futures 0.05%</div>` : o.fee.kind === 'kraken' ? `<div class="note">tier ${A[b].tier.tier + 1}</div>` : '')],
    ];
    $('scoreTable').innerHTML = `<table><thead><tr><th></th>${CORE.map(b => `<th class="n"><span class="botchip" style="--bc:${b.color}"><i></i>${b.name.split(' ')[0]}</span></th>`).join('')}</tr></thead>
      <tbody>${rows.map(r => `<tr><td>${r[0]}</td>${CORE.map(b => `<td class="n">${r[1](b.id)}</td>`).join('')}</tr>`).join('')}</tbody></table>
      <p class="note" style="margin:8px 2px 0">"Max drop" uses the live value of open positions. "Fee now" is the Kraken Pro taker fee for that bot's own 30-day trading volume. The Futures Breakout, and the Combo's futures half, pay a flat 0.05% futures fee per side and ignore the fee buttons. The Meme Coin Trader always pays Kraken's taker tiers plus 0.15% slippage, and its max drop uses daily closes.</p>`;
  }

  // ======================================================================= render: strategy lab
  function renderLab(o) {
    const RL = RESEARCH.labBots || {};
    const rows = LABS.map(b => {
      const a = o.acc && o.acc[b.id];
      const want = o.labNow[b.id];
      const nOn = want.filter(v => v > 0.5).length, nSl = want.length;
      let pill, text;
      if (!o.started || !a) {
        pill = ['wait', `Starts ${ft(START)} ET`];
        text = nSl > 1 ? `Signal now: ${nOn} of ${nSl} quarters would buy at the start.` : want[0] > 0.5 ? 'Signal now: on. It would buy at the start.' : want[0] < 0.5 ? 'Signal now: off. It would wait in cash.' : 'Not enough history yet.';
      } else {
        const nIn = a.opens.length;
        const buys = a.pendings.filter(p => p.side === 'buy').length, sells = a.pendings.filter(p => p.side === 'sell').length;
        pill = nIn ? ['in', nSl > 1 ? `${nIn} of ${nSl} in` : 'In a trade'] : buys ? ['wait', 'Buy order waiting'] : ['off', 'In cash'];
        text = nIn ? `Holding since ${fdt(a.opens[0].entryT)}.` : 'Waiting for its signal.';
        if (buys) text += ` ${buys} limit buy${buys > 1 ? 's' : ''} working.`;
        if (sells) text += ` ${sells} limit sell${sells > 1 ? 's' : ''} working.`;
      }
      const bal = a ? a.balance : START_EQ, pnl = a ? a.pnl : 0;
      const bt = RL[b.id];
      const btCell = bt ? `<span class="${cls(bt.test_ret)}">${bt.test_ret > 0 ? '+' : bt.test_ret < 0 ? MINUS : ''}${Math.abs(bt.test_ret).toFixed(1)}%</span><div class="note">2020\u201324: ${bt.dev_ret > 0 ? '+' : MINUS}${nf0.format(Math.abs(bt.dev_ret))}%</div>` : '\u2013';
      return `<tr><td><span class="botchip" style="--bc:${b.color}"><i></i>${b.name}</span><div class="note" style="max-width:34ch;white-space:normal">${LAB_IDEA[b.id]}</div></td>
        <td><span class="pill ${pill[0]}">${esc(pill[1])}</span><div class="note" style="max-width:26ch;white-space:normal;margin-top:4px">${text}</div></td>
        <td class="n">${usd(bal)}</td><td class="n ${cls(pnl)}"><b>${susd(pnl)}</b><div class="note">${spct(pnl / START_EQ)}</div></td>
        <td class="n">${a ? a.trades.length : 0}</td><td class="n">${a ? usd(a.fees) : '$0.00'}</td><td class="n">${a ? pct(a.mdd) : '0.0%'}</td><td class="n">${btCell}</td></tr>`;
    }).join('');
    $('labTable').innerHTML = `<table><thead><tr><th>Bot and rule</th><th>Now</th><th class="n">Balance if closed now</th><th class="n">P&amp;L</th><th class="n">Trades</th><th class="n">Fees</th><th class="n">Max drop</th><th class="n">Backtest 2025\u201326</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  // ======================================================================= render: trades
  function fillNote(bot, t, side) {
    if (bot === 'meme') return 'daily open, market';
    if (bot === 'combo') bot = t.part === 'futb' ? 'futb' : 'swing';
    if (bot === 'hold') return 'at the daily open';
    if (side === 'out' && t.reason === 'liquidated') return 'forced sale';
    if (SLEEVE_BOTS.has(bot)) return (side === 'in' ? t.limitEntry : t.makerExit) ? 'limit order (maker fee)' : "market, limit didn't fill";
    if (side === 'in') return bot === 'day' ? 'within candle' : 'at candle open';
    if (t.reason === 'stop' || t.reason === 'target') return 'within candle';
    return 'at candle close';
  }
  function renderTrades(o) {
    $('tradeFilters').innerHTML = [{ id: 'all', name: 'All bots', color: 'var(--muted)' }, ...BOTS].map(b =>
      `<button data-f="${b.id}" aria-pressed="${S.filter === b.id}" style="--bc:${b.color}"><i></i>${b.name}</button>`).join('');
    if (!o.acc) { $('tradeTable').innerHTML = `<div class="empty">No trades yet. The log starts at ${ft(START)} ET.</div>`; return; }
    const rows = [];
    for (const b of BOTS) {
      if (S.filter !== 'all' && S.filter !== b.id) continue;
      const a = o.acc[b.id];
      for (const op of a.opens) rows.push({ b, open: true, t: { entryT: op.entryT, entryPx: op.entryPx, qty: op.qty, fees: op.entryFee, net: a.opens.length === 1 ? a.unreal : op.unreal, notional: op.notional, why: op.why, limitEntry: op.limitEntry, sleeve: op.sleeve, part: op.part, sym: op.sym, pxNow: op.pxNow } });
      for (const t of a.trades) rows.push({ b, open: false, t });
    }
    rows.sort((x, y) => (y.open - x.open) || (y.t.exitT || y.t.entryT) - (x.t.exitT || x.t.entryT));
    const sig = rows.length + ':' + rows.map(r => (r.open ? 'o' : '') + r.t.entryT + '-' + (r.t.exitT || '') + ':' + r.t.net.toFixed(2)).join('|');
    if (sig === S.tradeSig && $('tradeTable').firstChild) return;
    S.tradeSig = sig;
    if (!rows.length) { $('tradeTable').innerHTML = `<div class="empty">No trades yet for this selection.</div>`; return; }
    const MAX = 300;
    const shown = rows.slice(0, MAX);
    const body = shown.map(({ b, open, t }) => { const mm = b.id === 'meme', pf = v => mm ? pxF(v) : nf2.format(v); return `<tr class="${open ? 'open' : ''}">
      <td><span class="botchip" style="--bc:${b.color}"><i></i>${b.name}</span>${mm ? `<div class="note">${t.sym}</div>` : partOf(b.id, t) ? `<div class="note">${partOf(b.id, t)}</div>` : b.id === 'multi' && t.sleeve != null ? `<div class="note">${SPEEDS[t.sleeve]}-day speed</div>` : (b.id === 'volman' || b.id === 'committee') && t.sleeve != null ? `<div class="note">${LAB_DESC[b.id][t.sleeve]}</div>` : ''}</td>
      <td class="n">${fdt(t.entryT)}<div class="note">${fillNote(b.id, t, 'in')}</div></td>
      <td class="n">$${pf(t.entryPx)}</td>
      <td class="n">${open ? '<b>open</b>' : fdt(t.exitT) + `<div class="note">${fillNote(b.id, t, 'out')}</div>`}</td>
      <td class="n">${open ? '$' + (mm ? pxF(t.pxNow) : nf2.format(o.price)) + '<div class="note">now</div>' : '$' + pf(t.exitPx)}</td>
      <td class="n">${mm ? qtyF(t.qty) + ' ' + t.sym : btc(t.qty) + ' BTC'}<div class="note">${usd0(t.notional)}</div></td>
      <td class="n">${usd(t.fees)}</td>
      <td class="n ${cls(t.net)}"><b>${susd(t.net)}</b><div class="note">${spct(t.net / t.notional)}</div></td>
      <td>${open ? 'Open' : reasonOf(b.id, t)}</td>
      <td>${t.why ? `<details><summary>Why</summary><p>${esc(t.why)}</p></details>` : ''}</td></tr>`; }).join('');
    $('tradeTable').innerHTML = `<table><thead><tr><th>Bot</th><th class="n">Bought (ET)</th><th class="n">Buy price</th><th class="n">Sold (ET)</th><th class="n">Sell price</th><th class="n">Size</th><th class="n">Fees</th><th class="n">P&amp;L</th><th>Exit</th><th></th></tr></thead><tbody>${body}</tbody></table>
      ${rows.length > MAX ? `<p class="note">Showing the latest ${MAX} of ${rows.length} trades.</p>` : ''}
      <p class="note">Open-trade P&amp;L includes the estimated sell fee. Fees are both sides of the trade.</p>`;
  }

  // ======================================================================= render: research (static)
  function renderResearch() {
    const R = RESEARCH, P = R.periods;
    const fam = R.families;
    const dayVariants = sum(fam.map(f => f.variants));
    const sf = R.swingFamily;
    const row = (k, name, color) => {
      const d = P[k].dev, t = P[k].test;
      const c = v => v == null ? '–' : `<span class="${cls(v)}">${v > 0 ? '+' : v < 0 ? MINUS : ''}${nf0.format(Math.abs(v))}%</span>`;
      return `<tr><td><span class="botchip" style="--bc:${color}"><i></i>${name}</span></td><td class="n">${c(d['ret%'])}</td><td class="n">${pct(d['maxdd%'] / 100, 0)}</td><td class="n">${c(t['ret%'])}</td><td class="n">${pct(t['maxdd%'] / 100, 0)}</td><td class="n">${t.trades == null ? '–' : nf0.format(t.trades)}</td><td class="n">${t['avg_gross%'] == null ? '–' : (t['avg_gross%'] >= 0 ? '+' : MINUS) + Math.abs(t['avg_gross%']).toFixed(2) + '%'}</td><td class="n">${t['avg_fee%'] == null ? '–' : t['avg_fee%'].toFixed(2) + '%'}</td></tr>`;
    };
    const years = Object.keys(R.yearly.swing);
    const yr = (k, name, color) => `<tr><td><span class="botchip" style="--bc:${color}"><i></i>${name}</span></td>${years.map(y => { const v = R.yearly[k][y]; return `<td class="n ${cls(v)}">${v == null ? '–' : (v > 0 ? '+' : v < 0 ? MINUS : '') + nf0.format(Math.abs(v)) + '%'}</td>`; }).join('')}</tr>`;
    const econ = [['old', 'Old bot replica', 'var(--c-old)'], ['day', 'Breakout day trader', 'var(--c-day)'], ['swing', 'Trend swing', 'var(--c-swing)']];
    const maxAbs = Math.max(...econ.map(([k]) => Math.max(Math.abs(P[k].test['avg_gross%']), P[k].test['avg_fee%'])));
    const sc = v => Math.abs(v) / maxAbs * 46;
    const econRows = econ.map(([k, name]) => {
      const g = P[k].test['avg_gross%'], f = P[k].test['avg_fee%'], n = P[k].test['avg_net%'];
      return `<div class="r"><div>${name}</div><div class="track" aria-label="${name}: ${g.toFixed(2)}% before fees, ${f.toFixed(2)}% fees">
        <div class="seg-g" style="left:${g >= 0 ? 50 : 50 - sc(g)}%;width:${Math.max(.6, sc(g))}%;${g < 0 ? 'background:var(--loss)' : ''}"></div>
        <div class="seg-f" style="left:${50 - sc(f)}%;width:${sc(f)}%"></div></div>
        <div class="num ${cls(n)}" style="text-align:right">${n >= 0 ? '+' : MINUS}${Math.abs(n).toFixed(2)}%</div></div>`;
    }).join('');
    const M = R.mtf;
    const sg = v => `<span class="${cls(v)}">${v > 0 ? '+' : v < 0 ? MINUS : ''}${Math.abs(v).toFixed(1)}%</span>`;
    const sg0 = v => `<span class="${cls(v)}">${v > 0 ? '+' : v < 0 ? MINUS : ''}${nf0.format(Math.abs(v))}%</span>`;
    const famTable = (rows, head) => `<div class="tablewrap" style="margin-top:12px"><table><thead><tr><th>${head}</th><th class="n">Versions</th><th class="n">Median 2020–24</th><th class="n">Median 2025–26</th><th class="n">Best 2025–26</th><th class="n">Typical trades 2025–26</th></tr></thead>
      <tbody>${rows.map(x => `<tr><td>${esc(x.name)}</td><td class="n">${x.n}</td><td class="n">${sg0(x.dev_med)}</td><td class="n">${sg(x.test_med)}</td><td class="n">${sg(x.test_best)}</td><td class="n">${nf0.format(x.trades_med)}</td></tr>`).join('')}</tbody></table></div>`;
    const mtfPanel = !M ? '' : `
      <div class="panel">
        <div class="ph"><div><h2>1h/15m Trader: what testing found</h2><p>A bot that reads the 1-hour chart for direction and the 15-minute chart for timing. ${M.variants} versions were tested: 6 ways to read the 1-hour trend, 6 fifteen-minute entry signals, 3 exit styles and 2 order windows. The pick was made on 2020–24 only, before 2025–26 was looked at.</p></div></div>
        <div class="verdict">
          <div class="cell" style="--bc:var(--c-mtf)"><div class="big">${M.test_positive} of ${M.variants}</div><p>versions made money in 2025–26 after Kraken fees. ${M.test_gross_positive} would have before fees.</p></div>
          <div class="cell" style="--bc:var(--c-mtf)"><div class="big">${sg(M.pick.test.ret)} vs ${sg(P.hold.test['ret%'])}</div><p>the pick against buy-and-hold in 2025–26 (Trend Swing: ${sg(P.swing.test['ret%'])}). Before fees the pick made ${sg(M.pick.test.gross)}. Fees took $${nf0.format(M.pick.test.fees)} over ${M.pick.test.trades} trades.</p></div>
          <div class="cell" style="--bc:var(--c-mtf)"><div class="big">${sg0(M.pick.dev.ret)}</div><p>for the pick in 2020–24, against ${sg0(P.hold.dev['ret%'])} for buy-and-hold, with a ${pct(M.pick.dev.dd / 100, 0)} worst drop and ${sg(M.pick.dev.yearly['2022'])} in 2022.</p></div>
        </div>
        ${famTable(M.by.exit, 'Exit style')}
        ${famTable(M.by.trig, '15-minute entry signal')}
        <p class="note">The more a version traded, the more it lost: fees ate the edge every time. The pick checks every 15 minutes but holds a typical trade about ${Math.round(M.pick.test.median_hold_h / 24)} days, which is why it trades only about twice a month. 2025–26 was used once, after the pick, so the live record from its start is the real test.</p>
      </div>`;
    const B = R.big;
    const bigPanel = !B ? '' : `
      <div class="panel">
        <div class="ph"><div><h2>The ${nf0.format(B.variants)}-strategy search</h2><p>Every fast idea family on 5-minute to 1-hour charts, long and short, with futures costs: 0.05% per side, slippage, and funding. Rules had to make money on 2020–22, then again on 2023–24, before the survivors were run once on 2025–26. The thresholds were written down before the run. ${B.random} random strategies went through the same tests to show what luck alone looks like.</p></div></div>
        <div class="verdict">
          <div class="cell" style="--bc:var(--c-futb)"><div class="big">${B.s3} of ${nf0.format(B.variants)}</div><p>passed both 2020–22 and 2023–24, all the same idea: a once-a-day breakout, long only. ${B.random_pass} of ${B.random} random strategies passed.</p></div>
          <div class="cell" style="--bc:var(--c-futb)"><div class="big">${B.pick.t_mean >= 0 ? '+' : MINUS}${Math.abs(B.pick.t_mean).toFixed(2)}% a trade</div><p>for the best survivor in 2025–26, after +${B.pick.d_mean.toFixed(2)}% in 2020–22 and +${B.pick.v_mean.toFixed(2)}% in 2023–24. ${B.surv_t_pos} of ${B.s3} survivors stayed positive in 2025–26, barely.</p></div>
          <div class="cell" style="--bc:var(--c-futb)"><div class="big">${B.walk.filter(w => w.tot < 0).length} of ${B.walk.length}</div><p>ways of re-picking the best recent strategy every quarter lost money from 2022 to 2026. Past winners didn't keep winning.</p></div>
        </div>
        <div class="tablewrap" style="margin-top:12px"><table><thead><tr><th>Family</th><th class="n">Versions</th><th class="n">Made money 2020–22</th><th class="n">Passed 2020–22 test</th><th class="n">Also passed 2023–24</th></tr></thead>
        <tbody>${B.families.map(f => `<tr><td>${esc(f.family)}</td><td class="n">${nf0.format(f.variants)}</td><td class="n">${nf0.format(f.d_pos)}</td><td class="n">${f.s1}</td><td class="n">${f.s3}</td></tr>`).join('')}</tbody></table></div>
        <h3 style="margin:16px 0 6px">Futures Breakout by year</h3>
        <p class="note" style="margin:0 0 8px">The best survivor at 1.5x on $8,000 ($12,000 per trade, no compounding). ${nf0.format(B.futb.trades)} trades, about ${B.futb.per_month} a month, ${B.futb.win}% winners, average win $${nf0.format(B.futb.avg_win)}, average loss ${MINUS}$${nf0.format(Math.abs(B.futb.avg_loss))}, typical hold ${B.futb.hold_h} hours.</p>
        <div class="tablewrap"><table><thead><tr>${Object.keys(B.futb.yearly_15x).map(y => `<th class="n">${y}${y === '2026' ? '*' : ''}</th>`).join('')}</tr></thead>
        <tbody><tr>${Object.values(B.futb.yearly_15x).map(v => `<td class="n ${cls(v)}">${v > 0 ? '+' : v < 0 ? MINUS : ''}$${nf0.format(Math.abs(v))}</td>`).join('')}</tr></tbody></table></div>
        <p class="note">*2026 through Oct 16. It earned its spot on the dashboard by passing two separate tests, but 2025–26 says the edge has faded or is gone. Treat it as a live experiment, not a money machine. Compounded at 1.5x, $8,000 from January 2025 would be about $${nf0.format(B.futb.comp_2025_26)} now.</p>
      </div>`;
    const C = R.combo;
    const sgn = (v, d = 1) => `<span class="${cls(v)}">${v > 0 ? '+' : v < 0 ? MINUS : ''}${Math.abs(v).toFixed(d)}%</span>`;
    const sgnK = v => `<span class="${cls(v)}">${v > 0 ? '+' : v < 0 ? MINUS : ''}${nf0.format(Math.abs(v))}%</span>`;
    const comboPanel = !C ? '' : (() => {
      const row = id => C.rows.find(r => r.id === id);
      const cb = row('combo'), sw = row('swing'), fu = row('futb');
      const yrs = Object.keys(cb.years);
      const VERD = { kept: ['in', 'Kept'], rejected: ['off', 'Rejected'], mixed: ['wait', 'Mixed'], blocked: ['off', 'Not run'] };
      return `
      <div class="panel">
        <div class="ph"><div><h2>Mixing bots, and the other fixes tested</h2><p>After the big searches, ${C.methods.length} more known methods were tried to close the gap. One held up, hidden months included: running Trend Swing and the Futures Breakout side by side with half the money each. Over 2020 to 2026 it had a smoother ride than either part alone. That is the Combo 50/50 bot. The numbers below come from this page's own engine on 5-minute candles, same fees, $8,000 from Jan 1 2020.</p></div></div>
        <div class="verdict">
          <div class="cell" style="--bc:var(--c-combo)"><div class="big">${pct(cb.mdd / 100, 0)} vs ${pct(sw.mdd / 100, 0)}</div><p>worst drop of the Combo against Trend Swing alone (Futures Breakout alone: ${pct(fu.mdd / 100, 0)}). The two parts win on different days: daily correlation ${C.corr.toFixed(2)}.</p></div>
          <div class="cell" style="--bc:var(--c-combo)"><div class="big">${Math.round(cb.days_up)}% of days</div><p>ended in profit for the Combo, and ${Math.round(cb.months_up)}% of months. Nothing tested made money every day. Buy &amp; Hold, the most often green of these four, was up on ${Math.round(C.best_days_up)}% of days.</p></div>
          <div class="cell" style="--bc:var(--c-combo)"><div class="big">${sgn(cb.hidden)}</div><p>for the Combo in the hidden months (Apr 1 to Oct 16 2026), which no rule or setting was picked on. Trend Swing alone ${sgn(sw.hidden)}, Futures Breakout alone ${sgn(fu.hidden)}.</p></div>
        </div>
        <div class="tablewrap" style="margin-top:12px"><table><thead><tr><th>Bot</th><th class="n">Total</th><th class="n">Worst drop</th><th class="n">Sharpe</th><th class="n">Days up</th><th class="n">Months up</th><th class="n">Worst month</th>${yrs.map(y => `<th class="n">${y}${y === '2026' ? '*' : ''}</th>`).join('')}</tr></thead>
        <tbody>${C.rows.map(r => `<tr><td><span class="botchip" style="--bc:${r.color}"><i></i>${esc(r.name)}</span></td><td class="n">${sgnK(r.total)}</td><td class="n">${pct(r.mdd / 100, 0)}</td><td class="n">${r.sharpe.toFixed(2)}</td><td class="n">${Math.round(r.days_up)}%</td><td class="n">${Math.round(r.months_up)}%</td><td class="n">${sgn(r.worst_month, 0)}</td>${yrs.map(y => `<td class="n">${sgnK(r.years[y])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
        <p class="note">*2026 through Oct 16. Sharpe = average daily return divided by how much it swings, per year; higher means a smoother ride. Days up counts days that ended above the day before; days in cash count as not up.</p>
        <div class="chart" id="comboChart" style="margin-top:6px"></div>
        <div class="legend" style="margin-top:8px">${C.rows.map(r => `<span style="--bc:${r.color}"><i></i>${esc(r.name)}</span>`).join('')}</div>
        <h3 style="margin:16px 0 6px">Every fix tried in this round</h3>
        <div class="tablewrap"><table><thead><tr><th>Method</th><th>What happened</th><th>Verdict</th></tr></thead>
        <tbody>${C.methods.map(m => `<tr><td><b>${esc(m.name)}</b></td><td style="white-space:normal;min-width:30ch">${esc(m.result)}</td><td><span class="pill ${VERD[m.verdict][0]}">${VERD[m.verdict][1]}</span></td></tr>`).join('')}</tbody></table></div>
        <p class="note">${esc(C.note)}</p>
      </div>`;
    })();
    const MR = R.meme;
    const MDY = s => new Date(s + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const memePanel = !MR ? '' : (() => {
      const p = MR.pick, bw = MR.bench, yrs = Object.keys(p.years);
      const rowsT = [['Meme Coin Trader (the pick)', p, 'var(--c-meme)'], ['All meme coins, equal weight', bw.ew, 'var(--c-hold)'], ['DOGE, buy and hold', bw.doge, 'var(--c-day)'], ['BTC, buy and hold', bw.btc, 'var(--c-swing)']];
      return `
      <div class="panel">
        <div class="ph"><div><h2>Meme Coin Trader: what testing found</h2><p>${MR.variants} versions on Coinbase daily candles of the ${MEME_COINS.length} meme coins it can trade, with Kraken taker fees and 0.15% slippage on every order. The pick was the best of them on ${MDY(MR.periods.train[0])} to ${MDY(MR.periods.train[1])} only. ${MDY(MR.periods.hidden[0])} to ${MDY(MR.periods.hidden[1])} stayed hidden until the pick was fixed.</p></div></div>
        <div class="verdict">
          <div class="cell" style="--bc:var(--c-meme)"><div class="big">${sgn(p.hd)} vs ${sgn(bw.ew.hd)}</div><p>the pick in the hidden months against holding every meme coin equally (DOGE alone ${sgn(bw.doge.hd)}, BTC ${sgn(bw.btc.hd)}). It beat ${MR.nulls.beatHd} of ${MR.nulls.n} copies that bought a random meme coin on the same days.</p></div>
          <div class="cell" style="--bc:var(--c-meme)"><div class="big">${pct(p.hdMdd / 100, 0)}</div><p>worst drop inside the hidden months: from $${nf0.format(p.path.peak)} (${MDY(p.path.peakDate)}) down to $${nf0.format(p.path.trough)} (${MDY(p.path.troughDate)}), before one trade doubled it back. Long losing streaks are normal for this bot.</p></div>
          <div class="cell" style="--bc:var(--c-meme)"><div class="big">${p.wins} of ${p.trades}</div><p>trades made money. Winners averaged +${p.avgWin.toFixed(0)}%, losers ${p.avgLoss.toFixed(1)}%, typical hold ${p.holdDays} days. Its biggest runs: ${p.best.slice(0, 3).map(b => `${b[0]} +${b[3]}%`).join(', ')}. It was up on only ${Math.round(p.up)}% of days.</p></div>
        </div>
        <div class="tablewrap" style="margin-top:12px"><table><thead><tr><th>$8,000 from Jul 2021</th><th class="n">Training</th><th class="n">Hidden</th><th class="n">Total</th><th class="n">Worst drop</th>${yrs.map(y => `<th class="n">${y}${y === '2021' ? '†' : y === '2026' ? '*' : ''}</th>`).join('')}</tr></thead>
        <tbody>${rowsT.map(([n, q, c]) => `<tr><td><span class="botchip" style="--bc:${c}"><i></i>${n}</span></td><td class="n">${sgnK(q.tr)}</td><td class="n">${sgn(q.hd)}</td><td class="n">${sgnK(q.full)}</td><td class="n">${pct(q.mdd / 100, 0)}</td>${yrs.map(y => `<td class="n">${sgnK(q.years[y])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
        <p class="note">†Jul to Dec 2021. *2026 through Oct 18. Equal weight = every eligible meme coin, rebalanced monthly, same costs.</p>
        <div class="chart" id="memeChart" style="margin-top:6px"></div>
        <div class="legend" style="margin-top:8px">${rowsT.map(([n, , c]) => `<span style="--bc:${c}"><i></i>${n}</span>`).join('')}</div>
        <div class="two" style="margin-top:14px">
          <div><h3 style="margin:0 0 6px">Every family tested</h3>
            <div class="tablewrap"><table><thead><tr><th>Family</th><th class="n">Tried</th><th class="n">Up in training</th><th class="n">Up hidden</th><th class="n">Median hidden</th></tr></thead>
            <tbody>${MR.families.map(f => `<tr><td>${esc(f.name)}</td><td class="n">${f.n}</td><td class="n">${f.trPos}</td><td class="n">${f.hdPos}</td><td class="n">${sgn(f.hdMed)}</td></tr>`).join('')}</tbody></table></div></div>
          <div><h3 style="margin:0 0 6px">The best 6 on the training years</h3>
            <div class="tablewrap"><table><thead><tr><th>Rule</th><th class="n">Training</th><th class="n">Hidden</th><th class="n">Hidden drop</th></tr></thead>
            <tbody>${MR.top.map((t, i) => `<tr><td style="white-space:normal;min-width:24ch">${i === 0 ? '<b>Pick:</b> ' : ''}${esc(t[0])}</td><td class="n">${sgnK(t[1])}</td><td class="n">${sgn(t[3])}</td><td class="n">${pct(t[4] / 100, 0)}</td></tr>`).join('')}</tbody></table></div></div>
        </div>
        <p class="note">Only ${MR.families.reduce((s, f) => s + f.hdPos, 0)} of ${MR.variants} versions made money in the hidden months, and the typical one lost over half. The best hidden result (a breakout version, ${sgn(MR.families[1].hdBest, 0)}) ranked low on the training years, which is what luck looks like. The coins tested are the ones still listed today, so history flatters all of them. Picking coins by 30-day momentum and staying out when BTC's trend is down is what separated the pick from random coin picks with the same timing.</p>
      </div>`;
    })();
    const snPanel = `
      <div class="panel prose" style="max-width:none">
        <div class="ph"><div><h2>Meme Sniper: what the numbers say so far</h2><p>Your rules for new pump.fun coins, checked with the exact bonding-curve math the sniper uses. Paper only.</p></div></div>
        <div class="verdict">
          <div class="cell" style="--bc:var(--c-snipe)"><div class="big">~8%</div><p>lost by buying 1 SOL at $7K market cap and selling right back at the same price: pump.fun's 1.25% fee each way, 1% slippage and priority fees each way, and the bot's own price impact on the curve. So "sell when profitable" needs about a 10% bounce from the buy.</p></div>
          <div class="cell" style="--bc:var(--loss)"><div class="big">~$2.9K</div><p>is the lowest market cap a coin can have on the bonding curve (28 SOL: the launch price, when nobody holds any bought tokens). A stop at 10% of the buy can only trigger for buys above about $29K, or after a coin graduates to PumpSwap. Below that, a dying coin just sits near the floor.</p></div>
          <div class="cell" style="--bc:var(--l1)"><div class="big">7 bots</div><p>run live on the same coins in the Meme Sniper tab: your exact rules, and six versions that each change one thing (a 2 h or 30 min exit, a +25% target, a 55% dip, a bounce entry, stricter checks). Every coin they see is new to them, so the comparison is honest.</p></div>
        </div>
        <p class="note">The historical test (protocol written Oct 19, 6:35 PM ET, before any outcome was looked at: every pump.fun launch recorded live, rug checks taken at the $7K crossing, 1-minute candles, 60/40 training/hidden split) needs launch data pulled through your computer. It runs as soon as that link is back, and its results will appear here.</p>
      </div>`;
    const feeRow = (k, name) => R.fees[k].map((f, i) => `<tr>${i === 0 ? `<td rowspan="${R.fees[k].length}"><b>${name}</b></td>` : ''}<td>${f.level}</td><td class="n ${cls(f.dev)}">${f.dev > 0 ? '+' : f.dev < 0 ? MINUS : ''}${nf0.format(Math.abs(f.dev))}%</td><td class="n ${cls(f.test)}">${f.test > 0 ? '+' : f.test < 0 ? MINUS : ''}${Math.abs(f.test).toFixed(1)}%</td></tr>`).join('');
    $('research').innerHTML = `
    <div class="stack" style="margin-top:0">
      <div class="panel">
        <div class="ph"><div><h2>What the testing found</h2><p>${nf0.format(R.data.candles)} one-minute BTC candles (${R.data.from} to ${R.data.to}). Rules were chosen using ${R.data.dev} only, then checked on ${R.data.test}, which was kept out of the tuning.</p></div></div>
        <div class="verdict">
          <div class="cell" style="--bc:var(--c-day)"><div class="big">0 of ${dayVariants}</div><p>day-trading variants made money in 2025–26 after Kraken fees. None made money in 2020–24 either once fees followed Kraken's real tiers.</p></div>
          <div class="cell" style="--bc:var(--c-swing)"><div class="big">${P.swing.test['ret%'] > 0 ? '+' : MINUS}${Math.abs(P.swing.test['ret%']).toFixed(1)}% vs ${MINUS}${Math.abs(P.hold.test['ret%']).toFixed(1)}%</div><p>Trend Swing against buy-and-hold in 2025–26, with a ${pct(P.swing.test['maxdd%'] / 100, 0)} worst drop instead of ${pct(P.hold.test['maxdd%'] / 100, 0)}. In 2020–24: +${nf0.format(P.swing.dev['ret%'])}% vs +${nf0.format(P.hold.dev['ret%'])}%.</p></div>
          <div class="cell" style="--bc:var(--c-old)"><div class="big">${MINUS}100%</div><p>for a replica of the old bot in both periods: ${nf0.format(P.old.dev.trades)} trades in 2020–24, averaging ${P.old.test['avg_gross%'].toFixed(2)}% per trade before fees.</p></div>
        </div>
      </div>
${snPanel}
${memePanel}
${comboPanel}
${bigPanel}
${mtfPanel}

      <div class="panel">
        <div class="ph"><div><h2>Trend Swing v2: same signal, cheaper orders</h2><p>v1 bought and sold with market orders. v2 places a limit order at the daily close for 4 hours, then falls back to a market order. Limit orders pay Kraken's maker fee, about half the taker fee.</p></div></div>
        <div class="tablewrap"><table><thead><tr><th>Version</th><th class="n">2020\u201324</th><th class="n">Fees per round trip</th><th class="n">2025\u201326</th><th class="n">Worst drop</th><th class="n">Fees per round trip</th></tr></thead>
        <tbody>${[['v1, market orders', R.swingV1], ['v2, limit first', P.swing]].map(([n, q]) => `<tr><td>${n}</td><td class="n ${cls(q.dev['ret%'])}">${q.dev['ret%'] > 0 ? '+' : MINUS}${nf0.format(Math.abs(q.dev['ret%']))}%</td><td class="n">${q.dev['avg_fee%'].toFixed(2)}%</td><td class="n ${cls(q.test['ret%'])}">${q.test['ret%'] > 0 ? '+' : MINUS}${Math.abs(q.test['ret%']).toFixed(1)}%</td><td class="n">${pct(q.test['maxdd%'] / 100, 0)}</td><td class="n">${q.test['avg_fee%'].toFixed(2)}%</td></tr>`).join('')}</tbody></table></div>
        <p class="note">The change was chosen on 2020\u201324 only, and it helped at every setting tried. 2025\u201326 had already been used to test v1, so treat that column as supporting evidence. The clean test is the live record from the start time. A 50-day-average buffer was also tested and rejected: it helped in some settings and hurt in others.</p>
      </div>

      <div class="panel">
        <div class="ph"><div><h2>The three newest bots</h2><p>Designs fixed before testing, except the leverage method, which was picked on 2020\u201324 from three options (2x, 3x, volatility-based). "Ahead after 1 year" = share of all 1-year windows from 2020 to 2026 that ended above where they started.</p></div></div>
        <div class="tablewrap"><table><thead><tr><th>Bot</th><th class="n">2020\u201324</th><th class="n">Worst drop</th><th class="n">2025\u201326</th><th class="n">Worst drop</th><th class="n">Ahead after 1 year</th><th class="n">Worst 1-year</th></tr></thead>
        <tbody>${(R.newBots ? [['swing', 'Trend Swing', 'var(--c-swing)'], ['half', 'Half-Size Swing', 'var(--c-half)'], ['lev', 'Leveraged Swing', 'var(--c-lev)'], ['multi', 'Multi-Speed Trend', 'var(--c-multi)']] : []).map(([k, n, c]) => { const q = R.newBots[k]; const f = v => `<span class="${cls(v)}">${v > 0 ? '+' : v < 0 ? MINUS : ''}${nf0.format(Math.abs(v))}%</span>`; return `<tr><td><span class="botchip" style="--bc:${c}"><i></i>${n}</span></td><td class="n">${f(q.dev_ret)}</td><td class="n">${pct(q.dev_dd / 100, 0)}</td><td class="n">${f(q.test_ret)}</td><td class="n">${pct(q.test_dd / 100, 0)}</td><td class="n">${q.ahead_1y}%</td><td class="n">${pct(q.worst_1y / 100, 0)}</td></tr>`; }).join('')}</tbody></table></div>
        <p class="note">Leverage made 2020\u201324 spectacular and 2025\u201326 worse than not borrowing at all. Fixed 3x leverage was rejected: its worst drop was \u221295%. None of the versions tested was liquidated, but 3x came within a few percent of zero.</p>
      </div>

      <div class="panel">
        <div class="ph"><div><h2>Strategy lab: 10 textbook ideas</h2><p>Run exactly as designed, with no tuning. Kraken fees and limit-first orders, same as the main bots.</p></div></div>
        <div class="tablewrap"><table><thead><tr><th>Bot</th><th class="n">2020\u201324</th><th class="n">Worst drop</th><th class="n">2025\u201326</th><th class="n">Worst drop</th><th class="n">Trades 25\u201326</th><th class="n">Ahead after 1 year</th></tr></thead>
        <tbody>${LABS.map(b => { const q = (R.labBots || {})[b.id]; if (!q) return ''; const f = v => `<span class="${cls(v)}">${v > 0 ? '+' : v < 0 ? MINUS : ''}${nf0.format(Math.abs(v))}%</span>`; return `<tr><td><span class="botchip" style="--bc:${b.color}"><i></i>${b.name}</span></td><td class="n">${f(q.dev_ret)}</td><td class="n">${pct(q.dev_dd / 100, 0)}</td><td class="n">${f(q.test_ret)}</td><td class="n">${pct(q.test_dd / 100, 0)}</td><td class="n">${q.test_n}</td><td class="n">${q.ahead_1y}%</td></tr>`; }).join('')}</tbody></table></div>
        <p class="note">The trend ideas did great in the 2020\u201324 bull run and mostly lost in choppy 2025\u201326. The dip buyers (Bollinger, RSI-2) and the Chandelier did the opposite. With ${BOTS.length} bots running, expect a few to look brilliant for weeks by luck alone.</p>
      </div>

      <div class="two">
        <div class="panel prose">
          <h2>Why the old bot lost</h2>
          <ol class="steps">
            <li><b>Its entry signal had no edge.</b> Buying 5-minute breakouts averaged ${P.old.dev['avg_gross%'].toFixed(2)}% per trade before any fees across ${nf0.format(P.old.dev.trades)} historical trades. Better fee settings could not have saved it.</li>
            <li><b>Fees were bigger than its edge at every tier.</b> Even at Kraken's cheapest tier a round trip costs 0.36% in fees, six times the 0.06% it lost per trade before fees. As its balance shrank it fell into pricier tiers and the drain sped up.</li>
            <li><b>It traded constantly.</b> Around 240 trades a month multiplies that fee drag.</li>
            <li><b>The AI reviews never added a decision.</b> The AI saw sampled prices, chose WAIT 453 times, and produced no trades to measure.</li>
          </ol>
        </div>
        <div class="panel">
          <h2>Edge per trade vs fees per trade</h2>
          <p class="note" style="margin:4px 0 12px">2025–26 averages. Top bar: what the price move earned (green, right) or lost (red, left) before fees. Bottom bar: fees. Right: what was left after fees.</p>
          <div class="econ">${econRows}</div>
        </div>
      </div>

      <div class="panel">
        <div class="ph"><div><h2>Backtest: $8,000 from January 2020</h2><p>Log scale. Weekly balances, Kraken Pro fees. The dashed line splits the tuning years from the unseen test.</p></div></div>
        <div class="chart" id="btChart"></div>
        <div class="legend" style="margin-top:8px">${[['swing', 'Trend Swing', 'var(--c-swing)'], ['day', 'Breakout Day Trader', 'var(--c-day)'], ['hold', 'Buy & Hold', 'var(--c-hold)'], ['old', 'Old Bot Replica', 'var(--c-old)']].map(([k, n, c]) => `<span style="--bc:${c}"><i></i>${n}</span>`).join('')}</div>
      </div>

      <div class="panel">
        <div class="ph"><div><h2>The four bots in testing</h2><p>Return and worst drop in each period. Per-trade columns are for 2025–26.</p></div></div>
        <div class="tablewrap"><table><thead><tr><th>Bot</th><th class="n">2020–24</th><th class="n">Worst drop</th><th class="n">2025–26</th><th class="n">Worst drop</th><th class="n">Trades</th><th class="n">Per trade before fees</th><th class="n">Fees per trade</th></tr></thead>
        <tbody>${row('swing', 'Trend Swing', 'var(--c-swing)')}${row('day', 'Breakout Day Trader', 'var(--c-day)')}${row('hold', 'Buy & Hold', 'var(--c-hold)')}${row('old', 'Old Bot Replica', 'var(--c-old)')}</tbody></table></div>
      </div>

      <div class="two">
        <div class="panel">
          <h2>Year by year</h2>
          <div class="tablewrap" style="margin-top:10px"><table><thead><tr><th>Bot</th>${years.map(y => `<th class="n">${y}${y === '2026' ? '*' : ''}</th>`).join('')}</tr></thead>
          <tbody>${yr('swing', 'Trend Swing', 'var(--c-swing)')}${R.yearly.mtf ? yr('mtf', '1h/15m Trader', 'var(--c-mtf)') : ''}${yr('day', 'Day Trader', 'var(--c-day)')}${yr('hold', 'Buy & Hold', 'var(--c-hold)')}</tbody></table></div>
          <p class="note">*2026 through Oct 16. Trend Swing lost ${Math.abs(R.yearly.swing['2022']).toFixed(0)}% in 2022, so it is not safe either. It mostly sidesteps long slides and gives some back in choppy years.</p>
        </div>
        <div class="panel">
          <h2>How much fees decide the result</h2>
          <div class="tablewrap" style="margin-top:10px"><table><thead><tr><th>Bot</th><th>Fee per side</th><th class="n">2020–24</th><th class="n">2025–26</th></tr></thead>
          <tbody>${feeRow('day', 'Day Trader')}${feeRow('swing', 'Trend Swing')}</tbody></table></div>
          <p class="note">The day trader only breaks even in 2025–26 at 0.10% per side. Kraken charges that much only on the maker side once you trade $250K+ a month.</p>
        </div>
      </div>

      <div class="panel">
        <div class="ph"><div><h2>Every strategy family tested</h2><p>${R.variants} variants on the tuning years. A variant counts as positive if it ended above $8,000.</p></div></div>
        <div class="tablewrap"><table><thead><tr><th>Family</th><th class="n">Variants</th><th class="n">Positive 2020–24</th><th class="n">Positive 2025–26</th><th class="n">Best 2025–26</th><th class="n">Median 2025–26</th></tr></thead>
        <tbody>${fam.map(f => `<tr><td>${esc(f.family)}</td><td class="n">${f.variants}</td><td class="n">${f.dev_positive}</td><td class="n">${f.test_positive}</td><td class="n ${cls(f.best_test)}">${f.best_test > 0 ? '+' : MINUS}${Math.abs(f.best_test).toFixed(1)}%</td><td class="n ${cls(f.median_test)}">${f.median_test > 0 ? '+' : MINUS}${Math.abs(f.median_test).toFixed(1)}%</td></tr>`).join('')}
        <tr><td>${esc(sf.family)}, market orders</td><td class="n">${sf.variants}</td><td class="n">${sf.dev_positive}</td><td class="n">${sf.test_positive}</td><td class="n ${cls(sf.best_test)}">${sf.best_test > 0 ? '+' : MINUS}${Math.abs(sf.best_test).toFixed(1)}%</td><td class="n ${cls(sf.median_test)}">${sf.median_test > 0 ? '+' : MINUS}${Math.abs(sf.median_test).toFixed(1)}%</td></tr></tbody></table></div>
      </div>

      <div class="panel prose">
        <h2>How the tests avoid fooling themselves</h2>
        <ul>
          <li>Signals use finished candles only. Orders act on the next candle, never the one that produced the signal.</li>
          <li>When one candle touches both the stop and the target, the stop is assumed to hit first.</li>
          <li>Limit orders only count as filled if price trades through them. Market orders pay 0.02% slippage, stop-losses 0.05%.</li>
          <li>Fees follow Kraken Pro's published spot tiers (0.80% taker at the bottom tier, falling with each bot's own 30-day volume).</li>
          <li>Settings were picked on 2020–24 only. 2025–26 was run once at the end.</li>
          <li>The live engine on this page reproduces the research engine trade-for-trade on the same candles.</li>
        </ul>
        <p class="muted">The first rounds were BTC-only, long-only and spot. Later rounds added futures, leverage and shorting (the big searches and the fixes panel above). Still not tested: other coins (no data reachable from the test machine) and order-book data.</p>
      </div>
    </div>`;
    drawResearchChart();
  }
  function drawResearchChart() {
    const R = RESEARCH;
    const toPts = arr => arr.map(([d, v]) => [Date.parse(d + 'T00:00:00Z') / 1000, v]);
    const series = [['old', 'Old Bot Replica', 'var(--c-old)'], ['hold', 'Buy & Hold', 'var(--c-hold)'], ['day', 'Breakout Day Trader', 'var(--c-day)'], ['swing', 'Trend Swing', 'var(--c-swing)']]
      .map(([k, n, c]) => ({ name: n, color: c, pts: toPts(R.curves[k]).filter(p => p[1] >= 10), width: k === 'swing' ? 2.4 : 1.6 }));
    lineChart($('btChart'), {
      series, logY: true, logFloor: 10, height: 320, x0: Date.UTC(2020, 0, 1) / 1000, x1: Date.UTC(2026, 9, 17) / 1000,
      vlines: [{ t: Date.UTC(2025, 0, 1) / 1000, label: 'Unseen test →' }],
      hlines: [{ v: START_EQ, color: 'var(--muted)', label: '$8,000', dim: true }],
      yFmt: v => v >= 1e6 ? '$' + v / 1e6 + 'M' : v >= 1000 ? '$' + v / 1000 + 'K' : '$' + v,
      tipFmt: v => usd0(v), tipTime: t => new Date(t * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
      aria: 'Backtest balances 2020 to 2026',
    });
    const MR = R.meme, me = $('memeChart');
    if (MR && me) {
      const ser = [['btc', 'BTC, buy and hold', 'var(--c-swing)'], ['doge', 'DOGE, buy and hold', 'var(--c-day)'], ['ew', 'All meme coins, equal weight', 'var(--c-hold)'], ['pick', 'Meme Coin Trader (the pick)', 'var(--c-meme)']];
      lineChart(me, {
        series: ser.map(([k, n, c]) => ({ name: n, color: c, pts: toPts(MR.curves[k]).filter(p => p[1] >= 10), width: k === 'pick' ? 2.6 : 1.6 })),
        logY: true, logFloor: 10, height: 300, x0: Date.UTC(2021, 5, 30) / 1000, x1: Date.UTC(2026, 9, 19) / 1000,
        vlines: [{ t: Date.UTC(2025, 6, 1) / 1000, label: 'Hidden months →' }],
        hlines: [{ v: START_EQ, color: 'var(--muted)', label: '$8,000', dim: true }],
        yFmt: v => v >= 1e6 ? '$' + v / 1e6 + 'M' : v >= 1000 ? '$' + v / 1000 + 'K' : '$' + v,
        tipFmt: v => usd0(v), tipTime: t => new Date(t * 1000).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }),
        aria: 'Meme Coin Trader backtest against meme coin buy and hold and BTC, 2021 to 2026',
      });
    }
    const C = R.combo, el = $('comboChart');
    if (C && el) {
      lineChart(el, {
        series: C.rows.slice().reverse().map(r => ({ name: r.name, color: r.color, pts: toPts(C.curves[r.id]).filter(p => p[1] >= 10), width: r.id === 'combo' ? 2.6 : 1.6 })),
        logY: true, logFloor: 10, height: 300, x0: Date.UTC(2020, 0, 1) / 1000, x1: Date.UTC(2026, 9, 17) / 1000,
        vlines: [{ t: Date.UTC(2026, 3, 1) / 1000, label: 'Hidden months →' }],
        hlines: [{ v: START_EQ, color: 'var(--muted)', label: '$8,000', dim: true }],
        yFmt: v => v >= 1e6 ? '$' + v / 1e6 + 'M' : v >= 1000 ? '$' + v / 1000 + 'K' : '$' + v,
        tipFmt: v => usd0(v), tipTime: t => new Date(t * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
        aria: 'Combo backtest against its two parts and buy-and-hold, 2020 to 2026',
      });
    }
  }

  // ======================================================================= render: rules (static)
  function renderRules() {
    const st = F.full.format(new Date(START * 1000));
    $('rules').innerHTML = `
    <div class="stack" style="margin-top:0">
      <div class="panel prose">
        <h2>Forward test v10</h2>
        <p>Start: ${st} ET (midnight UTC). Each bot starts with <b>$8,000</b> of paper money. Rules were locked before the start and will not change. Any change would be a new version with a new start time, so the record here stays honest. Changes before the start: v2 gave Trend Swing limit-first orders to pay lower fees, v3 added the Half-Size, Leveraged and Multi-Speed bots, and v4 added the 10 strategy-lab bots.</p>
        <p>v5 added the <b>1h/15m Trader</b>. Its rules were locked at ${F.full.format(new Date(MTF_LOCKED * 1000))} ET, after the others had started, so it has its own start: ${F.full.format(new Date(MTF_START * 1000))} ET.</p>
        <p>v6 added the <b>Futures Breakout</b>, the best survivor of a 20,070-strategy search. Its rules were locked at ${F.full.format(new Date(FUTB_LOCKED * 1000))} ET and it starts at ${F.full.format(new Date(FUTB_START * 1000))} ET. The other bots did not change.</p>
        <p>v7 added the <b>Combo 50/50</b>: half Trend Swing, half Futures Breakout, the one improvement that held up when other fixes were tested. Its rules were locked at ${F.full.format(new Date(COMBO_LOCKED * 1000))} ET and it starts at the next daily close, ${F.full.format(new Date(COMBO_START * 1000))} ET. The other bots did not change.</p>
        <p>v8 added the <b>Meme Coin Trader</b>, which trades the meme coins Coinbase lists instead of BTC. Its rules were locked at ${F.full.format(new Date(MEME_LOCKED * 1000))} ET and it starts at the next daily close, ${F.full.format(new Date(MEME_START * 1000))} ET. The other bots did not change.</p>
        <p>v9 added the <b>Solana Meme Trader</b>: 10 paper SOL kept in SOL, always in one Solana meme coin, built to start trading right away. Its rules were locked at ${F.full.format(new Date(SOLB_LOCKED * 1000))} ET and it starts at ${F.full.format(new Date(SOLB_START * 1000))} ET. The other bots did not change.</p>
        <p>v10 added the <b>Meme Sniper</b> tab: paper bots for brand-new pump.fun coins (your rules plus six test versions), with the live 1-minute chart of the exact coin each one trades. Its rules are on that tab. The bots on this page did not change.</p>
        <p>v10.1 moved the Meme Sniper bots to GitHub's servers, so they run 24/7 with no computer on, and record every coin that crosses $7K for research. Same locked rules, same code; a fresh 10 paper SOL per bot from the server's start. This page now shows the server's bots. Nothing else changed.</p>
        <p class="muted">How the live record works: this page downloads Coinbase BTC-USD candles and replays the locked rules from the start time. Because the rules are fixed and the candles don't change once finished, you get the same trades no matter when or where you open it. Trades are recorded when each 5-minute candle closes.</p>
      </div>
      <div class="panel prose">
        <h3><span class="botchip" style="--bc:var(--c-solb)"><i></i>Solana Meme Trader</span> <span class="role" style="--bc:var(--c-solb)">10 SOL, Solana memes</span></h3>
        <ol class="steps">
          <li>Coins: the ${SOLB_COINS.length} Solana meme coins Coinbase lists (${SOLB_COINS.join(', ')}). Prices come from Coinbase hourly candles and are turned into SOL with the same hour's SOL price. A coin counts only with 7 days of hourly candles and a median of 50+ SOL traded per hour over the last 30 hours.</li>
          <li>At the start, and then every day at midnight UTC (8 PM ET now, 7 PM ET after Nov 1), rank the coins by their 7-day change against SOL.</li>
          <li>Always hold one coin with all of the balance: the #1, even when every coin is down against SOL. Keep the held coin while it stays in the top 3; otherwise swap it for the new #1.</li>
          <li>Swaps fill at the next hourly open and pay 0.25% swap fee plus 0.25% price impact each way, like a Jupiter or Raydium swap. The balance is counted in SOL.</li>
        </ol>
        <p class="muted">Tested on 200 days of Coinbase hourly candles (Apr to Oct 2026). Versions that switched coins every hour or every 4 hours lost almost everything to swap costs. The pre-registered pick (7-day leader, only when it is up) made +60% in the last 70 days but lost 25% in the 130 before, with an 89% drop along the way. At ${ft(SOLB_LOCKED)} ET every coin was down against SOL over 7 days, so that version would have sat in SOL; you asked for it to trade now, so this always-invested version was chosen: +32% over the 200 days (−3% in the first 130, +36% in the last 70), 36 trades, but a 77% drop from its peak. It was picked after seeing both periods, so treat that +32% as optimistic. Rules locked ${ft(SOLB_LOCKED)} ET, start ${F.dt.format(new Date(SOLB_START * 1000))} ET.</p>
      </div>
      <div class="two">
        <div class="panel prose">
          <h3><span class="botchip" style="--bc:var(--c-meme)"><i></i>Meme Coin Trader</span> <span class="role" style="--bc:var(--c-meme)">Meme coins</span></h3>
          <ol class="steps">
            <li>Coins: the ${MEME_COINS.length} meme coins Coinbase lists in US dollars (${MEME_COINS.join(', ')}). A coin counts only after 30 days of trading and with a median of $1M+ traded per day over the last 30 days.</li>
            <li>Every day at midnight UTC (8 PM ET now, 7 PM ET after Nov 1), if BTC closed above its 50-day average, rank the coins by their 30-day gain. A candidate must be up over 30 days and close above its own 20-day average.</li>
            <li>Hold the #1 candidate with all the cash. Keep it while it stays a candidate in the top 3; otherwise sell it and buy the new #1.</li>
            <li>If BTC closes at or below its 50-day average, sell and wait in cash.</li>
            <li>Orders are market orders at the next day's open with 0.15% slippage, plus Kraken's taker fee for the bot's own volume (0.80% at the start).</li>
          </ol>
          <p class="muted">Picked from 442 versions on Jul 2021 to Jun 2025 only, then run once on Jul 2025 to Oct 2026: +17% while the average meme coin lost 72%, but with an 83% drop from peak along the way. It wins about a third of its trades; a few huge runs pay for many small losses. Rules locked ${ft(MEME_LOCKED)} ET, start ${F.dt.format(new Date(MEME_START * 1000))} ET.</p>
        </div>
        <div class="panel prose">
          <h3><span class="botchip" style="--bc:var(--c-combo)"><i></i>Combo 50/50</span> <span class="role" style="--bc:var(--c-combo)">Swing + Futures</span></h3>
          <ol class="steps">
            <li>The $8,000 is split into two halves of $4,000 that never share money. The bot's balance is the two added together.</li>
            <li><b>Swing half (spot):</b> exactly the Trend Swing rules below, with its own $4,000, its own limit-first orders and its own Kraken fee tier.</li>
            <li><b>Futures half (1.5x):</b> exactly the Futures Breakout rules, sized at 1.5x of its own $4,000 plus or minus what it has made.</li>
            <li>No rebalancing: if one half grows faster, it stays bigger.</li>
          </ol>
          <p class="muted">Why: the two parts win and lose on different days (daily correlation 0.40). From 2020 to 2026 the mix had a smoother ride than either part alone (Sharpe 1.37 vs 1.27 and 1.14) and a smaller worst drop (−43% vs −62% and −44%). It still lost money in 2022 and 2025. Rules locked ${ft(COMBO_LOCKED)} ET, start ${F.dt.format(new Date(COMBO_START * 1000))} ET.</p>
        </div>
        <div class="panel prose" style="--bc:var(--c-swing)">
          <h3><span class="botchip"><i></i>Trend Swing v2</span> <span class="role" style="--bc:var(--c-swing)">Main bot</span></h3>
          <ol class="steps">
            <li>Every day at midnight UTC (8 PM ET now, 7 PM ET after Nov 1), take the daily close.</li>
            <li>If the close is above the average of the last 50 daily closes and the bot is in cash, place a limit buy at that closing price using all the cash.</li>
            <li>If the close is at or below the average and the bot holds BTC, place a limit sell at that closing price.</li>
            <li>A limit order lives for 4 hours. It only counts as filled if price trades 0.02% through it. If it hasn't filled after 4 hours, the bot buys or sells at market.</li>
          </ol>
          <p class="muted">Why limit orders: they pay Kraken's maker fee, about half the market-order fee. In testing, 96 to 98% of them filled. Expect several small losses for each big win.</p>
        </div>
        <div class="panel prose">
          <h3><span class="botchip" style="--bc:var(--c-mtf)"><i></i>1h/15m Trader</span> <span class="role" style="--bc:var(--c-mtf)">Your design</span></h3>
          <ol class="steps">
            <li><b>1-hour chart for direction.</b> Take the last finished 1-hour close and the average of the last 200 hourly closes (about 8 days).</li>
            <li>New buys are allowed only while that 1-hour close is more than 1% above the average.</li>
            <li><b>15-minute chart for timing.</b> At each 15-minute close, if buys are allowed and the 15-minute RSI(14) is under 35 (a dip), place a limit buy at that close with all the cash.</li>
            <li>Sell when a 1-hour close is more than 1% below the average. It checks at every 15-minute close. The 1% gap on each side stops it flip-flopping around the line.</li>
            <li>Every order is a limit at the 15-minute close for 30 minutes, counted as filled only if price trades 0.02% through it, then a market order.</li>
          </ol>
          <p class="muted">Picked from ${RESEARCH.mtf ? RESEARCH.mtf.variants : 216} versions using 2020–24 only. Rules locked ${ft(MTF_LOCKED)} ET, start ${ft(MTF_START)} ET. It checks every 15 minutes but trades about twice a month, because every faster version lost more to fees.</p>
        </div>
        <div class="panel prose">
          <h3><span class="botchip" style="--bc:var(--c-futb)"><i></i>Futures Breakout</span> <span class="role" style="--bc:var(--c-futb)">Futures 1.5x</span></h3>
          <ol class="steps">
            <li>Each UTC day starts at midnight UTC (8 PM ET now, 7 PM ET after Nov 1). Trigger = that day's opening price + 0.6 × the previous UTC day's high-to-low range.</li>
            <li>The first 5-minute candle that closes above the trigger is the signal. It buys BTC futures at the next candle's open, at 1.5x its equity. One trade per day at most. Long only.</li>
            <li>Stop-loss: half of the previous day's range below that signal close (market order, 0.05% slippage, filled at the open if the price gaps through).</li>
            <li>If the stop doesn't hit, it sells at the end of the UTC day. It never holds overnight past the daily close.</li>
            <li>Costs: 0.05% futures fee per side, 0.02% slippage on market orders, and 0.01% funding per 8 hours held.</li>
          </ol>
          <p class="muted">Found by the 20,070-strategy search: it passed 2020–22 and again 2023–24, but went flat to negative in 2025–26. Rules locked ${ft(FUTB_LOCKED)} ET, start ${ft(FUTB_START)} ET. Futures for retail traders in Ontario are limited; this one is paper only.</p>
        </div>
        <div class="panel prose">
          <h3><span class="botchip" style="--bc:var(--c-half)"><i></i>Half-Size Swing</span> <span class="role" style="--bc:var(--c-half)">Lower risk</span></h3>
          <ol class="steps">
            <li>Exactly the Trend Swing rules and limit-first orders.</li>
            <li>Each buy uses half the bot's cash. The other half stays in cash.</li>
          </ol>
          <p class="muted">Smaller drops, smaller gains. Cash earns nothing here; a real savings account would add a little.</p>
        </div>
        <div class="panel prose">
          <h3><span class="botchip" style="--bc:var(--c-lev)"><i></i>Leveraged Swing</span> <span class="role" style="--bc:var(--c-lev)">High risk</span></h3>
          <ol class="steps">
            <li>Same 50-day signal and limit-first orders as Trend Swing.</li>
            <li>When it buys, it borrows so its position = cash \u00d7 (100% \u00f7 BTC's 30-day volatility), capped at 3x. Calm market: more leverage. Wild market: less.</li>
            <li>Borrowed money costs 15% a year, charged every 5 minutes.</li>
            <li>If losses shrink its equity to 10% of the position, it is liquidated: forced sale with a 1% penalty.</li>
          </ol>
          <p class="muted">Canadian retail crypto accounts generally can't borrow like this. It's here to show what leverage does, both ways.</p>
        </div>
        <div class="panel prose">
          <h3><span class="botchip" style="--bc:var(--c-multi)"><i></i>Multi-Speed Trend</span> <span class="role" style="--bc:var(--c-multi)">New idea</span></h3>
          <ol class="steps">
            <li>Four mini-bots, a quarter of the money each, on the 20, 50, 100 and 200-day averages.</li>
            <li>Each one follows the Trend Swing rules with its own average and its own cash.</li>
          </ol>
          <p class="muted">This is how professional trend funds avoid betting everything on one setting. Fees are shared, so all four count toward one Kraken fee tier.</p>
        </div>
        <div class="panel prose">
          <h3><span class="botchip" style="--bc:var(--c-day)"><i></i>Breakout Day Trader</span> <span class="role" style="--bc:var(--c-day)">Experiment</span></h3>
          <ol class="steps">
            <li>At midnight UTC, check yesterday's close against its 20-day average. Below it: no trade today.</li>
            <li>Otherwise set a buy trigger at yesterday's close + 0.7 × yesterday's high-low range.</li>
            <li>Size = 5% ÷ yesterday's range in percent, capped at 100% of cash (smaller on wild days).</li>
            <li>If price reaches the trigger, buy. Sell at the end of the UTC day. One trade per day at most.</li>
          </ol>
          <p class="muted">Best day-trading rules found, but it lost money in testing. It runs so you can watch day trading with real fees.</p>
        </div>
        <div class="panel prose">
          <h3><span class="botchip" style="--bc:var(--c-hold)"><i></i>Buy &amp; Hold</span> <span class="role" style="--bc:var(--c-hold)">Benchmark</span></h3>
          <ol class="steps"><li>Buy BTC with all the cash at the start.</li><li>Never sell.</li></ol>
        </div>
        <div class="panel prose">
          <h3><span class="botchip" style="--bc:var(--c-old)"><i></i>Old Bot Replica</span> <span class="role" style="--bc:var(--c-old)">Control</span></h3>
          <ol class="steps">
            <li>On each 5-minute close above the highest high of the previous 20 candles, buy at the next candle.</li>
            <li>Stop-loss 1.5 × ATR(14) below, profit target 3 × ATR(14) above.</li>
            <li>Sell after 4 hours if neither is hit.</li>
          </ol>
          <p class="muted">Rebuilt from how the old bot's rules were described, so it's an approximation of it, not its exact code.</p>
        </div>
      </div>
      <div class="panel prose">
        <h2>Strategy lab: 10 more bots</h2>
        <p class="muted">Each lab bot follows its rule with the same limit-first orders, fees and $8,000 start as the main bots. Textbook settings, nothing tuned. Multi-part bots split the money into quarters that trade on their own.</p>
        <ol class="steps">${LABS.map(b => `<li><b>${b.name}:</b> ${LAB_IDEA[b.id]}</li>`).join('')}</ol>
      </div>
      <div class="panel prose">
        <h2>Execution and costs</h2>
        <ul>
          <li>Fees: Kraken Pro spot tiers, Oct 2026: 0.40% maker / 0.80% taker at $0+ 30-day volume, down to 0.06% / 0.18% at $1M+. Each bot's tier follows its own volume.</li>
          <li>Slippage: 0.02% on market orders, 0.05% on stop-losses. Buy triggers fill at the trigger or worse.</li>
          <li>Long only, no leverage, no shorting. One position per bot.</li>
          <li>"Balance if closed now" subtracts the fee and slippage it would cost to sell the open position.</li>
          <li>Data: Coinbase Exchange public candles. If Coinbase can't be reached, the page switches to Bitstamp and says so at the top.</li>
        </ul>
        <h2 style="margin-top:14px">How to judge it</h2>
        <p>A few days of results are mostly noise; any bot can be up or down by luck. Compare each bot with Buy &amp; Hold after a month or more. If Trend Swing can't stay ahead of Buy &amp; Hold with a smaller worst drop, it isn't earning its keep.</p>
      </div>
    </div>`;
  }

  // ======================================================================= render all
  function render() {
    const o = S.out;
    if (!o) return;
    renderBays(o);
    renderSolb(o);
    renderNow(o);
    renderMeme(o);
    renderLab(o);
    if (S.tab === 'live') { renderPriceChart(o); renderEquity(o); }
    renderDaily(o);
    renderScore(o);
    renderTrades(o);
    $('whatif').hidden = S.fee === 'kraken';
  }

  // ======================================================================= events
  document.querySelector('.tabs').addEventListener('click', e => {
    const b = e.target.closest('button[data-tab]'); if (!b) return;
    showTab(b.dataset.tab);
  });
  function showTab(tab) {
    S.tab = tab;
    for (const x of document.querySelectorAll('.tabs button')) x.setAttribute('aria-selected', String(x.dataset.tab === tab));
    for (const id of ['sniper', 'v11', 'live', 'trades', 'research', 'rules']) $('p-' + id).hidden = id !== S.tab;
    document.querySelector('.bar .seg').hidden = S.tab === 'sniper' || S.tab === 'v11';
    document.querySelector('.clock').hidden = S.tab === 'sniper' || S.tab === 'v11';
    if (S.tab === 'live' && S.out) { renderPriceChart(S.out); renderEquity(S.out); }
    if (S.tab === 'research') drawResearchChart();
    if (S.tab === 'sniper' && typeof SNIPER_UI !== 'undefined') SNIPER_UI.onShow();
    if (S.tab === 'v11' && typeof V11_UI !== 'undefined') V11_UI.onShow();
    try { history.replaceState(null, '', '#' + tab); } catch (e) { /* file:// or sandboxed */ }
  }
  { const h0 = location.hash.slice(1); const t0 = ['sniper', 'v11', 'live', 'trades', 'research', 'rules'].includes(h0) ? h0 : 'sniper'; document.querySelector('.bar .seg').hidden = t0 === 'sniper' || t0 === 'v11'; document.querySelector('.clock').hidden = t0 === 'sniper' || t0 === 'v11'; if (t0 !== 'sniper') setTimeout(() => showTab(t0), 0); }
  $('feeOpts').addEventListener('click', e => {
    const b = e.target.closest('button[data-fee]'); if (!b) return;
    S.fee = b.dataset.fee;
    for (const x of $('feeOpts').querySelectorAll('button')) x.setAttribute('aria-pressed', String(x === b));
    S.tradeSig = '';
    if (S.m5.length) { compute(); render(); }
  });
  $('winBtns').addEventListener('click', e => {
    const b = e.target.closest('button[data-win]'); if (!b) return;
    S.win = b.dataset.win;
    for (const x of $('winBtns').querySelectorAll('button')) x.setAttribute('aria-pressed', String(x === b));
    if (S.out) renderPriceChart(S.out);
  });
  $('botSel').innerHTML = `<option value="all">All ${BOTS.length - 1} BTC bots</option><optgroup label="Main bots">${CORE.filter(b => !b.meme).map(b => `<option value="${b.id}">${b.name}</option>`).join('')}</optgroup><optgroup label="Lab bots">${LABS.map(b => `<option value="${b.id}">${b.name}</option>`).join('')}</optgroup>`;
  $('botSel').addEventListener('change', e => { S.pxBot = e.target.value; if (S.out) renderPriceChart(S.out); });
  $('eqBtns').addEventListener('click', e => {
    const b = e.target.closest('button[data-eq]'); if (!b) return;
    S.eqSet = b.dataset.eq;
    for (const x of $('eqBtns').querySelectorAll('button')) x.setAttribute('aria-pressed', String(x === b));
    if (S.out) renderEquity(S.out);
  });
  $('tradeFilters').addEventListener('click', e => {
    const b = e.target.closest('button[data-f]'); if (!b) return;
    S.filter = b.dataset.f; S.tradeSig = '';
    if (S.out) renderTrades(S.out);
  });
  let rz;
  window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => { if (S.out && S.tab === 'live') { renderPriceChart(S.out); renderEquity(S.out); } if (S.tab === 'research') drawResearchChart(); }, 150); });

  // ======================================================================= boot
  renderRules();
  renderResearch();
  tickClock();
  setInterval(() => {
    tickClock();
    const n = nowSec(), o = S.out;
    if (o && !o.started && n >= START + SETTLE) refresh();
    // the 1h/15m Trader's own start: update right away instead of waiting for the 30-second refresh
    else if (o && o.acc && o.acc.mtf && o.acc.mtf.notStarted && n >= MTF_START + SETTLE && n < MTF_START + 120) refresh();
    else if (o && o.acc && o.acc.futb && o.acc.futb.notStarted && n >= FUTB_START + SETTLE && n < FUTB_START + 120) refresh();
    else if (o && o.acc && o.acc.combo && o.acc.combo.notStarted && n >= COMBO_START + SETTLE && n < COMBO_START + 120) refresh();
    else if (o && o.acc && o.acc.meme && o.acc.meme.notStarted && n >= MEME_START + SETTLE && n < MEME_START + 120) refresh();
    else if (o && o.solbAcc && o.solbAcc.notStarted && n >= SOLB_START + SETTLE && n < SOLB_START + 120) refresh();
  }, 1000);
  refresh();
  setInterval(refresh, REFRESH_MS);
  // coming back to the tab or the home-screen app: update right away instead of waiting for the next 30-second tick
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { tickClock(); refresh(); } });
  window.__BPL = S; // for inspection
})();
