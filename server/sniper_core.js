/* Meme Sniper core (v10.1): the live paper bots for brand-new pump.fun coins, shared by the page and the server.
   One copy of the logic runs in a browser tab (local mode), on GitHub Actions (server mode) and in the simulator.
   The host supplies the clock, HTTP and storage, so nothing here touches the DOM, localStorage or real time.
   Every buy and sell is decided on final 1-minute candles (GeckoTerminal), so coins the bots held or watched while
   they were not running are replayed from their candles when they come back. Paper only: no wallet, no orders. */
const SNIPER_CORE = (() => {
  const E = typeof SNIPER !== 'undefined' ? SNIPER : require('./sniper.js');
  const { START_SOL, BOTS, FOLLOW_S, DEAD_S, DEAD_MC, CROSS_MC, WATCH_S, META_S, SLOTS } = E.RULES;
  const API = { jup: 'https://lite-api.jup.ag/tokens/v2', dex: 'https://api.dexscreener.com', gt: 'https://api.geckoterminal.com/api/v2', rc: 'https://api.rugcheck.xyz/v1', cb: 'https://api.exchange.coinbase.com' };
  const ADDR = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  const okAddr = a => typeof a === 'string' && ADDR.test(a);
  const safeUrl = u => { try { const x = new URL(u); return x.protocol === 'https:' ? x.href : ''; } catch (e) { return ''; } };
  const MINUS = '−';
  const fmtMc = v => !isFinite(v) ? '–' : v >= 1e9 ? '$' + (v / 1e9).toFixed(2) + 'B' : v >= 1e6 ? '$' + (v / 1e6).toFixed(2) + 'M' : v >= 1e5 ? '$' + (v / 1e3).toFixed(0) + 'K' : v >= 1e3 ? '$' + (v / 1e3).toFixed(1) + 'K' : '$' + v.toFixed(0);
  const sol = (v, d = 3) => isFinite(v) ? v.toFixed(d) + ' SOL' : '–';
  const sSol = (v, d = 3) => !isFinite(v) ? '–' : (v > 0.0005 ? '+' : v < -0.0005 ? MINUS : '') + Math.abs(v).toFixed(d) + ' SOL';
  const sPct = (v, d = 1) => !isFinite(v) ? '–' : (v > 0.00005 ? '+' : v < -0.00005 ? MINUS : '') + Math.abs(v * 100).toFixed(d) + '%';
  const age = s => !isFinite(s) ? '–' : s < 60 ? Math.max(0, Math.round(s)) + 's' : s < 3600 ? Math.floor(s / 60) + 'm' : s < 86400 ? Math.floor(s / 3600) + 'h ' + String(Math.floor(s % 3600 / 60)).padStart(2, '0') + 'm' : Math.floor(s / 86400) + 'd ' + Math.floor(s % 86400 / 3600) + 'h';
  const sum = a => a.reduce((x, y) => x + y, 0);
  const minute = t => Math.floor(t / 60) * 60;

  /* env: { now(): ms, sleep(ms): Promise, http(url): Promise<{ status, json }>, and optional hooks:
     leader() (runs the bots?), stillLeader(), save(force), dirty(), toast(bot, kind, title, text, mint), liveBar(),
     visible(), gapText(ageText), onDecide(coin), gtIdle(): Promise<bool> (uses a free GeckoTerminal slot) } */
  function create(env) {
    const H = Object.assign({ leader: () => true, stillLeader: () => true, save() {}, dirty() {}, toast() {}, liveBar() {}, visible: () => false,
      gapText: a => `The bots were offline for ${a}. Coins they held or watched are caught up from their 1-minute candles; launches in that time were not scanned.`,
      onDecide: null, gtIdle: null }, env);
    const nowMs = () => env.now();
    const nowS = () => env.now() / 1000;
    const sleep = ms => env.sleep(ms);
    let stopped = false;

    // -------------------------------------------------------------- rate-limited requests, one lane per API
    // GeckoTerminal's free API allows about 10 calls a minute per IP, so its lane adapts: slower after a 429, faster after successes.
    const LANES = { jup: { gap: 1300, name: 'Jupiter' }, dex: { gap: 260, name: 'DexScreener' }, gt: { gap: 7500, min: 7500, max: 20000, name: 'GeckoTerminal' }, rc: { gap: 2100, name: 'RugCheck' }, cb: { gap: 350, name: 'Coinbase' } };
    for (const L of Object.values(LANES)) Object.assign(L, { next: 0, q: Promise.resolve(), ok: 0, fail: 0, lastErr: '', lastOk: 0, lastFail: 0, run: 0, limited: 0 });
    function getJSON(lane, url) {
      const L = LANES[lane];
      const p = L.q.then(async () => {
        const w = L.next - nowMs(); if (w > 0) await sleep(w);
        L.next = nowMs() + L.gap;
        try {
          const r = await env.http(url);
          if (r.status === 429) {
            L.limited++; L.run = 0; L.next = nowMs() + 30000;
            if (L.max) L.gap = Math.min(L.max, Math.round(L.gap * 1.4));
            throw new Error('rate limited');
          }
          if (r.status === 404) { L.ok++; L.lastOk = nowMs(); return null; }
          if (!(r.status >= 200 && r.status < 300)) throw new Error('HTTP ' + r.status);
          L.ok++; L.lastOk = nowMs();
          if (L.min && ++L.run >= 10) { L.run = 0; L.gap = Math.max(L.min, L.gap - 300); }
          return r.json;
        } catch (e) { L.fail++; L.lastFail = nowMs(); L.lastErr = String(e && e.message || e).slice(0, 80); throw e; }
      });
      L.q = p.catch(() => {});
      return p;
    }

    // -------------------------------------------------------------- journal (the bots' state; the host persists it)
    function newBot() { return { free: minute(nowS()), watch: [], trades: [], pos: null }; }
    function fresh() {
      const bots = {}; for (const b of BOTS) bots[b.id] = newBot();
      return { v: 2, start: nowS(), last: nowS(), coins: {}, cross: [], bots, ev: [], tc: {}, n: { launch: 0, cross: 0, pass: 0 }, boot: false };
    }
    function fixup(j) {
      for (const b of BOTS) if (!j.bots[b.id]) j.bots[b.id] = newBot();
      j.tc = j.tc || {}; j.n = j.n || { launch: 0, cross: 0, pass: 0 };
      return j;
    }
    let J = fresh();
    function setJ(j) { J = fixup(j); return J; }
    const save = force => H.save(force);
    function refs() {
      const keep = new Set();
      for (const B of Object.values(J.bots)) { if (B.pos) keep.add(B.pos.m); for (const w of B.watch) keep.add(w.m); for (const tr of B.trades) keep.add(tr.m); }
      return keep;
    }
    function prune() {
      const t = nowS();
      for (const B of Object.values(J.bots)) B.watch = B.watch.filter(w => !w.done || w.done === 'bought' || t - w.to < 6 * 3600);
      const keep = refs();
      for (const [m, k] of Object.entries(J.coins)) if (!keep.has(m) && t - (k.x || k.t || 0) > META_S + 1800) delete J.coins[m];
      J.cross = J.cross.filter(c => t - c[0] < META_S + 600);
      if (J.ev.length > 500) J.ev = J.ev.slice(-500);
      const tcKeys = Object.keys(J.tc);
      if (tcKeys.length > 40) { tcKeys.sort((a, b) => (J.tc[a].u || 0) - (J.tc[b].u || 0)); for (const m of tcKeys.slice(0, tcKeys.length - 40)) delete J.tc[m]; }
    }
    function pruneHard() { J.ev = J.ev.slice(-150); const ks = Object.keys(J.tc); ks.sort((a, b) => (J.tc[a].u || 0) - (J.tc[b].u || 0)); for (const m of ks.slice(0, Math.max(0, ks.length - 12))) delete J.tc[m]; }
    function ev(bot, kind, text, m) { J.ev.push([nowMs(), bot || '', kind, text, m || null]); H.dirty(); }

    // -------------------------------------------------------------- memory-only state
    const M = {
      young: new Map(),     // coins followed until they cross $7k or die
      youngPtr: 0,
      cs: new Map(),        // mint -> { f: fetch time, fin: candles starting before fin are final, cs: candles, miss: 404 count }
      px: new Map(),        // mint -> { t, price (USD), mc, pumpfun, pumpswap, pair, liq, m5 }
      solPx: new Map(),     // minute -> SOL/USD close
      solNow: NaN,
      gtQ: new Map(),       // mint -> priority (lower = sooner)
      checkQ: [], rcQ: [],
      started: nowS(), seen: 0, crossed: 0, lastFocus: {},
      view: { bot: 'U', m: null, pinned: false, mode: 'chart', unit: 'mc', tf: 1, replay: null },
      errors: [], toasts: [],
      tc: new Map(),        // trade candles loaded from the server (page in server mode)
    };
    function note(s) { M.errors.push([nowMs(), String(s).slice(0, 120)]); if (M.errors.length > 40) M.errors.shift(); }

    // -------------------------------------------------------------- SOL/USD (Coinbase 1-minute closes)
    async function solRange(from, to) {
      from = minute(from); to = minute(to);
      for (let s = from; s <= to; s += 300 * 60) {
        const e = Math.min(to, s + 299 * 60);
        let gap = false; for (let t = s; t <= e; t += 60) if (!M.solPx.has(t) && t + 120 < nowS()) { gap = true; break; }
        if (!gap) continue;
        const j = await getJSON('cb', `${API.cb}/products/SOL-USD/candles?granularity=60&start=${new Date(s * 1000).toISOString()}&end=${new Date(e * 1000).toISOString()}`);
        if (Array.isArray(j)) for (const k of j) if (+k[4] > 0) M.solPx.set(k[0], +k[4]);
      }
    }
    async function solTicker() {
      try { const j = await getJSON('cb', `${API.cb}/products/SOL-USD/ticker`); if (j && +j.price > 0) { M.solNow = +j.price; J.lastSol = M.solNow; } } catch (e) { /* keep last */ }
      try { await solRange(nowS() - 3 * 3600, nowS()); } catch (e) { /* retried next time */ }
    }
    function solAt(t) {
      const m = minute(t);
      for (let k = 0; k < 240; k++) { const v = M.solPx.get(m - k * 60); if (v) return v; }
      for (let k = 1; k < 240; k++) { const v = M.solPx.get(m + k * 60); if (v) return v; }
      return M.solNow || J.lastSol || 100;
    }
    const solReady = t => M.solPx.has(minute(t)) || nowS() > t + 600;
    const solNow = () => M.solNow || J.lastSol || 100;

    // -------------------------------------------------------------- discovery: new pump.fun coins (Jupiter), followed on DexScreener
    async function discover() {
      const j = await getJSON('jup', `${API.jup}/recent`);
      const t = nowS();
      for (const x of (Array.isArray(j) ? j : [])) {
        if (!x || x.launchpad !== 'pump.fun' || !okAddr(x.id)) continue;
        const c0 = Date.parse((x.firstPool && x.firstPool.createdAt) || x.createdAt) / 1000;
        if (!(c0 > 0) || t - c0 > FOLLOW_S || M.young.has(x.id) || J.coins[x.id]) continue;
        M.young.set(x.id, { m: x.id, sym: String(x.symbol || '').slice(0, 24), name: String(x.name || '').slice(0, 48), icon: safeUrl(x.icon || ''), t: c0, mc: +x.mcap || 0, max: +x.mcap || 0, quote: null, bc: null, pool: null, seen: t });
        M.seen++; J.n.launch++;
      }
    }
    // the coins nearest $7k are checked every round; the rest take turns
    async function follow() {
      const t = nowS();
      for (const [m, c] of M.young) if (t - c.t > FOLLOW_S || (t - c.t > DEAD_S && c.max < DEAD_MC) || (c.quote && c.quote !== 'SOL') || J.coins[m]) M.young.delete(m);
      const all = [...M.young.values()].sort((a, b) => b.mc - a.mc);
      const hot = all.slice(0, 60), rest = all.slice(60);
      const take = rest.length ? rest.slice(M.youngPtr % rest.length).concat(rest.slice(0, M.youngPtr % rest.length)).slice(0, 60) : [];
      M.youngPtr += 60;
      const list = hot.concat(take);
      for (let i = 0; i < list.length; i += 30) {
        const batch = list.slice(i, i + 30);
        let j; try { j = await getJSON('dex', `${API.dex}/tokens/v1/solana/${batch.map(c => c.m).join(',')}`); } catch (e) { continue; }
        if (!Array.isArray(j)) continue;
        for (const p of j) {
          const c = M.young.get(p && p.baseToken && p.baseToken.address);
          if (!c || (p.dexId !== 'pumpfun' && p.dexId !== 'pumpswap')) continue;
          c.quote = p.quoteToken && p.quoteToken.symbol;
          if (p.dexId === 'pumpfun' && okAddr(p.pairAddress)) c.bc = p.pairAddress;
          if (p.dexId === 'pumpswap' && okAddr(p.pairAddress)) c.pool = p.pairAddress;
          const mc = +p.marketCap || +p.fdv || 0;
          if (p.dexId === 'pumpswap' || !c.pool) { c.mc = mc; c.max = Math.max(c.max, mc); }
          if (p.info) c.links = { web: (p.info.websites || []).length, soc: (p.info.socials || []).map(s => String(s.type || '')).slice(0, 4) };
        }
        for (const c of batch) if (c.quote === 'SOL' && c.bc && c.mc >= CROSS_MC && !J.coins[c.m]) onCross(c, nowS());
      }
    }
    function onCross(c, t) {
      M.young.delete(c.m);
      const k = { m: c.m, sym: c.sym, name: c.name, icon: c.icon, t: c.t, x: t, mcX: c.mc, bc: c.bc, pool: c.pool, words: E.words(c.name, c.sym), links: c.links || null,
        status: 'checking', tries: 0, why: {}, ok: {}, audit: null, rc: null };
      J.coins[c.m] = k;
      J.cross.push([t, c.m, k.words]);
      M.crossed++; J.n.cross++;
      M.checkQ.push(c.m); M.rcQ.push(c.m);
      H.dirty();
    }
    // a cold start fills the meme history from Jupiter's 1-hour lists: pump.fun coins under 2 h old already above $7k
    async function bootstrap() {
      if (J.boot && J.cross.length) return;
      const t = nowS(), seen = new Set(J.cross.map(c => c[1]));
      for (const cat of ['toptraded/1h', 'toptrending/1h', 'toporganicscore/1h']) {
        let j; try { j = await getJSON('jup', `${API.jup}/${cat}?limit=100`); } catch (e) { continue; }
        for (const x of (Array.isArray(j) ? j : [])) {
          if (!x || x.launchpad !== 'pump.fun' || seen.has(x.id) || !(x.mcap >= CROSS_MC)) continue;
          const c0 = Date.parse((x.firstPool && x.firstPool.createdAt) || x.createdAt) / 1000;
          if (!(t - c0 < META_S)) continue;
          J.cross.push([Math.min(t - 60, c0 + 60), x.id, E.words(x.name, x.symbol), 'boot']); seen.add(x.id);
        }
      }
      J.boot = true; save();
    }

    // -------------------------------------------------------------- rug checks (Jupiter audit + RugCheck) and the meme score
    async function checkLoop() {
      while (!stopped) {
        if (!H.leader() || !M.checkQ.length) { await sleep(2000); continue; }
        const batch = M.checkQ.splice(0, 40).filter(m => J.coins[m] && J.coins[m].status === 'checking');
        if (!batch.length) continue;
        try {
          const j = await getJSON('jup', `${API.jup}/search?query=${batch.join(',')}`);
          const got = new Set();
          for (const x of (Array.isArray(j) ? j : [])) {
            const k = x && J.coins[x.id]; if (!k) continue; got.add(x.id);
            k.audit = x.audit || {}; k.holders = +x.holderCount || null; k.org = x.organicScore; k.dev = x.dev;
            k.soc = { tw: !!x.twitter, web: !!x.website, tg: !!x.telegram };
            k.s5 = x.stats5m ? { b: x.stats5m.numBuys, s: x.stats5m.numSells, tr: x.stats5m.numTraders } : null;
            decide(k);
          }
          for (const m of batch) if (!got.has(m)) { const k = J.coins[m]; if (!k) continue; if (++k.tries < 4) M.checkQ.push(m); else { k.audit = { missing: true }; decide(k); } }
        } catch (e) { M.checkQ.unshift(...batch); await sleep(5000); }
      }
    }
    async function rcLoop() {
      while (!stopped) {
        const m = H.leader() && M.rcQ.shift();
        if (!m) { await sleep(2000); continue; }
        const k = J.coins[m]; if (!k || k.rc) continue;
        try {
          const j = await getJSON('rc', `${API.rc}/tokens/${m}/report/summary`);
          k.rc = j ? { score: j.score, sn: j.score_normalised, risks: (Array.isArray(j.risks) ? j.risks : []).slice(0, 20).map(r => [String(r.name || ''), String(r.level || ''), String(r.value || '').slice(0, 40)]) } : { missing: true, risks: [] };
          decide(k);
        } catch (e) { k.rcTries = (k.rcTries || 0) + 1; if (k.rcTries < 4) { M.rcQ.push(m); await sleep(3000); } else { k.rc = { missing: true, risks: [] }; decide(k); } }
      }
    }
    function checksOf(k, C) {
      const a = k.audit || {}, dev = a.devBalancePercentage == null ? 0 : +a.devBalancePercentage, top = a.topHoldersPercentage == null ? null : +a.topHoldersPercentage;
      const rc = k.rc || { missing: true, risks: [] }, danger = rc.risks.filter(r => r[1] === 'danger').map(r => r[0]);
      const meme = k.meme || { score: 0, word: null }, soc = k.soc || {};
      const out = [
        { id: 'mint', label: 'Mint authority revoked', ok: a.mintAuthorityDisabled === true, v: a.missing ? 'no data' : a.mintAuthorityDisabled === true ? 'revoked' : 'still on', no: a.missing ? 'no audit data' : 'mint authority on', tip: 'If the creator can still mint, they can print new coins and dump them on buyers.' },
        { id: 'freeze', label: 'Freeze authority revoked', ok: a.freezeAuthorityDisabled === true, v: a.missing ? 'no data' : a.freezeAuthorityDisabled === true ? 'revoked' : 'still on', no: a.missing ? 'no audit data' : 'freeze authority on', tip: 'If the creator can still freeze wallets, they can stop you from selling.' },
        { id: 'dev', label: `Dev wallet holds ${C.devMax}% or less`, ok: dev <= C.devMax, v: dev.toFixed(1) + '%', no: `dev holds ${dev.toFixed(0)}%`, tip: 'A big dev bag can be dumped on buyers at any moment.' },
        { id: 'top', label: `Top holders own ${C.topMax}% or less`, ok: top == null || top <= C.topMax, v: top == null ? 'not reported' : top.toFixed(1) + '%', no: `top holders own ${top == null ? '?' : top.toFixed(0)}%`, tip: 'A few wallets holding a lot of the supply can crash the price together.' },
        { id: 'rc', label: 'No RugCheck danger flag' + (C.rcMax ? `, risk score ${C.rcMax} or less` : ''), ok: !rc.missing && !danger.length && (!C.rcMax || (rc.sn != null && rc.sn <= C.rcMax)), v: rc.missing ? 'no report' : danger.length ? danger.join(', ') : `clean (score ${rc.sn != null ? rc.sn : rc.score})`, no: rc.missing ? 'no RugCheck report' : danger.length ? 'RugCheck: ' + danger[0].toLowerCase() : `RugCheck score ${rc.sn}`, tip: 'RugCheck flags known scam patterns, like creators who rugged before.' },
        { id: 'meme', label: 'On a current meme', ok: meme.score >= C.needMeme, v: meme.score ? `"${meme.word}": ${meme.score} other coin${meme.score > 1 ? 's' : ''} in 2 h` : 'no match in 2 h', no: 'not on a current meme', tip: 'Another coin with one of its name words crossed $7K in the last 2 hours.' },
      ];
      if (C.minHolders) out.push({ id: 'hold', label: `${C.minHolders}+ holders`, ok: (k.holders || 0) >= C.minHolders, v: k.holders ? String(k.holders) : 'not reported', no: `${k.holders || 'no'} holders` });
      if (C.social) out.push({ id: 'soc', label: 'Has a social link', ok: !!(soc.tw || soc.web || soc.tg), v: [soc.tw && 'X', soc.web && 'web', soc.tg && 'Telegram'].filter(Boolean).join(', ') || 'none', no: 'no social link' });
      if (C.devMints) out.push({ id: 'devm', label: `Dev made ${C.devMints} or fewer coins before`, ok: a.devMints != null && a.devMints <= C.devMints, v: a.devMints != null ? String(a.devMints) : 'not reported', no: a.devMints != null ? `dev made ${a.devMints} coins before` : 'dev history unknown' });
      return out;
    }
    // how good a coin looks at its crossing: on a bigger current meme first, then holders, socials and organic activity
    function scoreOf(k) {
      const soc = k.soc || {};
      return (k.meme ? k.meme.score : 0) * 10 + Math.min(10, (k.holders || 0) / 20) + ((soc.tw || soc.web || soc.tg) ? 3 : 0) + Math.min(5, (+k.org || 0) / 10);
    }
    function decide(k) {
      if (!k.audit || !k.rc || k.status !== 'checking') return;
      k.meme = E.memeScore(k.words, J.cross, k.x, k.m);
      k.score = +scoreOf(k).toFixed(2);
      let any = false, full = 0;
      const swapped = [];
      for (const b of BOTS) {
        const bad = checksOf(k, b.C).filter(c => !c.ok);
        k.ok[b.id] = !bad.length; k.why[b.id] = bad.map(c => c.no || c.label);
        if (bad.length) continue;
        const B = J.bots[b.id], live = B.watch.filter(w => !w.done && !w.drop && w.to > k.x);
        if (live.length >= SLOTS) {
          // full: replace the weakest watched coin that is not close to its buy zone, if this one scores higher
          const far = w => !nearBuy(w, b);
          const weak = live.filter(far).sort((a, c) => ((J.coins[a.m] || {}).score || 0) - ((J.coins[c.m] || {}).score || 0))[0];
          if (!weak || ((J.coins[weak.m] || {}).score || 0) >= k.score) { k.why[b.id] = ['watchlist full']; k.ok[b.id] = false; full++; continue; }
          // its window ends now; it is still checked for a dip that already happened before this moment
          weak.to = Math.max(weak.from, k.x); weak.drop = true; swapped.push((J.coins[weak.m] || {}).sym);
        }
        B.watch.push({ m: k.m, from: k.x, to: k.x + WATCH_S, done: null }); any = true;
      }
      k.status = any ? 'pass' : 'fail';
      if (any) {
        J.n.pass++;
        want(k.m, 2);
        const n = BOTS.filter(b => k.ok[b.id]).length;
        const sw = [...new Set(swapped.filter(Boolean))];
        ev('', 'watch', `${k.sym} passed every check${k.meme.word ? ` (meme "${k.meme.word}")` : ''}. ${n === BOTS.length ? 'All bots' : n + ' bot' + (n > 1 ? 's' : '')} now watch it for a dip for 2 hours${sw.length ? `, in place of ${sw.join(', ')}` : ''}.`, k.m);
      } else if (full) ev('', 'skip', `${k.sym} passed the checks but every watch slot holds a stronger coin.`, k.m);
      if (H.onDecide) { try { H.onDecide(k); } catch (e) { note('onDecide: ' + (e.message || e)); } }
      H.dirty(); save(any);
    }

    // -------------------------------------------------------------- candles: GeckoTerminal 1-minute OHLCV, curve pool + PumpSwap pool
    // GeckoTerminal snapshots candles once a minute, so a coin fetched in the last 40 s is not asked again
    function want(m, pri) { if (!m) return; const c = M.cs.get(m); if (c && nowS() - c.f < 40) return; const p = M.gtQ.get(m); if (p == null || pri < p) M.gtQ.set(m, pri); }
    function viewerWants() { return !H.leader() && M.view.m && M.gtQ.has(M.view.m); }
    async function gtLoop() {
      while (!stopped) {
        if (!H.leader() && !viewerWants()) { await sleep(1000); continue; }
        if (!M.gtQ.size) { if (H.leader() && H.gtIdle && await H.gtIdle()) continue; await sleep(400); continue; }
        let best = null; for (const [m, p] of M.gtQ) if (!best || p < best[1]) best = [m, p];
        M.gtQ.delete(best[0]);
        try { await fetchCandles(best[0]); } catch (e) { note('candles: ' + (e.message || e)); }
        if (H.leader()) { stepAll(); save(); }
        H.dirty();
      }
    }
    async function ohlcv(pool, before) {
      const j = await getJSON('gt', `${API.gt}/networks/solana/pools/${pool}/ohlcv/minute?aggregate=1&limit=1000&currency=usd&include_empty_intervals=true${before ? '&before_timestamp=' + before : ''}`);
      return j && j.data && j.data.attributes && Array.isArray(j.data.attributes.ohlcv_list) ? j.data.attributes.ohlcv_list : null;
    }
    // earliest candle the bots need for a coin: its launch (the high since launch), or an old entry
    function needFrom(m) {
      const k = J.coins[m]; let t = k ? k.t : nowS() - 3600;
      for (const B of Object.values(J.bots)) if (B.pos && B.pos.m === m) t = Math.min(t, B.pos.entryT - 120);
      return t;
    }
    async function fetchCandles(m) {
      const k = J.coins[m]; if (!k || !okAddr(k.bc)) return;
      const f = nowS();
      let a = await ohlcv(k.bc);
      if (a && a.length >= 1000) {   // page back to the launch (or the entry) if one call didn't reach it
        for (let i = 0; i < 6; i++) {
          const oldest = Math.min(...a.map(x => +x[0]));
          if (oldest <= needFrom(m)) break;
          const more = await ohlcv(k.bc, oldest);
          if (!more || !more.length) break;
          a = a.concat(more);
        }
      }
      if (!k.pool) { const p = M.px.get(m); if (p && okAddr(p.pumpswap)) k.pool = p.pumpswap; }
      let b = [];
      if (k.pool) b = (await ohlcv(k.pool)) || [];
      const prev = M.cs.get(m);
      if (!a) { const miss = (prev ? prev.miss || 0 : 0) + 1; M.cs.set(m, Object.assign({}, prev || { cs: [], fin: 0 }, { f, miss })); return; }
      const cs = E.stitch(a, b).filter(c => c.every(v => isFinite(v)));
      const last = cs.length ? cs[cs.length - 1] : null;
      // candles before `fin` are final. The newest candle can still be forming; a coin with no trades for 3+ minutes
      // (and not at the end of the curve with its PumpSwap pool unknown) is final up to 3 minutes ago.
      const nearGrad = last && !last[6] && !k.pool && last[4] / solAt(last[0]) * E.SUPPLY >= 0.97 * E.GRAD_MC_SOL;
      const fin = last ? (nearGrad ? last[0] : Math.max(last[0], minute(f - 180))) : minute(f - 180);
      M.cs.set(m, { f, fin, cs, miss: 0 });
      if (cs.length) { try { await solRange(cs[0][0], f); } catch (e) { /* SOL candles retried later */ } }
      keepTradeCandles(m);
      H.dirty();
    }
    // candles of traded coins are kept (compact, market cap in USD) so their charts still show later
    function keepTradeCandles(m) {
      const ts = []; for (const B of Object.values(J.bots)) { for (const x of B.trades) if (x.m === m) ts.push(x); if (B.pos && B.pos.m === m) ts.push(B.pos); }
      if (!ts.length) return;
      const c = M.cs.get(m); if (!c || !c.cs.length) return;
      const from = Math.min(...ts.map(x => x.entryT)) - 3600, to = Math.max(...ts.map(x => (x.exitT || nowS()))) + 3600;
      const rows = c.cs.filter(x => x[0] >= from && x[0] <= to).slice(-480);
      if (!rows.length) return;
      const r = v => +(v * E.SUPPLY).toPrecision(6);
      J.tc[m] = { u: nowS(), r: rows.map(x => [x[0], r(x[1]), r(x[2]), r(x[3]), r(x[4]), Math.round(x[5] || 0), x[6] ? 1 : 0]) };
    }
    function candlesFor(m) {
      const c = M.cs.get(m);
      if (c && c.cs.length) return c.cs;
      const s = J.tc[m] || M.tc.get(m);
      return s ? s.r.map(x => [x[0], x[1] / E.SUPPLY, x[2] / E.SUPPLY, x[3] / E.SUPPLY, x[4] / E.SUPPLY, x[5], x[6]]) : [];
    }

    // -------------------------------------------------------------- live prices (DexScreener): watched, held and shown coins
    async function pricePoll() {
      const ms = new Set();
      for (const B of Object.values(J.bots)) { if (B.pos) ms.add(B.pos.m); for (const w of B.watch) if (!w.done) ms.add(w.m); if (B.pending) ms.add(B.pending.m); }
      if (M.view.m) ms.add(M.view.m);
      const list = [...ms].filter(okAddr);
      for (let i = 0; i < list.length; i += 30) {
        let j; try { j = await getJSON('dex', `${API.dex}/tokens/v1/solana/${list.slice(i, i + 30).join(',')}`); } catch (e) { continue; }
        for (const p of (Array.isArray(j) ? j : [])) {
          const m = p && p.baseToken && p.baseToken.address; if (!m || (p.dexId !== 'pumpfun' && p.dexId !== 'pumpswap')) continue;
          const r = M.px.get(m) || {};
          if (p.dexId === 'pumpswap' && okAddr(p.pairAddress)) r.pumpswap = p.pairAddress; else if (okAddr(p.pairAddress)) r.pumpfun = p.pairAddress;
          if (p.dexId === 'pumpswap' || !r.pumpswap) {
            r.price = +p.priceUsd; r.mc = +p.marketCap || +p.fdv; r.liq = p.liquidity && +p.liquidity.usd; r.t = nowS(); r.pair = p.pairAddress;
            if (r.price > 0) { r.obs = (r.obs || []).filter(o => r.t - o[0] < 1200); r.obs.push([r.t, r.price]); }
            r.m5 = p.txns && p.txns.m5 ? { b: +p.txns.m5.buys || 0, s: +p.txns.m5.sells || 0, v: p.volume ? +p.volume.m5 || 0 : 0 } : null;
            r.h1 = p.priceChange ? +p.priceChange.h1 : NaN;
          }
          M.px.set(m, r);
          const k = J.coins[m]; if (k && r.pumpswap && !k.pool) { k.pool = r.pumpswap; want(m, 1); }
        }
      }
      H.liveBar();
      H.dirty();
    }

    // -------------------------------------------------------------- the bots: watch -> buy the first dip -> hold to target, stop or time
    // live prices seen after the last final candle of a coin: [low, high] (null when there are none)
    function liveSince(m, t0) {
      const r = M.px.get(m); if (!r || !r.obs) return null;
      let lo = Infinity, hi = 0;
      for (const [t, p] of r.obs) if (t >= t0) { lo = Math.min(lo, p); hi = Math.max(hi, p); }
      return hi > 0 ? [lo, hi] : null;
    }
    // candles are only fetched again for a watched coin while its live price is within 25% of its buy zone; far coins
    // can't have dipped (modulo a wick between two 8-second price checks), which keeps GeckoTerminal under its free limit
    function nearBuy(w, b) {
      const c = M.cs.get(w.m); if (!c || !c.cs.length) return true;
      const r = M.px.get(w.m); if (!r || !(r.price > 0) || nowS() - r.t > 60) return true;
      const L = liveSince(w.m, c.fin); if (!L) return true;
      const Hh = Math.max(w.H || 0, L[1]), trig = (1 - b.P.dip) * Hh;
      if (!(trig > 0)) return true;
      // a coin already under its buy zone first has to trade back above it: only then can a new dip come
      if (w.wait) return L[1] >= trig * 0.95;
      return L[0] <= trig * 1.25;
    }
    function nearExit(b, B) {
      const p = B.pos; if (!p) return false;
      const c = M.cs.get(p.m), r = M.px.get(p.m); if (!c || !r || !(r.price > 0) || nowS() - r.t > 60) return true;
      const L = liveSince(p.m, c.fin); if (!L) return true;
      const s = solNow(), curve = !graduated(p.m), tp = (curve ? p.tpCurve : p.tpPool) * s, sl = p.slSol * s;
      return L[1] >= tp * 0.92 || L[0] <= sl * 1.5 || (b.P.maxHold && nowS() >= p.entryT + b.P.maxHold * 60 - 150);
    }
    function stepAll() { if (!H.stillLeader()) return; for (const b of BOTS) { try { stepBot(b); } catch (e) { note(b.id + ': ' + (e.message || e)); } } }
    function finalOf(c) { return c.cs.filter(x => x[0] < c.fin); }
    function stepBot(b) {
      const B = J.bots[b.id], t = nowS();
      if (B.pos) {
        const c = M.cs.get(B.pos.m); if (!c) { want(B.pos.m, 0); return; }
        const h = E.hold(finalOf(c), solAt, B.pos, Infinity, b.P, true);
        if (h.state === 'done' && solReady(h.trade.exitT)) {
          const k = J.coins[B.pos.m] || {}, tr = Object.assign({}, h.trade, { m: B.pos.m, sym: k.sym || B.pos.sym, name: k.name || '', from: B.pos.from });
          B.trades.push(tr); B.pos = null; B.free = tr.exitT + 60; B.pending = null;
          const how = tr.out === 'tp' ? 'at the profit target' : tr.out === 'sl' ? 'at the stop' : 'at the time limit';
          ev(b.id, tr.net >= 0 ? 'win' : 'loss', `${b.name}: sold ${tr.sym} ${how}, ${sSol(tr.net)} (${sPct(tr.ret)}).`, tr.m);
          H.toast(b, tr.net >= 0 ? 'win' : 'loss', `${b.name} sold ${tr.sym}`, `${sSol(tr.net)} (${sPct(tr.ret)}) ${how}`, tr.m);
          keepTradeCandles(tr.m);
          save(true);
        } else if (h.state === 'done') want(B.pos.m, 1);
        return;
      }
      const active = B.watch.filter(w => !w.done);
      let best = null;
      for (const w of active) {
        if (w.to <= B.free) { w.done = 'missed'; continue; }
        const c = M.cs.get(w.m);
        if (!c) { want(w.m, 2); continue; }
        if (!c.cs.length) { if (c.miss >= 4 || t > w.to + 1800) w.done = 'nodata'; continue; }
        const tw = Math.max(w.from, B.free), tEnd = Math.min(w.to, c.fin);
        const cash = cashOf(B), stake = Math.min(b.P.stake, cash);
        if (stake < 0.05) continue;
        const r = E.findEntry(c.cs, solAt, tw, tEnd, Object.assign({}, b.P, { stake }));
        w.trig = r.trig; w.H = r.H; w.wait = r.ready === false;
        if (r.pos) { if (!best || r.pos.entryT < best.r.pos.entryT) best = { w, r, tw, stake }; }
        else if (c.fin >= w.to || (t > w.to + 30 && !nearBuy(w, b))) { w.done = w.drop ? 'dropped' : 'nodip'; }
      }
      B.pending = null;
      if (!best) return;
      const e = best.r.pos.entryT;
      // the first coin to dip wins: every other watched coin must have final candles past this minute first
      const stale = active.filter(w => { if (w.done || w === best.w || w.from > e + 59) return false; const c = M.cs.get(w.m); return !c || (c.cs.length > 0 && c.fin <= e && nearBuy(w, b)); });
      if (stale.length || !solReady(e)) { B.pending = { m: best.w.m, entryT: e, mc: best.r.pos.entryMc }; for (const w of stale) want(w.m, 0); return; }
      const k = J.coins[best.w.m] || {};
      best.w.done = 'bought';
      B.pos = Object.assign({ m: best.w.m, sym: k.sym, from: best.w.from }, best.r.pos);
      const dipTxt = b.P.entry === 'green' ? 'on the first green candle after the dip' : `${sPct(best.r.pos.entryUsd / best.r.pos.H - 1, 0)} from its high`;
      ev(b.id, 'buy', `${b.name}: bought ${sol(best.stake, 2)} of ${k.sym} at ${fmtMc(best.r.pos.entryMc)} market cap, ${dipTxt}.`, best.w.m);
      H.toast(b, 'buy', `${b.name} bought ${k.sym}`, `${sol(best.stake, 2)} at ${fmtMc(best.r.pos.entryMc)} market cap`, best.w.m);
      want(best.w.m, 0);
      keepTradeCandles(best.w.m);
      save(true);
    }
    function cashOf(B) { return START_SOL + sum(B.trades.map(x => x.net)) - (B.pos ? B.pos.cost : 0); }
    function graduated(m) { const r = M.px.get(m), k = J.coins[m]; return !!((r && r.pumpswap) || (k && k.pool)); }
    // value of an open position if sold now: live price when fresh, else the last candle
    function markOf(b) {
      const B = J.bots[b.id], p = B.pos; if (!p) return null;
      const r = M.px.get(p.m), c = candlesFor(p.m), last = c.length ? c[c.length - 1] : null;
      const pUsd = r && r.price > 0 && nowS() - r.t < 120 ? r.price : last ? last[4] : p.entryUsd;
      const curve = !graduated(p.m), pSol = pUsd / solNow();
      const v = E.sell(p.qty, pSol, curve, b.P.exec).sol;
      return { value: v, net: v - p.cost, ret: v / p.cost - 1, pUsd, mc: pUsd * E.SUPPLY, curve };
    }
    function acct(b) {
      const B = J.bots[b.id], mk = markOf(b);
      const realized = sum(B.trades.map(x => x.net)), open = mk ? mk.net : 0;
      const bal = START_SOL + realized + open, wins = B.trades.filter(x => x.net > 0);
      let eq = START_SOL, peak = START_SOL, mdd = 0;
      for (const x of B.trades) { eq += x.net; peak = Math.max(peak, eq); mdd = Math.min(mdd, eq / peak - 1); }
      if (mk) mdd = Math.min(mdd, (eq + mk.net) / peak - 1);
      const losses = B.trades.filter(x => x.net <= 0);
      return { bal, realized, open, mk, wins: wins.length, n: B.trades.length, mdd, cash: cashOf(B),
        avgW: wins.length ? sum(wins.map(x => x.ret)) / wins.length : NaN, avgL: losses.length ? sum(losses.map(x => x.ret)) / losses.length : NaN,
        worst: B.trades.length ? Math.min(...B.trades.map(x => x.ret)) : NaN };
    }

    // -------------------------------------------------------------- schedule
    async function loopEvery(fn, ms, name, viewerToo) {
      while (!stopped) {
        const t0 = nowMs();
        if (H.leader() || viewerToo) { try { await fn(); } catch (e) { note(name + ': ' + (e.message || e)); } }
        if (stopped) break;
        await sleep(Math.max(500, ms - (nowMs() - t0)));
      }
    }
    // which coins need candles, and how soon (GeckoTerminal snapshots a minute at a time, so never faster than that)
    function schedule() {
      const t = nowS(), due = (m, every, pri) => { const c = M.cs.get(m); if (!c || t - c.f >= every) want(m, pri); };
      for (const b of BOTS) {
        const B = J.bots[b.id];
        if (B.pos) { due(B.pos.m, nearExit(b, B) ? 55 : 240, 0); continue; } // a busy bot can't buy: its watchlist waits
        if (B.pending) due(B.pending.m, 55, 0);
        for (const w of B.watch) if (!w.done) {
          if (!M.cs.get(w.m)) want(w.m, 2);
          else if (nearBuy(w, b)) due(w.m, 55, 1);
        }
      }
      if (M.view.m && J.coins[M.view.m] && H.visible()) due(M.view.m, 90, 2);
      J.last = t;
    }
    // taking over the journal (page load, another tab gone, a new server run): note the gap and catch up
    function resume() {
      const awayS = nowS() - (J.last || nowS());
      if (J.ev.length && awayS > 300) ev('', 'gap', H.gapText(age(awayS)));
      for (const B of Object.values(J.bots)) { if (B.pos) want(B.pos.m, 0); for (const w of B.watch) if (!w.done) want(w.m, 2); }
      for (const k of Object.values(J.coins)) if (k.status === 'checking') {
        if (!k.audit && !M.checkQ.includes(k.m)) M.checkQ.push(k.m);
        if (!k.rc && !M.rcQ.includes(k.m)) M.rcQ.push(k.m);
      }
    }
    // the coins still being followed, compact (a server run hands them to the next one)
    function youngOut() { return [...M.young.values()].map(c => [c.m, c.sym, c.name, c.icon, c.t, c.mc, c.max, c.quote, c.bc, c.pool, c.seen, c.links || null]); }
    function youngIn(a) {
      for (const x of (Array.isArray(a) ? a : [])) if (Array.isArray(x) && okAddr(x[0]) && !M.young.has(x[0]) && !J.coins[x[0]]) {
        const c = { m: x[0], sym: x[1], name: x[2], icon: x[3], t: x[4], mc: x[5], max: x[6], quote: x[7], bc: x[8], pool: x[9], seen: x[10] };
        if (x[11]) c.links = x[11];
        M.young.set(x[0], c);
      }
    }

    return {
      M, LANES, API, okAddr,
      J: () => J, setJ, fresh, fixup, prune, pruneHard, refs, getJSON, ev, note, save,
      solRange, solTicker, solAt, solReady, solNow,
      discover, follow, onCross, bootstrap,
      checkLoop, rcLoop, checksOf, scoreOf, decide,
      want, viewerWants, gtLoop, ohlcv, needFrom, fetchCandles, keepTradeCandles, candlesFor,
      pricePoll, liveSince, nearBuy, nearExit, stepAll, stepBot, finalOf, cashOf, graduated, markOf, acct,
      loopEvery, schedule, resume, youngOut, youngIn,
      stop() { stopped = true; }, isStopped: () => stopped,
    };
  }
  return { create, API, okAddr, safeUrl, fmt: { fmtMc, sol, sSol, sPct, age }, minute };
})();
if (typeof module !== 'undefined') module.exports = SNIPER_CORE;
