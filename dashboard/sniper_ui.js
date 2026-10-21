/* Meme Sniper (v10.1): live paper bots for brand-new pump.fun coins, and the Meme Sniper tab.
   Server mode: the bots run 24/7 on GitHub Actions (github.com/AliMallick2008/meme-sniper) and this page shows what they
   do; the live 1-minute chart of each coin is drawn in this browser from GeckoTerminal and DexScreener.
   Local mode (only when this browser has never reached the server): the bots run in this tab, as in v10.
   The bot logic is SNIPER_CORE, the same code the server runs. Paper only: no wallet, no real orders. */
const SNIPER_UI = (() => {
  const E = SNIPER;
  const { LOCKED, START_SOL, BOTS, META_S } = E.RULES;
  const BOT = id => BOTS.find(b => b.id === id) || BOTS[0];
  const SERVER = { repo: 'AliMallick2008/meme-sniper', branch: 'data' };
  const KEY = 'bpl_snipe_v2', LEAD_KEY = 'bpl_snipe_leader', SRV_KEY = 'bpl_snipe_srv';
  const TZ = 'America/Toronto';

  // ---------------------------------------------------------------- helpers
  const $ = id => document.getElementById(id);
  const nowS = () => Date.now() / 1000;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ADDR = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  const okAddr = a => typeof a === 'string' && ADDR.test(a);
  const safeUrl = u => { try { const x = new URL(u); return x.protocol === 'https:' ? x.href : ''; } catch (e) { return ''; } };
  const MINUS = '−';
  const fmtMc = v => !isFinite(v) ? '–' : v >= 1e9 ? '$' + (v / 1e9).toFixed(2) + 'B' : v >= 1e6 ? '$' + (v / 1e6).toFixed(2) + 'M' : v >= 1e5 ? '$' + (v / 1e3).toFixed(0) + 'K' : v >= 1e3 ? '$' + (v / 1e3).toFixed(1) + 'K' : '$' + v.toFixed(0);
  const fmtUsd = v => !isFinite(v) ? '–' : '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtPx = v => { if (!isFinite(v) || v <= 0) return '–'; if (v >= 1) return '$' + v.toFixed(4); const d = Math.min(14, Math.max(4, Math.ceil(-Math.log10(v)) + 3)); return '$' + v.toFixed(d).replace(/0+$/, ''); };
  const sol = (v, d = 3) => isFinite(v) ? v.toFixed(d) + ' SOL' : '–';
  const sSol = (v, d = 3) => !isFinite(v) ? '–' : (v > 0.0005 ? '+' : v < -0.0005 ? MINUS : '') + Math.abs(v).toFixed(d) + ' SOL';
  const sPct = (v, d = 1) => !isFinite(v) ? '–' : (v > 0.00005 ? '+' : v < -0.00005 ? MINUS : '') + Math.abs(v * 100).toFixed(d) + '%';
  const cls = v => v > 1e-9 ? 'up' : v < -1e-9 ? 'down' : 'flat';
  const age = s => !isFinite(s) ? '–' : s < 60 ? Math.max(0, Math.round(s)) + 's' : s < 3600 ? Math.floor(s / 60) + 'm' : s < 86400 ? Math.floor(s / 3600) + 'h ' + String(Math.floor(s % 3600 / 60)).padStart(2, '0') + 'm' : Math.floor(s / 86400) + 'd ' + Math.floor(s % 86400 / 3600) + 'h';
  const F = { t: new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }), ts: new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit', second: '2-digit' }),
    dt: new Intl.DateTimeFormat('en-US', { timeZone: TZ, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) };
  const fT = t => F.t.format(new Date(t * 1000)), fTS = t => F.ts.format(new Date(t * 1000)), fDT = t => F.dt.format(new Date(t * 1000));
  const sum = a => a.reduce((x, y) => x + y, 0);
  const short = m => m ? m.slice(0, 4) + '…' + m.slice(-4) : '';
  const minute = t => Math.floor(t / 60) * 60;
  function cssv(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }

  // ---------------------------------------------------------------- the bots (shared core) and where they run
  let mode = 'start';                // 'server': GitHub runs the bots, this page shows them; 'local': this browser runs them
  let leader = false, storageOk = true, running = false, prevRun = '';
  async function httpGet(url) {
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null, to = setTimeout(() => ctl && ctl.abort(), 15000);
    try { const r = await fetch(url, ctl ? { signal: ctl.signal } : {}); return { status: r.status, json: r.ok ? await r.json() : null }; }
    finally { clearTimeout(to); }
  }
  const C = SNIPER_CORE.create({
    now: () => Date.now(), sleep, http: httpGet,
    leader: () => leader, stillLeader: () => stillLeader(), save: f => save(f), dirty: () => dirty(), liveBar: () => liveBar(), visible: () => visible(),
    toast: (b, kind, title, text, m) => toast(b, kind, title, text, m),
    gapText: a => `This page was closed for ${a}. Coins the bots held or watched are caught up from their 1-minute candles; launches in that time were not scanned.`,
  });
  const M = C.M, LANES = C.LANES;
  const { want, acct, markOf, candlesFor, checksOf, graduated, solNow, nearBuy, nearExit, liveSince, stepAll, note } = C;
  let J = C.J();
  const useJ = j => (J = C.setJ(j));

  // ---------------------------------------------------------------- local mode: journal in localStorage, one tab drives the bots
  function readStore() {
    try { const j = JSON.parse(localStorage.getItem(KEY) || 'null'); if (j && j.v === 2 && j.bots) return j; } catch (e) { /* blocked or corrupt */ }
    return null;
  }
  let saveT = 0, saveTimer = null;
  function save(now) {
    if (mode !== 'local' || !stillLeader()) return;
    if (!now && Date.now() - saveT < 2500) { if (!saveTimer) saveTimer = setTimeout(() => { saveTimer = null; save(true); }, 2500); return; }
    saveT = Date.now();
    C.prune();
    try { localStorage.setItem(KEY, JSON.stringify(J)); } catch (e) { C.pruneHard(); try { localStorage.setItem(KEY, JSON.stringify(J)); } catch (e2) { /* full or blocked: keep running in memory */ } }
  }
  const TAB = Math.random().toString(36).slice(2) + Date.now().toString(36);
  function readLead() { try { return JSON.parse(localStorage.getItem(LEAD_KEY) || 'null'); } catch (e) { storageOk = false; return null; } }
  // a tab that lost the lead (another tab took over while this one slept) stops writing at once
  function stillLeader() {
    if (!leader) return false;
    if (!storageOk) return true;
    const cur = readLead();
    if (cur && cur.id !== TAB && Date.now() - cur.t < 12000 && cur.t > (M.leadT || 0)) { leader = false; note('another tab took over'); dirty(); return false; }
    return true;
  }
  function beat() { try { localStorage.setItem(LEAD_KEY, JSON.stringify({ id: TAB, t: Date.now() })); } catch (e) { storageOk = false; } }
  async function claim() {
    const cur = readLead();
    if (!storageOk) return true;
    if (cur && cur.id !== TAB && Date.now() - cur.t < 12000) return false;
    beat();
    await sleep(400);
    const now = readLead();
    return !storageOk || (now && now.id === TAB);
  }
  async function becomeLeader() {
    leader = true; M.leadT = Date.now();
    const s = readStore(); if (s) useJ(s);
    C.resume();
    beat(); save(true);
    C.solTicker().then(() => C.bootstrap());
  }
  function viewerMode() { dirty(); }

  // ---------------------------------------------------------------- server mode: the bots run on GitHub, this page reads their state
  // state.json comes from GitHub's API (fresh; 60 calls an hour per IP without a login) or, past that limit, from GitHub's
  // CDN copy (up to 5 minutes old). Trade candles for old trades come from tc/<coin>.json next to it.
  const SRV = { srv: null, at: 0, via: '', apiOffUntil: 0, lastEvT: 0, next: 0, fails: 0 };
  function tfetch(url, opt) {
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null, to = setTimeout(() => ctl && ctl.abort(), 15000);
    return fetch(url, Object.assign(ctl ? { signal: ctl.signal } : {}, opt || {})).finally(() => clearTimeout(to));
  }
  async function srvGet() {
    let txt = null, via = '';
    if (Date.now() >= SRV.apiOffUntil) {
      try {
        const r = await tfetch(`https://api.github.com/repos/${SERVER.repo}/contents/state.json?ref=${SERVER.branch}`, { headers: { Accept: 'application/vnd.github.raw' }, cache: 'no-cache' });
        if (r.status === 200) { txt = await r.text(); via = 'api'; }
        else if (r.status === 403 || r.status === 429) SRV.apiOffUntil = Date.now() + 15 * 60000;
      } catch (e) { /* offline or blocked */ }
    }
    if (txt == null) {
      try { const r = await tfetch(`https://raw.githubusercontent.com/${SERVER.repo}/${SERVER.branch}/state.json`, { cache: 'no-cache' }); if (r.status === 200) { txt = await r.text(); via = 'cdn'; } } catch (e) { /* offline */ }
    }
    if (txt == null) return null;
    try { const s = JSON.parse(txt); return s && s.J && s.J.bots && s.srv ? { s, txt, via } : null; } catch (e) { return null; }
  }
  function applyServer(s, via, quiet) {
    if (SRV.srv && s.srv.t < SRV.srv.t) return;   // never step back to an older copy (the CDN can lag the API)
    const j = s.J; j.tc = {};
    useJ(j);
    SRV.srv = s.srv; SRV.at = Date.now(); SRV.via = via;
    const last = J.ev.length ? J.ev[J.ev.length - 1][0] : 0;
    if (!quiet && SRV.lastEvT) for (const e of J.ev) if (e[0] > SRV.lastEvT && e[1] && /^(buy|win|loss)$/.test(e[2])) toast(BOT(e[1]), e[2], BOT(e[1]).name, String(e[3]).replace(/^[^:]*:\s*/, ''), e[4]);
    SRV.lastEvT = Math.max(SRV.lastEvT, last);
  }
  async function srvLoop() {
    if (Date.now() < SRV.next) return;
    const g = await srvGet();
    if (g) {
      if (mode !== 'server') toServer();
      applyServer(g.s, g.via);
      try { localStorage.setItem(SRV_KEY, g.txt); } catch (e) { /* too big or blocked */ }
      SRV.fails = 0;
    } else SRV.fails++;
    SRV.next = Date.now() + (mode === 'server' ? (g ? 90000 : Math.min(300000, 30000 * SRV.fails)) : 300000);
    if (mode === 'server') dirty();
  }
  // the server came up while this browser was running the bots itself: it takes over, this tab only shows it
  function toServer() {
    mode = 'server';
    if (leader) { leader = false; try { const cur = readLead(); if (cur && cur.id === TAB) localStorage.removeItem(LEAD_KEY); } catch (e) { /* blocked */ } }
    M.gtQ.clear();
    prevRun = earlierRun();
  }
  // the shown coin: fresh candles once a minute from this browser, and the server's saved candles for old trades
  function serverView() {
    if (mode !== 'server' || !visible()) return;
    const m = M.view.m; if (!m) return;
    if (J.coins[m]) { const c = M.cs.get(m); if (!c || nowS() - c.f >= 60) want(m, 1); }
    loadTc(m);
  }
  const tcBusy = new Set();
  async function loadTc(m, force) {
    if (tcBusy.has(m) || !okAddr(m)) return;
    const traded = Object.values(J.bots).some(B => (B.pos && B.pos.m === m) || B.trades.some(x => x.m === m));
    const have = M.tc.get(m);
    if (!traded || (have && !force && Date.now() - have.at < 300000)) return;
    tcBusy.add(m);
    try {
      const r = await tfetch(`https://raw.githubusercontent.com/${SERVER.repo}/${SERVER.branch}/tc/${m}.json`);
      const v = r.ok ? await r.json() : null;
      M.tc.set(m, v && Array.isArray(v.r) ? Object.assign(v, { at: Date.now() }) : { r: [], at: Date.now() });
      CH.key = ''; dirty();
    } catch (e) { /* retried on the next pass */ } finally { tcBusy.delete(m); }
  }
  const srvAgeS = () => SRV.srv && SRV.srv.t ? (Date.now() - SRV.srv.t) / 1000 : NaN;
  const youngCount = () => mode === 'server' ? ((SRV.srv && SRV.srv.young) || 0) : M.young.size;
  // what this browser's own bots did before the server took over (kept in localStorage, shown under the lab)
  function earlierRun() {
    const s = readStore(); if (!s || !s.bots) return '';
    const parts = BOTS.map(b => { const B = s.bots[b.id]; if (!B || !B.trades) return null; const n = B.trades.length; return `${b.name} ${(START_SOL + sum(B.trades.map(x => x.net))).toFixed(3)} SOL (${n} trade${n === 1 ? '' : 's'}${B.pos ? ' + 1 open' : ''})`; }).filter(Boolean);
    return parts.length ? `Before the server took over, this browser ran the bots itself from ${fDT(s.start)} to ${fDT(s.last)} ET: ${parts.join(', ')}.` : '';
  }
  // show the last known server state at once (start() refreshes it), else this browser's own journal
  {
    let cs = null; try { cs = JSON.parse(localStorage.getItem(SRV_KEY) || 'null'); } catch (e) { cs = null; }
    if (cs && cs.J && cs.J.bots && cs.srv) { mode = 'server'; applyServer(cs, 'saved', true); prevRun = earlierRun(); }
    else { const s = readStore(); if (s) useJ(s); }
  }

  // ---------------------------------------------------------------- start
  async function start() {
    if (running) return; running = true;
    const g = await srvGet();
    if (g) {
      if (mode !== 'server') { mode = 'server'; prevRun = earlierRun(); }
      applyServer(g.s, g.via, true);
      try { localStorage.setItem(SRV_KEY, g.txt); } catch (e) { /* too big or blocked */ }
      SRV.next = Date.now() + 90000;
    } else if (mode === 'server') SRV.next = Date.now() + 30000;   // seen before: show its last state while retrying
    else { mode = 'local'; SRV.next = Date.now() + 300000; if (await claim()) await becomeLeader(); else viewerMode(); }
    C.loopEvery(C.discover, 12000, 'discover');
    C.loopEvery(C.follow, 15000, 'follow');
    C.loopEvery(C.pricePoll, 8000, 'prices', true);
    C.loopEvery(C.solTicker, 30000, 'sol', true);
    C.loopEvery(async () => {
      if (mode === 'local' && stillLeader()) { beat(); M.leadT = Date.now(); C.schedule(); stepAll(); save(); }
      else serverView();
    }, 4000, 'schedule', true);
    C.loopEvery(async () => { if (mode !== 'local' || leader) return; const s = readStore(); if (s) useJ(s); if (await claim()) await becomeLeader(); else dirty(); }, 5000, 'viewer', true);
    C.loopEvery(srvLoop, 15000, 'server', true);
    C.checkLoop(); C.rcLoop(); C.gtLoop();
    setInterval(() => { if (visible()) tick(); }, 1000);
    dirty();
  }

  // ---------------------------------------------------------------- view model
  function focusOf(bid) {
    const B = J.bots[bid];
    if (B.pos) return B.pos.m;
    if (B.pending) return B.pending.m;
    let best = null;
    for (const w of B.watch) if (!w.done) { const r = M.px.get(w.m); const d = r && w.trig > 0 ? r.price / w.trig - 1 : 1e9; if (!best || d < best[1]) best = [w.m, d]; }
    if (best) return best[0];
    const tr = B.trades[B.trades.length - 1];
    return tr ? tr.m : null;
  }
  function visible() { const p = $('p-sniper'); return !!p && !p.hidden; }
  let dirtyT = null;
  function dirty() { if (dirtyT) return; dirtyT = setTimeout(() => { dirtyT = null; if (visible()) render(); }, 300); }
  function toast(b, kind, title, text, m) {
    if (!visible()) return;
    const el = $('snToasts'); if (!el) return;
    const d = document.createElement('div');
    d.className = 'sn-toast ' + kind;
    d.style.setProperty('--bc', `var(${b.color})`);
    d.innerHTML = `<b>${esc(title)}</b><span>${esc(text)}</span>`;
    d.addEventListener('click', () => { M.view.bot = b.id; M.view.m = m; M.view.pinned = false; render(true); d.remove(); });
    el.appendChild(d);
    setTimeout(() => d.classList.add('out'), 6500);
    setTimeout(() => d.remove(), 7200);
    while (el.children.length > 4) el.firstChild.remove();
  }

  // ---------------------------------------------------------------- chart (TradingView Lightweight Charts)
  const CH = { chart: null, cs: null, vol: null, lines: [], key: '', last: null, theme: '', m: null };
  function chartTheme() {
    return { layout: { background: { type: 'solid', color: cssv('--panel') }, textColor: cssv('--muted'), fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontSize: 11 },
      grid: { vertLines: { color: cssv('--line-2') }, horzLines: { color: cssv('--line-2') } }, rightPriceScale: { borderColor: cssv('--line') }, timeScale: { borderColor: cssv('--line') } };
  }
  const fmtAxis = v => M.view.unit === 'mc' ? fmtMc(v) : fmtPx(v);
  function chartInit() {
    const el = $('snChart');
    if (!el || CH.chart || typeof LightweightCharts === 'undefined') return;
    CH.chart = LightweightCharts.createChart(el, Object.assign(chartTheme(), {
      autoSize: true, crosshair: { mode: 0 },
      rightPriceScale: { borderColor: cssv('--line'), scaleMargins: { top: 0.08, bottom: 0.06 } },
      timeScale: { borderColor: cssv('--line'), timeVisible: true, secondsVisible: false, rightOffset: 4, tickMarkFormatter: t => fT(t) },
      localization: { priceFormatter: fmtAxis, timeFormatter: t => fDT(t) },
    }));
    CH.cs = CH.chart.addCandlestickSeries({ upColor: cssv('--gain'), downColor: cssv('--loss'), wickUpColor: cssv('--gain'), wickDownColor: cssv('--loss'), borderVisible: false,
      priceFormat: { type: 'custom', formatter: fmtAxis, minMove: 1e-12 } });
    CH.vol = CH.chart.addHistogramSeries({ priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false });
    CH.chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    CH.chart.subscribeCrosshairMove(p => crosshairInfo(p));
    CH.theme = cssv('--panel');
  }
  function chartRetheme() {
    if (!CH.chart || CH.theme === cssv('--panel')) return;
    CH.theme = cssv('--panel');
    CH.chart.applyOptions(chartTheme());
    CH.cs.applyOptions({ upColor: cssv('--gain'), downColor: cssv('--loss'), wickUpColor: cssv('--gain'), wickDownColor: cssv('--loss') });
    CH.key = '';
  }
  const scaleV = v => M.view.unit === 'mc' ? v * E.SUPPLY : v;
  function viewData(m) {
    let cs = m ? candlesFor(m) : [];
    const R = M.view.replay;
    if (R && R.m === m) cs = cs.filter(c => c[0] >= R.from && c[0] <= R.t);
    return E.aggregate(cs, M.view.tf);
  }
  function replayPad(cs) {   // whitespace minutes after the replay clock, so the time axis spans the whole replay
    const R = M.view.replay; if (!R) return [];
    const w = 60 * M.view.tf, out = [];
    for (let t = (cs.length ? cs[cs.length - 1][0] : Math.floor(R.from / w) * w) + w; t <= R.to; t += w) out.push({ time: t });
    return out;
  }
  function drawChart(force) {
    chartInit(); chartRetheme();
    if (!CH.chart) return;
    const m = M.view.m, cs = viewData(m), R = M.view.replay;
    const key = `${m}|${M.view.unit}|${M.view.tf}|${M.view.bot}|${cs.length}|${cs.length ? cs[cs.length - 1].join(',') : ''}|${markerKey(m)}|${R ? R.t : ''}`;
    if (!force && key === CH.key) return;
    const prev = CH.key.split('|'), coinChanged = prev[0] !== String(m) || prev[1] !== M.view.unit || prev[2] !== String(M.view.tf);
    CH.key = key;
    const up = cssv('--gain'), dn = cssv('--loss');
    const pad = replayPad(cs);
    CH.cs.setData(cs.map(c => ({ time: c[0], open: scaleV(c[1]), high: scaleV(c[2]), low: scaleV(c[3]), close: scaleV(c[4]) })).concat(pad));
    CH.vol.setData(cs.map(c => ({ time: c[0], value: c[5] || 0, color: (c[4] >= c[1] ? up : dn) + '55' })).concat(pad));
    CH.last = cs.length ? cs[cs.length - 1].slice() : null; CH.m = m;
    for (const l of CH.lines) CH.cs.removePriceLine(l);
    CH.lines = [];
    const lo = cs.length ? Math.min(...cs.map(c => c[3])) : 0, hi = cs.length ? Math.max(...cs.map(c => c[2])) : 0;
    if (!R) for (const g of levelsOf(m)) if (g.usd > 0 && isFinite(g.usd) && (!cs.length || (g.usd >= lo * 0.55 && g.usd <= hi * 2.2))) CH.lines.push(CH.cs.createPriceLine({ price: scaleV(g.usd), color: g.color, lineWidth: g.w || 1, lineStyle: g.style, axisLabelVisible: true, title: g.title }));
    const have = new Set(cs.map(c => c[0]));
    const snap = t => Math.floor(t / (60 * M.view.tf)) * 60 * M.view.tf;
    CH.cs.setMarkers(markersOf(m).map(x => Object.assign({}, x, { time: snap(x.time) })).filter(x => have.has(x.time) && (!R || x.time <= R.t)).sort((a, b) => a.time - b.time));
    if (coinChanged || (R && R.fit)) { CH.chart.timeScale().fitContent(); if (R) R.fit = false; }
    $('snChartEmpty').hidden = !!cs.length;
  }
  function markerKey(m) { const B = J.bots[M.view.bot]; return `${B.pos ? B.pos.m + B.pos.entryT : ''}|${B.trades.length}|${B.watch.length}|${B.pending ? B.pending.entryT : ''}`; }
  // horizontal levels for the shown coin, in USD
  function levelsOf(m) {
    const out = [], b = BOT(M.view.bot), B = J.bots[b.id], s = solNow();
    if (B.pos && B.pos.m === m) {
      const p = B.pos, curve = !graduated(m);
      out.push({ usd: p.entryUsd, color: cssv('--accent'), style: 0, w: 2, title: 'Bought' });
      out.push({ usd: (curve ? p.tpCurve : p.tpPool) * s, color: cssv('--gain'), style: 2, title: `Sell target (+${Math.round(b.P.tp * 100)}%)` });
      if (p.slSol) out.push({ usd: p.slSol * s, color: cssv('--loss'), style: 2, title: `Stop (${Math.round((1 - b.P.sl) * 100)}% of buy)` });
      if (curve) out.push({ usd: E.CURVE_FLOOR * s, color: cssv('--faint'), style: 1, title: 'Curve floor' });
    } else {
      const w = B.watch.find(x => x.m === m && !x.done);
      if (w && w.trig > 0) {
        const H = Math.max(w.H || 0, liveHigh(m)), trig = (1 - b.P.dip) * H;
        out.push({ usd: trig, color: cssv('--warn'), style: 2, w: 2, title: `Buy zone (−${Math.round(b.P.dip * 100)}%)` });
        out.push({ usd: H, color: cssv('--faint'), style: 1, title: 'High' });
      }
    }
    return out;
  }
  // highs the candles haven't caught up with yet (live price), for display only
  function liveHigh(m) { const r = M.px.get(m); return r && r.price > 0 ? r.price : 0; }
  function markersOf(m) {
    const out = [], b = BOT(M.view.bot), B = J.bots[b.id];
    for (const w of B.watch) if (w.m === m) out.push({ time: minute(w.from), position: 'aboveBar', color: cssv('--warn'), shape: 'circle', text: 'Passed checks' });
    for (const x of B.trades.filter(y => y.m === m)) {
      out.push({ time: x.entryT, position: 'belowBar', color: cssv('--accent'), shape: 'arrowUp', text: `BUY ${x.cost.toFixed(2)} SOL @ ${fmtMc(x.entryMc)}` });
      out.push({ time: x.exitT, position: 'aboveBar', color: x.net >= 0 ? cssv('--gain') : cssv('--loss'), shape: 'arrowDown', text: `SELL ${sPct(x.ret)} (${sSol(x.net, 3)})` });
    }
    if (B.pos && B.pos.m === m) out.push({ time: B.pos.entryT, position: 'belowBar', color: cssv('--accent'), shape: 'arrowUp', text: `BUY ${B.pos.cost.toFixed(2)} SOL @ ${fmtMc(B.pos.entryMc)}` });
    return out;
  }
  // the newest candle follows DexScreener's live price between candle refreshes
  function liveBar() {
    if (!CH.chart || !CH.last || CH.m !== M.view.m || M.view.replay || M.view.mode !== 'chart') return;
    const r = M.px.get(M.view.m); if (!r || !(r.price > 0) || nowS() - r.t > 60) return;
    const px = r.price, w = 60 * M.view.tf, t = Math.floor(nowS() / w) * w;
    let bar;
    if (t === CH.last[0]) bar = [t, CH.last[1], Math.max(CH.last[2], px), Math.min(CH.last[3], px), px];
    else if (t > CH.last[0]) bar = [t, CH.last[4], Math.max(CH.last[4], px), Math.min(CH.last[4], px), px];
    else return;
    CH.last = bar.concat([CH.last[5] || 0, CH.last[6] || 0]);
    try { CH.cs.update({ time: t, open: scaleV(bar[1]), high: scaleV(bar[2]), low: scaleV(bar[3]), close: scaleV(bar[4]) }); } catch (e) { /* older than the last bar */ }
  }
  function crosshairInfo(p) {
    const el = $('snHover'); if (!el) return;
    if (!p || !p.time || !p.seriesData) { el.textContent = ''; return; }
    const d = p.seriesData.get(CH.cs); if (!d) { el.textContent = ''; return; }
    el.textContent = `${fDT(p.time)}   O ${fmtAxis(d.open)}  H ${fmtAxis(d.high)}  L ${fmtAxis(d.low)}  C ${fmtAxis(d.close)}`;
  }
  // replay a coin's candles with the bot's marks appearing as they happened
  async function startReplay(m) {
    let cs = candlesFor(m);
    // server mode: an old trade's candles come from the server's saved copy, or from GeckoTerminal if it has none
    if (!cs.length && mode === 'server') { await loadTc(m, true); cs = candlesFor(m); }
    if (!cs.length) { stopReplay(); M.view.m = m; M.view.pinned = true; M.view.wantReplay = m; if (J.coins[m]) want(m, 0); CH.key = ''; render(true); return; }
    const B = J.bots[M.view.bot], tr = B.trades.filter(x => x.m === m), w = B.watch.find(x => x.m === m);
    const from = Math.max(cs[0][0], (w ? w.from : tr.length ? tr[0].entryT : cs[0][0]) - 20 * 60);
    const to = tr.length ? Math.min(cs[cs.length - 1][0], tr[tr.length - 1].exitT + 15 * 60) : cs[cs.length - 1][0];
    stopReplay();
    M.view.m = m; M.view.pinned = true; M.view.mode = 'chart';
    M.view.replay = { m, from, t: from, to, fit: true, timer: setInterval(() => { const R = M.view.replay; if (!R) return; R.t += 60 * Math.max(1, M.view.tf); if (R.t >= R.to) { R.t = R.to; clearInterval(R.timer); R.done = true; } drawChart(); renderReplayBar(); }, 140) };
    CH.key = ''; render(true);
  }
  function stopReplay() { if (M.view.replay) { clearInterval(M.view.replay.timer); M.view.replay = null; CH.key = ''; } }

  // ---------------------------------------------------------------- lab equity chart
  const EQ = { chart: null, series: {}, theme: '', key: '' };
  function drawEquity() {
    const el = $('snEq'); if (!el || typeof LightweightCharts === 'undefined') return;
    if (!EQ.chart) {
      EQ.chart = LightweightCharts.createChart(el, Object.assign(chartTheme(), { autoSize: true, handleScroll: false, handleScale: false, crosshair: { mode: 0 },
        timeScale: { borderColor: cssv('--line'), timeVisible: true, secondsVisible: false, tickMarkFormatter: t => fT(t) }, localization: { priceFormatter: v => v.toFixed(2) + ' SOL', timeFormatter: t => fDT(t) } }));
      EQ.theme = cssv('--panel');
    } else if (EQ.theme !== cssv('--panel')) { EQ.theme = cssv('--panel'); EQ.chart.applyOptions(chartTheme()); EQ.key = ''; }
    const key = BOTS.map(b => J.bots[b.id].trades.length + ':' + (J.bots[b.id].pos ? 1 : 0)).join('|') + '|' + M.view.bot + '|' + minute(nowS());
    if (key === EQ.key) return;
    EQ.key = key;
    const t0 = minute(J.start);
    for (const b of BOTS) {
      if (!EQ.series[b.id]) EQ.series[b.id] = EQ.chart.addLineSeries({ color: cssv(b.color), lineWidth: 2, priceLineVisible: false, lastValueVisible: false });
      EQ.series[b.id].applyOptions({ color: cssv(b.color), lineWidth: b.id === M.view.bot ? 3 : 1.5 });
      const pts = [{ time: t0, value: START_SOL }];
      let eq = START_SOL;
      for (const x of J.bots[b.id].trades) { eq += x.net; const tt = Math.max(pts[pts.length - 1].time + 60, minute(x.exitT)); pts.push({ time: tt, value: eq }); }
      const a = acct(b), tn = Math.max(pts[pts.length - 1].time + 60, minute(nowS()));
      pts.push({ time: tn, value: a.bal });
      EQ.series[b.id].setData(pts);
    }
    EQ.chart.timeScale().fitContent();
  }

  // ---------------------------------------------------------------- render
  function shell() {
    const el = $('sniper'); if (!el || el.dataset.ready) return;
    el.dataset.ready = '1';
    el.innerHTML = `
      <div class="sn-toasts" id="snToasts" aria-live="polite"></div>
      <div class="panel sn-hero" id="snHero"></div>
      <div class="sn-bots" id="snBots" role="tablist" aria-label="Bots"></div>
      <div class="sn-main">
        <div class="panel sn-chartcard">
          <div class="sn-coinhead" id="snHead"></div>
          <div class="sn-toolbar">
            <div class="mini-btns" id="snMode"><button data-mode="chart" aria-pressed="true">Bot's chart + trades</button><button data-mode="dex" aria-pressed="false">DexScreener live</button></div>
            <div class="mini-btns" id="snUnit"><button data-unit="mc" aria-pressed="true">Market cap</button><button data-unit="px" aria-pressed="false">Price</button></div>
            <div class="mini-btns" id="snTf"><button data-tf="1" aria-pressed="true">1m</button><button data-tf="5" aria-pressed="false">5m</button></div>
            <button class="sn-follow" id="snFollow" hidden>Follow the bot</button>
          </div>
          <div class="sn-replaybar" id="snReplay" hidden></div>
          <div class="sn-chartwrap"><div id="snChart" class="sn-chart"></div><div id="snDex" class="sn-chart" hidden></div><div class="sn-empty" id="snChartEmpty">The chart shows up when a bot is watching or holding a coin.</div></div>
          <div class="sn-hover mono" id="snHover"></div>
          <div class="sn-legend" id="snLegend"></div>
        </div>
        <div class="sn-side">
          <div class="panel" id="snDoing"></div>
          <div class="panel" id="snChecks"></div>
          <div class="panel" id="snMemes"></div>
        </div>
      </div>
      <div class="panel"><div class="ph"><div><h2>Strategy lab</h2><p>Your rules and six versions of them run side by side on the same coins, each with its own 10 paper SOL, so you can see which one actually makes money. Tap a bot to follow it on the chart.</p></div></div>
        <div class="tablewrap" id="snLab"></div><div class="sn-eq" id="snEq"></div><p class="note" id="snLabNote"></p></div>
      <div class="panel"><div class="ph"><div><h2>Watchlist</h2><p id="snWatchSub">Coins that passed every check, and how far each is from its buy zone.</p></div></div><div id="snWatch"></div></div>
      <div class="panel"><div class="ph"><div><h2>Trades</h2><p>Tap a coin to see its chart with the buy and the sell, or replay the trade.</p></div></div><div class="tablewrap" id="snTrades"></div></div>
      <div class="two">
        <div class="panel"><div class="ph"><div><h2>Scanner</h2><p id="snScanSub"></p></div></div><div class="sn-funnel" id="snFunnel"></div><div class="tablewrap" id="snScan"></div></div>
        <div class="panel"><div class="ph"><div><h2>Activity</h2><p>Everything the bots did, newest first.</p></div></div><div class="sn-feed" id="snFeed"></div></div>
      </div>
      <div class="panel prose" id="snRules"></div>`;
    el.addEventListener('click', e => {
      if (!e.target.closest('[data-replay]')) M.view.wantReplay = null;
      const bb = e.target.closest('[data-bot]'); if (bb) { M.view.bot = bb.dataset.bot; M.view.pinned = false; stopReplay(); CH.key = ''; render(true); return; }
      const b = e.target.closest('[data-mode]'); if (b) { M.view.mode = b.dataset.mode; stopReplay(); setPressed('#snMode button', b); render(true); return; }
      const u = e.target.closest('[data-unit]'); if (u) { M.view.unit = u.dataset.unit; setPressed('#snUnit button', u); CH.key = ''; render(true); return; }
      const f = e.target.closest('[data-tf]'); if (f) { M.view.tf = +f.dataset.tf; setPressed('#snTf button', f); CH.key = ''; render(true); return; }
      const rp = e.target.closest('[data-replay]'); if (rp) { const m = rp.dataset.replay; if (M.view.bot !== rp.dataset.rbot && rp.dataset.rbot) M.view.bot = rp.dataset.rbot; startReplay(m); scrollToChart(); return; }
      if (e.target.closest('#snReplayStop')) { stopReplay(); render(true); return; }
      const c = e.target.closest('[data-coin]'); if (c) { stopReplay(); M.view.m = c.dataset.coin; M.view.pinned = true; if (!M.cs.get(M.view.m) && J.coins[M.view.m]) want(M.view.m, 1); CH.key = ''; render(true); scrollToChart(); return; }
      if (e.target.closest('#snFollow')) { stopReplay(); M.view.pinned = false; CH.key = ''; render(true); }
    });
  }
  function setPressed(sel, b) { for (const x of document.querySelectorAll(sel)) x.setAttribute('aria-pressed', String(x === b)); }
  function scrollToChart() { const c = document.querySelector('.sn-chartcard'); if (c) window.scrollTo({ top: c.getBoundingClientRect().top + window.scrollY - 70, behavior: 'smooth' }); }
  function render(force) {
    shell();
    if (M.view.wantReplay && candlesFor(M.view.wantReplay).length) { const m = M.view.wantReplay; M.view.wantReplay = null; startReplay(m); return; }
    const prevM = M.view.m;
    if (!M.view.pinned && !M.view.replay) M.view.m = focusOf(M.view.bot);
    if (M.view.m && M.view.m !== prevM && !M.cs.get(M.view.m) && J.coins[M.view.m]) want(M.view.m, 1);
    renderHero(); renderBots(); renderHead(); renderDoing(); renderChecks(); renderMemes(); renderLab(); renderWatch(); renderTrades(); renderScan(); renderFeed(); renderRules(); renderReplayBar();
    $('snFollow').hidden = !M.view.pinned;
    if (M.view.mode === 'dex') {
      $('snChart').hidden = true; $('snDex').hidden = false; $('snChartEmpty').hidden = true;
      const m = M.view.m, r = m && M.px.get(m), pair = (r && (r.pumpswap || r.pumpfun)) || (J.coins[m] || {}).pool || (J.coins[m] || {}).bc;
      const dark = document.documentElement.dataset.theme === 'dark' || (document.documentElement.dataset.theme !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
      const src = okAddr(pair) ? `https://dexscreener.com/solana/${pair}?embed=1&loadChartSettings=0&trades=0&tabs=0&info=0&chartLeftToolbar=0&chartTheme=${dark ? 'dark' : 'light'}&theme=${dark ? 'dark' : 'light'}&chartStyle=1&chartType=${M.view.unit === 'mc' ? 'marketCap' : 'usd'}&interval=${M.view.tf}` : '';
      const fr = $('snDex').querySelector('iframe');
      if (!src) $('snDex').innerHTML = '<div class="sn-empty">No coin to show yet.</div>';
      else if (!fr || fr.dataset.src !== src) $('snDex').innerHTML = `<iframe title="DexScreener chart" data-src="${esc(src)}" src="${esc(src)}" loading="lazy" referrerpolicy="no-referrer"></iframe>`;
    } else { $('snChart').hidden = false; $('snDex').hidden = true; drawChart(force); }
    renderLegend();
    drawEquity();
  }
  function tick() { renderHero(); renderBots(); renderHeadLive(); renderDoingLive(); }
  function statusOf(b) {
    const B = J.bots[b.id];
    if (B.pos) { const mk = markOf(b); return ['in', `Holding ${B.pos.sym || ''}`, mk]; }
    if (B.pending) return ['wait', `Buying ${(J.coins[B.pending.m] || {}).sym || ''}`];
    const w = B.watch.filter(x => !x.done).length;
    if (w) return ['wait', `Watching ${w} coin${w > 1 ? 's' : ''}`];
    return ['off', 'Scanning'];
  }
  function health() {
    // server mode: the server's own connections to the data sources (this page only fetches charts and live prices)
    const sl = mode === 'server' && SRV.srv && SRV.srv.lanes;
    const rows = sl ? Object.entries(sl).map(([id, a]) => [id, { name: (LANES[id] || {}).name || id, ok: a[0], fail: a[1], lastErr: a[2], lastOk: a[3], lastFail: a[4] }]) : Object.entries(LANES);
    return rows.map(([id, L]) => {
      const st = !L.ok && !L.fail ? 'idle' : L.lastFail > L.lastOk ? (L.lastErr === 'rate limited' ? 'slow' : 'bad') : 'ok';
      return `<span class="sn-api ${st}" title="${esc(L.name)}: ${L.ok} ok, ${L.fail} failed${L.lastErr ? ', last error: ' + esc(L.lastErr) : ''}"><i></i>${esc(L.name)}</span>`;
    }).join('');
  }
  function renderHero() {
    const el = $('snHero'); if (!el) return;
    const b = BOT(M.view.bot), a = acct(b), s = solNow(), st = statusOf(b);
    const wr = a.n ? Math.round(a.wins / a.n * 100) + '%' : '–', liveOk = mode === 'server' ? srvAgeS() < 600 : Date.now() - (LANES.dex.lastOk || 0) < 90000;
    el.style.setProperty('--bc', `var(${b.color})`);
    el.innerHTML = `<div class="sn-hero-l"><div class="sn-title"><h2>Meme Sniper</h2><span class="sn-botname"><i></i>${esc(b.name)}</span><span class="pill ${st[0]}">${esc(st[1])}</span></div>
        <div class="sn-bal"><span class="bal">${sol(a.bal)}</span><span class="pnl ${cls(a.bal - START_SOL)}">${sSol(a.bal - START_SOL)} (${sPct((a.bal - START_SOL) / START_SOL)})</span></div>
        <div class="note">≈ ${fmtUsd(a.bal * s)} at ${fmtUsd(s)} per SOL · started with ${START_SOL} paper SOL ${fDT(J.start)} ET</div>
        <div class="sn-status"><span class="dot ${liveOk ? 'ok' : ''}"></span>${esc(statusLine())}</div></div>
      <div class="sn-hero-r"><div class="minis sn-minis"><div><div class="k">Trades</div><div class="v">${a.n}</div></div><div><div class="k">Win rate</div><div class="v">${wr}</div></div><div><div class="k">In a coin</div><div class="v ${a.mk ? cls(a.mk.net) : ''}">${a.mk ? sSol(a.mk.net) : '–'}</div></div>
        <div><div class="k">Avg win</div><div class="v">${sPct(a.avgW)}</div></div><div><div class="k">Avg loss</div><div class="v">${sPct(a.avgL)}</div></div><div><div class="k">Max drop</div><div class="v">${a.n || a.mk ? (a.mdd * 100).toFixed(1) + '%' : '–'}</div></div></div>
        <div class="sn-apis">${health()}</div></div>`;
  }
  function scanLine() { return `Following ${M.young.size} new coins · ${M.crossed} crossed $7K since this page opened · ${M.seen} launches seen`; }
  function statusLine() {
    if (mode === 'server') {
      const a = srvAgeS();
      if (!isFinite(a)) return 'Connecting to the bot server on GitHub…';
      if (a > 15 * 60) return `The bot server last reported ${age(a)} ago. GitHub restarts it on its own, usually within 30 minutes; this shows its last state.`;
      return `Running 24/7 on GitHub’s servers · updated ${age(a)} ago · following ${youngCount()} new coins · ${(J.n.launch || 0).toLocaleString('en-US')} launches seen`;
    }
    if (mode === 'local') return leader ? scanLine() : 'Another tab of this browser is running the bots. This tab shows what they do.';
    return 'Connecting…';
  }
  function renderBots() {
    const el = $('snBots'); if (!el) return;
    el.innerHTML = BOTS.map(b => {
      const a = acct(b), st = statusOf(b), on = b.id === M.view.bot;
      return `<button class="sn-botchip${on ? ' on' : ''}" data-bot="${b.id}" role="tab" aria-selected="${on}" style="--bc:var(${b.color})"><span class="nm"><i></i>${esc(b.name)}</span><span class="bl">${a.bal.toFixed(3)}</span><span class="st ${st[0]}">${esc(st[1])}</span></button>`;
    }).join('');
  }
  function coinStats(m) {
    const k = J.coins[m] || {}, r = M.px.get(m) || {}, cs = candlesFor(m);
    const ath = cs.length ? Math.max(...cs.map(x => x[2])) * E.SUPPLY : NaN, last = cs.length ? cs[cs.length - 1][4] * E.SUPPLY : NaN;
    const mc = r.mc > 0 && nowS() - r.t < 120 ? r.mc : last;
    return { k, r, mc, ath: Math.max(ath || 0, mc || 0) || NaN, grad: graduated(m) };
  }
  function renderHead() {
    const el = $('snHead'); if (!el) return;
    const m = M.view.m;
    if (!m) { el.innerHTML = `<div class="sn-coin"><div class="sn-noicon">?</div><div><div class="sn-sym">No coin yet</div><div class="note">The bots are scanning new pump.fun launches. A coin shows up here once one passes every check.</div></div></div>`; return; }
    const { k, mc, ath, grad } = coinStats(m), r = M.px.get(m) || {}, pair = r.pumpswap || r.pumpfun || k.pool || k.bc;
    const icon = k.icon ? `<img src="${esc(k.icon)}" alt="" width="44" height="44" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.visibility='hidden'">` : `<div class="sn-noicon">${esc((k.sym || '?').slice(0, 2))}</div>`;
    const prog = E.curveProgress((mc || 0) / solNow());
    const links = [okAddr(pair) && ['DexScreener', `https://dexscreener.com/solana/${pair}`], ['pump.fun', `https://pump.fun/coin/${m}`], ['Solscan', `https://solscan.io/token/${m}`], ['RugCheck', `https://rugcheck.xyz/tokens/${m}`], ['GeckoTerminal', `https://www.geckoterminal.com/solana/pools/${okAddr(pair) ? pair : k.bc}`]].filter(Boolean);
    el.innerHTML = `<div class="sn-coin">${icon}<div class="sn-coin-main"><div class="sn-sym">${esc(k.sym || short(m))} <span class="sn-name">${esc(k.name || '')}</span>${M.view.pinned ? '<span class="pill">pinned</span>' : ''}</div>
      <div class="sn-meta"><span>MC <b id="snMc">${fmtMc(mc)}</b></span><span>High <b>${fmtMc(ath)}</b></span><span>Age <b id="snAge">${age(nowS() - (k.t || nowS()))}</b></span>${k.holders ? `<span>Holders <b>${k.holders}</b></span>` : ''}${r.m5 ? `<span>5 min <b>${r.m5.b} buys / ${r.m5.s} sells</b></span>` : ''}</div>
      <div class="sn-curve" title="Bonding curve progress: at 100% the coin graduates to PumpSwap">${grad ? '<span class="pill in">Graduated to PumpSwap</span>' : `<div class="sn-bar"><i style="width:${(prog * 100).toFixed(1)}%"></i></div><span>Bonding curve ${(prog * 100).toFixed(0)}%</span>`}</div>
      <div class="sn-links">${links.map(([n, u]) => `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${n}</a>`).join('')}<span class="mono note">${short(m)}</span></div></div></div>`;
  }
  function renderHeadLive() { const m = M.view.m; if (!m) return; const a = $('snMc'), g = $('snAge'); if (a) a.textContent = fmtMc(coinStats(m).mc); if (g) g.textContent = age(nowS() - ((J.coins[m] || {}).t || nowS())); }
  function renderDoing() {
    const el = $('snDoing'); if (!el) return;
    const b = BOT(M.view.bot), B = J.bots[b.id], s = solNow();
    let h;
    if (B.pos) {
      const p = B.pos, k = J.coins[p.m] || {}, mk = markOf(b), curve = !graduated(p.m);
      const tp = (curve ? p.tpCurve : p.tpPool) * s * E.SUPPLY, sl = p.slSol * s * E.SUPPLY, floor = E.CURVE_FLOOR * s * E.SUPPLY;
      const lo = Math.max(sl, curve ? floor : 0) || sl, span = isFinite(tp) && tp > lo ? Math.log(tp) - Math.log(lo) : NaN;
      const at = v => isFinite(span) && v > 0 ? Math.max(0, Math.min(1, (Math.log(v) - Math.log(lo)) / span)) : 0;
      const pos = mk ? at(mk.mc) : 0, ent = at(p.entryMc);
      const floorVal = curve ? E.sell(p.qty, E.CURVE_FLOOR, true, b.P.exec).sol : NaN;
      const stopNote = curve && sl < floor ? `<div class="sn-warn">On the bonding curve this coin can't fall below about ${fmtMc(floor)} market cap, so the stop at ${fmtMc(sl)} can't be reached here. Worst case on the curve: ${sSol(floorVal - p.cost)}.${b.P.maxHold ? '' : ' With no time limit, this bot holds until it is profitable.'}</div>` : '';
      h = `<h3>Holding ${esc(k.sym || p.sym)}</h3>
        <div class="sn-big ${mk ? cls(mk.net) : ''}" id="snPnl">${mk ? sSol(mk.net) : '–'} <span>${mk ? sPct(mk.ret) : ''}</span></div>
        <div class="note">If sold right now, after fees and price impact. Held <span id="snHeld">${age(nowS() - p.entryT)}</span>${b.P.maxHold ? `, sells at ${fT(p.entryT + b.P.maxHold * 60)} at the latest` : ''}.</div>
        <div class="sn-range"><div class="sn-range-bar"><i class="ent" style="left:${(ent * 100).toFixed(1)}%"></i><i class="now" id="snNow" style="left:${(pos * 100).toFixed(1)}%"></i></div><div class="sn-range-l"><span class="down">${fmtMc(lo)}${lo > sl ? ' floor' : ' stop'}</span><span class="up">${fmtMc(tp)} target</span></div></div>
        <dl class="sn-dl"><dt>Bought</dt><dd>${sol(p.cost, 2)} at ${fmtMc(p.entryMc)}, ${fT(p.entryT)}</dd><dt>Sells at</dt><dd class="up">${fmtMc(tp)} (${sPct(tp / p.entryMc - 1, 0)})</dd><dt>Stop</dt><dd class="down">${fmtMc(sl)} (${Math.round((1 - b.P.sl) * 100)}% of the buy)</dd><dt>Costs paid</dt><dd>fee ${sol(p.fee, 4)}, impact ${sPct(p.impact)}</dd></dl>${stopNote}`;
    } else if (B.pending) {
      const k = J.coins[B.pending.m] || {};
      h = `<h3>Dip hit: buying ${esc(k.sym)}</h3><div class="sn-big">${fmtMc(B.pending.mc)} <span>buy zone reached at ${fT(B.pending.entryT)}</span></div><div class="note">Confirming once that minute's candle is final and the other watched coins are checked for an earlier dip.</div>`;
    } else {
      const ws = B.watch.filter(w => !w.done);
      if (ws.length) {
        const m = M.view.m, w = ws.find(x => x.m === m) || ws[0], k = J.coins[w.m] || {}, r = M.px.get(w.m) || {};
        const H = Math.max(w.H || 0, liveHigh(w.m)), trig = (1 - b.P.dip) * H, dist = r.price > 0 && trig > 0 ? 1 - trig / r.price : NaN;
        const inZone = !w.wait && isFinite(dist) && dist <= 0;
        const need = w.wait ? `back above ${fmtMc(trig * E.SUPPLY)} first` : isFinite(dist) ? (dist > 0 ? `needs ${sPct(-dist, 0)} more` : 'in the buy zone') : '';
        h = `<h3>Waiting for a ${Math.round(b.P.dip * 100)}% dip</h3><div class="sn-big">${esc(k.sym)} <span>${need}</span></div>
          <div class="note">${inZone ? `<b class="warn">The price is in the buy zone.</b> The buy is booked at the buy-zone price once this minute’s candle is final (GeckoTerminal updates about once a minute).` : b.P.entry === 'green' ? 'After the dip it buys at the close of the first green 1-minute candle.' : 'It buys the moment the price touches the buy zone.'} ${ws.length > 1 ? `Watching ${ws.length} coins; the first to dip wins.` : ''}</div>
          <dl class="sn-dl"><dt>High so far</dt><dd>${fmtMc(H * E.SUPPLY)}</dd><dt>Buy zone</dt><dd class="warn">${fmtMc(trig * E.SUPPLY)} (−${Math.round(b.P.dip * 100)}%)</dd><dt>Now</dt><dd>${fmtMc(r.mc)}</dd><dt>Watch ends</dt><dd>${fT(w.to)} (${age(w.to - nowS())})</dd></dl>`;
      } else {
        const last = Object.values(J.coins).filter(k => k.x).sort((a, b2) => b2.x - a.x)[0];
        const why = last && last.status === 'fail' && last.why && last.why[b.id] ? last.why[b.id][0] : '';
        h = `<h3>Scanning</h3><div class="sn-big">${youngCount()} <span>new coins followed</span></div><div class="note">No coin passes every check right now. ${last ? `Last one checked: ${esc(last.sym)} at ${fT(last.x)}${why ? `, skipped (${esc(why)})` : ''}.` : 'Waiting for the first coin to cross $7K.'}</div>`;
      }
    }
    el.innerHTML = h;
  }
  function renderDoingLive() {
    const b = BOT(M.view.bot), B = J.bots[b.id]; if (!B.pos) return;
    const mk = markOf(b), el = $('snPnl'), hd = $('snHeld');
    if (el && mk) { el.className = 'sn-big ' + cls(mk.net); el.innerHTML = `${sSol(mk.net)} <span>${sPct(mk.ret)}</span>`; }
    if (hd) hd.textContent = age(nowS() - B.pos.entryT);
  }
  function renderChecks() {
    const el = $('snChecks'); if (!el) return;
    const m = M.view.m, k = m && J.coins[m], b = BOT(M.view.bot);
    if (!k) { el.innerHTML = '<h3>Rug checks</h3><p class="note">Every coin gets these checks the moment it crosses $7K market cap.</p>'; return; }
    if (!k.audit || !k.rc) { el.innerHTML = `<h3>Rug checks: ${esc(k.sym)}</h3><p class="note">Checking…</p>`; return; }
    const cs = checksOf(k, b.C), a = k.audit || {}, soc = k.soc || {};
    const info = [['Dev launched before', a.devMints != null ? `${a.devMints} coin${a.devMints === 1 ? '' : 's'}${a.devMigrations ? `, ${a.devMigrations} graduated` : ''}` : '–'], ['Holders at the check', k.holders || '–'], ['Socials', [soc.tw && 'X', soc.web && 'web', soc.tg && 'Telegram'].filter(Boolean).join(', ') || 'none'], ['Organic score', k.org != null ? Math.round(k.org) : '–']];
    el.innerHTML = `<h3>Rug checks: ${esc(k.sym)} <span class="pill ${k.ok && k.ok[b.id] ? 'in' : 'off'}">${k.ok && k.ok[b.id] ? 'passed' : 'failed'}</span></h3><div class="note">Taken at ${fT(k.x)}, when it crossed $7K. Thresholds of “${esc(b.name)}”.</div>
      <ul class="sn-checks">${cs.map(c => `<li class="${c.ok ? 'ok' : 'bad'}" title="${esc(c.tip || '')}"><span class="ic">${c.ok ? '✓' : '✗'}</span><span>${esc(c.label)}</span><span class="v">${esc(c.v)}</span></li>`).join('')}</ul>
      <dl class="sn-dl">${info.map(([a1, b1]) => `<dt>${esc(a1)}</dt><dd>${esc(b1)}</dd>`).join('')}</dl>
      ${k.rc && k.rc.risks && k.rc.risks.length ? `<details><summary>All RugCheck flags (${k.rc.risks.length})</summary><p>${k.rc.risks.map(r => esc(`${r[0]} (${r[1]})`)).join('<br>')}</p></details>` : ''}`;
  }
  function trending() {
    const t = nowS(), cnt = new Map();
    for (const [tc, , ws] of J.cross) if (t - tc < META_S) for (const w of ws) cnt.set(w, (cnt.get(w) || 0) + 1);
    return [...cnt.entries()].filter(x => x[1] >= 2).sort((a, b) => b[1] - a[1]).slice(0, 20);
  }
  function renderMemes() {
    const el = $('snMemes'); if (!el) return;
    const tr = trending(), m = M.view.m, k = m && J.coins[m], n = J.cross.filter(c => nowS() - c[0] < META_S).length;
    el.innerHTML = `<h3>Current memes</h3><div class="note">Name words shared by coins that crossed $7K in the last 2 hours (${n} coin${n === 1 ? '' : 's'}${J.cross.some(c => c[3]) ? ', some from Jupiter’s trending lists while this page warmed up' : ''}).</div>
      <div class="sn-chips">${tr.length ? tr.map(([w, c]) => `<span class="chip${k && k.words && k.words.includes(w) ? ' on' : ''}">${esc(w)} <b>${c}</b></span>`).join('') : '<span class="note">Not enough coins yet.</span>'}</div>`;
  }
  function renderLab() {
    const el = $('snLab'); if (!el) return;
    const rows = BOTS.map(b => ({ b, a: acct(b), st: statusOf(b) }));
    const best = rows.filter(r => r.a.n >= 5).sort((x, y) => y.a.bal - x.a.bal)[0];
    el.innerHTML = `<table class="sn-lab"><thead><tr><th>Bot</th><th class="n">Balance</th><th class="n">P&amp;L</th><th class="n">Trades</th><th class="n">Wins</th><th class="n x">Avg win</th><th class="n x">Avg loss</th><th class="n x">Worst</th><th class="x">Now</th></tr></thead><tbody>${rows.map(({ b, a, st }) => `
      <tr class="${b.id === M.view.bot ? 'open' : ''}" data-bot="${b.id}" style="--bc:var(${b.color})"><td><span class="botchip"><i></i>${esc(b.name)}</span>${best && best.b === b ? ' <span class="pill in">best so far</span>' : ''}<div class="note x">${esc(b.diff)}</div></td>
      <td class="n"><b>${a.bal.toFixed(3)}</b></td><td class="n ${cls(a.bal - START_SOL)}">${sSol(a.bal - START_SOL)}</td><td class="n">${a.n}</td><td class="n">${a.n ? Math.round(a.wins / a.n * 100) + '%' : '–'}</td>
      <td class="n x">${sPct(a.avgW)}</td><td class="n x">${sPct(a.avgL)}</td><td class="n x">${sPct(a.worst)}</td><td class="x">${esc(st[1])}${a.mk ? ` <span class="${cls(a.mk.net)}">${sPct(a.mk.ret)}</span>` : ''}</td></tr>`).join('')}</tbody></table>`;
    const tot = sum(rows.map(r => r.a.n));
    $('snLabNote').textContent = (tot < 30 ? `Only ${tot} trade${tot === 1 ? '' : 's'} so far across all bots. A few lucky or unlucky trades decide these numbers; wait for dozens of trades per bot before reading much into them.` : `Balances include open positions at their sell-now value. Every bot started with ${START_SOL} SOL ${mode === 'server' ? 'on the server' : 'here'} on ${fDT(J.start)} ET.`) + (mode === 'server' && prevRun ? ' ' + prevRun : '');
  }
  function renderWatch() {
    const el = $('snWatch'); if (!el) return;
    const b = BOT(M.view.bot), B = J.bots[b.id];
    const live = B.watch.filter(w => !w.done), old = B.watch.filter(w => w.done).slice(-6).reverse();
    $('snWatchSub').textContent = `Coins that passed every check for “${b.name}”. It buys the first one to drop ${Math.round(b.P.dip * 100)}% from its high, one coin at a time.`;
    if (!live.length && !old.length) { el.innerHTML = '<div class="empty">Nothing on the watchlist yet. Coins appear here when they pass every check.</div>'; return; }
    const row = w => {
      const k = J.coins[w.m] || {}, r = M.px.get(w.m) || {}, H = Math.max(w.H || 0, w.done ? 0 : liveHigh(w.m)), dd = r.price > 0 && H > 0 ? 1 - r.price / H : NaN;
      const fill = isFinite(dd) ? Math.max(0, Math.min(1, dd / b.P.dip)) : 0;
      const st = !w.done ? (w.drop ? 'swapped for a stronger coin' : B.pos ? `bot busy with ${B.pos.sym || 'a coin'}` : w.wait ? 'under the zone: waits for a bounce first' : `ends ${fT(w.to)}`) : w.done === 'dropped' ? 'swapped for a stronger coin' : w.done === 'bought' ? 'bought' : w.done === 'nodip' ? `no ${Math.round(b.P.dip * 100)}% dip in 2 h` : w.done === 'nodata' ? 'no candle data' : 'missed: bot was busy';
      return `<div class="sn-wrow${w.m === M.view.m ? ' on' : ''}${w.done ? ' done' : ''}"><button class="sn-link" data-coin="${esc(w.m)}">${esc(k.sym || short(w.m))}</button>
        <div class="sn-dip">${w.done ? '' : `<div class="sn-dipbar"><i style="width:${(fill * 100).toFixed(1)}%" class="${fill >= 1 ? 'hit' : ''}"></i><b style="left:100%"></b></div><span>${isFinite(dd) ? sPct(-dd, 0) : ''}</span>`}</div>
        <span class="n">${fmtMc(r.mc)}</span><span class="note">${esc(st)}</span></div>`;
    };
    el.innerHTML = `<div class="sn-wlist"><div class="sn-whead"><span>Coin</span><span>Drop from its high (buy at −${Math.round(b.P.dip * 100)}%)</span><span class="n">MC now</span><span>Status</span></div>${live.map(row).join('')}${old.map(row).join('')}</div>`;
  }
  function renderTrades() {
    const el = $('snTrades'); if (!el) return;
    const b = BOT(M.view.bot), B = J.bots[b.id], mk = markOf(b);
    const rows = B.trades.slice().reverse();
    const open = B.pos ? `<tr class="open"><td><button class="sn-link" data-coin="${esc(B.pos.m)}">${esc(B.pos.sym || '')}</button></td><td class="n">${fDT(B.pos.entryT)}</td><td class="n">${fmtMc(B.pos.entryMc)}</td><td class="n">open</td><td class="n">${mk ? fmtMc(mk.mc) : '–'}</td><td class="n ${mk ? cls(mk.net) : ''}">${mk ? sSol(mk.net) : '–'}<div class="note">${mk ? sPct(mk.ret) : ''}</div></td><td>holding ${age(nowS() - B.pos.entryT)}</td><td></td></tr>` : '';
    if (!rows.length && !open) { el.innerHTML = `<div class="empty">No trades yet for “${esc(b.name)}”.</div>`; return; }
    el.innerHTML = `<table><thead><tr><th>Coin</th><th class="n">Bought (ET)</th><th class="n">Buy MC</th><th class="n">Sold (ET)</th><th class="n">Sell MC</th><th class="n">P&amp;L</th><th>Why it sold</th><th></th></tr></thead><tbody>${open}${rows.map(x => `<tr><td><button class="sn-link" data-coin="${esc(x.m)}">${esc(x.sym || short(x.m))}</button></td><td class="n">${fDT(x.entryT)}</td><td class="n">${fmtMc(x.entryMc)}</td><td class="n">${fDT(x.exitT)}</td><td class="n">${fmtMc(x.exitMc)}</td><td class="n ${cls(x.net)}"><b>${sSol(x.net)}</b><div class="note">${sPct(x.ret)}</div></td><td>${x.out === 'tp' ? 'Profit target' : x.out === 'sl' ? 'Stop' : 'Time limit'} after ${age(x.exitT + 60 - x.entryT)}</td><td><button class="sn-replay" data-replay="${esc(x.m)}" data-rbot="${b.id}">Replay</button></td></tr>`).join('')}</tbody></table>`;
  }
  function renderScan() {
    const el = $('snScan'); if (!el) return;
    const ks = Object.values(J.coins).filter(k => k.x).sort((a, b) => b.x - a.x).slice(0, 30), b = BOT(M.view.bot);
    $('snScanSub').textContent = `New pump.fun coins as they cross $7K market cap, and what “${b.name}” decided. Checked once, at the crossing.`;
    $('snFunnel').innerHTML = [['Launches seen', J.n.launch], ['Crossed $7K', J.n.cross], ['Passed checks', J.n.pass], ['Bought', J.bots[b.id].trades.length + (J.bots[b.id].pos ? 1 : 0)]].map(([a, v]) => `<div><div class="k">${a}</div><div class="v">${v}</div></div>`).join('');
    if (!ks.length) { el.innerHTML = '<div class="empty">No coin has crossed $7K yet. New launches are being followed.</div>'; return; }
    el.innerHTML = `<table class="sn-scan"><thead><tr><th>Coin</th><th class="n">Crossed</th><th class="n sn-age">Age then</th><th>Decision</th></tr></thead><tbody>${ks.map(k => {
      const ok = k.ok && k.ok[b.id], why = (k.why && k.why[b.id]) || [];
      return `<tr><td><button class="sn-link" data-coin="${esc(k.m)}">${esc(k.sym || short(k.m))}</button></td><td class="n">${fT(k.x)}</td><td class="n sn-age">${age(k.x - k.t)}</td><td>${k.status === 'checking' ? 'checking…' : ok ? '<span class="up">passed, watching</span>' : `<span class="note">skipped: ${esc(why.slice(0, 2).join(', '))}</span>`}</td></tr>`;
    }).join('')}</tbody></table>`;
  }
  function renderFeed() {
    const el = $('snFeed'); if (!el) return;
    const evs = J.ev.slice(-100).reverse();
    el.innerHTML = evs.length ? evs.map(e => { const b = e[1] ? BOT(e[1]) : null; return `<div class="sn-ev ${esc(e[2])}"${b ? ` style="--bc:var(${b.color})"` : ''}><span class="mono">${fTS(e[0] / 1000)}</span><span>${e[4] ? `<button class="sn-link" data-coin="${esc(e[4])}">${esc(e[3])}</button>` : esc(e[3])}</span></div>`; }).join('') : '<div class="empty">Nothing yet.</div>';
  }
  function renderLegend() {
    const el = $('snLegend'); if (!el) return;
    el.innerHTML = M.view.mode === 'dex' ? 'DexScreener’s own live chart of the same coin. The bots’ buys and sells are on the other view.' :
      `1-minute candles from GeckoTerminal: the exact data the bots trade on. The last candle moves with DexScreener’s live price. <span class="lg buy">Buy</span><span class="lg sell">Sell</span><span class="lg trig">Buy zone</span><span class="lg tp">Sell target</span><span class="lg sl">Stop</span>`;
  }
  function renderReplayBar() {
    const el = $('snReplay'); if (!el) return;
    const R = M.view.replay;
    el.hidden = !R;
    if (R) el.innerHTML = `<span class="pill wait">Replay</span><span>${esc((J.coins[R.m] || {}).sym || '')} at ${fDT(R.t)} ET${R.done ? ' (end)' : ''}</span><button id="snReplayStop" class="sn-follow">Back to live</button>`;
  }
  function renderRules() {
    const el = $('snRules'); if (!el || el.dataset.done === mode + J.start) return;
    el.dataset.done = mode + J.start;
    const b = BOTS[0];
    el.innerHTML = `<h2>Meme Sniper rules (locked ${fDT(LOCKED)} ET)</h2>
      <ol class="steps">
        <li><b>Scan:</b> every new pump.fun coin paired with SOL is followed on DexScreener for its first 75 minutes (dropped at 20 minutes if it never reached $4.5K).</li>
        <li><b>$7K and the checks:</b> when its market cap crosses $7,000 the coin is checked once: mint and freeze authority revoked, dev wallet ${b.C.devMax}% or less, top holders ${b.C.topMax}% or less (when Jupiter reports it), no RugCheck “danger” flag, and on a current meme (another coin with one of its name words crossed $7K in the last 2 hours).</li>
        <li><b>Buy only on a 40% dip:</b> a coin that passes is watched for 2 hours. A bot buys ${b.P.stake} SOL the moment the price touches 40% under the highest price since launch. Each bot holds one coin at a time; the first watched coin to dip wins.</li>
        <li><b>Sell:</b> as soon as selling returns more than the buy cost, plus 1% (after all costs), or when the price falls to 10% of the buy price.</li>
        <li><b>Costs on every trade:</b> pump.fun’s 1.25% fee, 1% for slippage and priority fees, and the price impact of the bot’s own order on the bonding curve (exact curve math). Buying and selling at the same price loses about 8% at $7K market cap, so “profitable” needs about a 10% bounce.</li>
      </ol>
      <p><b>Something to know about the 10% stop:</b> on the bonding curve a coin can’t fall below about ${fmtMc(E.CURVE_FLOOR * solNow() * E.SUPPLY)} market cap (the price when nobody holds any bought tokens). So for buys under roughly ${fmtMc(10 * E.CURVE_FLOOR * solNow() * E.SUPPLY)}, the stop at 10% of the buy can’t trigger; a coin that dies just sits near the floor. With no time limit, your rules then hold it until it is profitable, which may be never. That’s why the lab tests time limits.</p>
      <h3>The strategy lab</h3>
      <ul class="steps">${BOTS.map(x => `<li><span class="botchip" style="--bc:var(${x.color})"><i></i>${esc(x.name)}</span>: ${esc(x.diff)}</li>`).join('')}</ul>
      <p class="muted">${mode === 'server' ? `The bots run 24/7 on GitHub’s servers (<a href="https://github.com/${SERVER.repo}" target="_blank" rel="noopener noreferrer">github.com/${SERVER.repo}</a>), whether or not this page is open. Each started with ${START_SOL} paper SOL on ${fDT(J.start)} ET. This page loads their state about every 90 seconds and draws the live chart in your browser. Each server run lasts about 6 hours and hands over to the next; if the server misses time, the coins the bots held or watched are replayed from their 1-minute candles, and launches in that gap are not scanned.` : `Each bot starts with ${START_SOL} paper SOL in this browser and trades only while this page is open in one tab. When you come back, the coins they held or watched are replayed from their 1-minute candles, so a sell that happened while you were away shows up at the right time and price. Launches during that time are not scanned.`} Data: Jupiter (new coins, audit), DexScreener (market caps, live price), RugCheck, GeckoTerminal (1-minute candles), Coinbase (SOL price). Nothing here touches a real wallet.</p>`;
  }
  function onShow() { render(true); setTimeout(() => { if (CH.chart) CH.chart.timeScale().scrollToRealTime(); }, 60); }
  function _near() {
    const out = {};
    for (const b of BOTS) { const B = J.bots[b.id]; out[b.id] = { pos: B.pos ? [B.pos.sym, nearExit(b, B)] : null, watch: B.watch.filter(w => !w.done).map(w => [(J.coins[w.m] || {}).sym, nearBuy(w, b), !!w.wait, w.trig, (M.px.get(w.m) || {}).price, (M.cs.get(w.m) || {}).fin, liveSince(w.m, (M.cs.get(w.m) || {}).fin || 0)]) }; }
    return out;
  }
  return { start, onShow, render, _J: () => J, _M: M, _lanes: () => LANES, _step: stepAll, _leader: () => leader, _near, _mode: () => mode, _srv: () => SRV, _core: C, BOTS };
})();
