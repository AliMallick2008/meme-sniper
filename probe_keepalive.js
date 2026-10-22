'use strict';
/* Probe 6 (read-only): two tape lanes side by side on the same runner and the same coins, one sending a tiny request
   every 5 s, one silent: do the public RPC's websocket drops depend on client traffic? Paper only. */
const T = require('./v11/tape.js');
const RUN_S = +(process.env.RUN_S || 180);
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const out = { at: new Date().toISOString() };
  const counts = new Map();
  const ws = new WebSocket('wss://api.mainnet-beta.solana.com');
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = ev => { const j = JSON.parse(ev.data); const v = j.params && j.params.result && j.params.result.value; if (!v || v.err) return;
    for (const l of v.logs || []) if (l.startsWith('Program data: ')) { const b = Buffer.from(l.slice(14), 'base64'); const t = T.decodeTrade(b, null); if (t) { const m = T.b58(b.subarray(8, 40)); counts.set(m, (counts.get(m) || 0) + 1); } } };
  ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'logsSubscribe', params: [{ mentions: [T.PUMP] }, { commitment: 'processed' }] }));
  await sleep(6000); ws.close();
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(x => x[0]).slice(0, 60);
  const coins = [];
  for (let i = 0; i < top.length && coins.length < 20; i += 30) {
    const r = await fetch('https://api.dexscreener.com/tokens/v1/solana/' + top.slice(i, i + 30).join(','));
    const pairs = await r.json();
    for (const m of top.slice(i, i + 30)) { const p = (pairs || []).find(p => p && p.baseToken && p.baseToken.address === m && p.dexId === 'pumpfun' && p.quoteToken && p.quoteToken.symbol === 'SOL'); if (p && coins.length < 20) coins.push({ m, bc: p.pairAddress }); }
  }
  out.coins = coins.length;
  const t0 = Date.now(), lanes = {};
  for (const [name, ka] of [['silent', 0], ['keepalive5s', 5000]]) {
    const L = lanes[name] = { trades: 0, drops: [], ups: 0 };
    L.tape = T.createTape({ now: () => Date.now(), keepaliveMs: ka, fetch: async () => ({ status: 503, json: async () => null }), ingest: ev => {
      if (ev.type === 'tape') L.trades++;
      if (ev.type === 'tape_status') { if (ev.up) L.ups++; else L.drops.push([Math.round((Date.now() - t0) / 100) / 10, ev.why]); } } });
  }
  let lastWant = 0;
  while (Date.now() - t0 < RUN_S * 1000) {
    const t = Date.now();
    for (const L of Object.values(lanes)) { if (t - lastWant >= 3000) L.tape.want(coins); L.tape.maintain(); }
    if (t - lastWant >= 3000) lastWant = t;
    await sleep(500);
  }
  for (const [k, L] of Object.entries(lanes)) { L.tape.stop(); out[k] = { trades: L.trades, drops: L.drops.length, ups: L.ups, dropTimes: L.drops.map(x => x[0]), reconnects: L.tape.stats.reconnects }; }
  out.seconds = RUN_S;
  console.log(JSON.stringify(out, null, 1));
  process.exit(0);
})();
