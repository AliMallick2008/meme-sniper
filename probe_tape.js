'use strict';
/* Probe 5 (read-only): the real tape module (server/v11/tape.js) against the public RPC for RUN_S seconds on the
   busiest curves of the moment, with the real recorder to measure the recording volume. Paper only. */
const T = require('./v11/tape.js'), REC = require('./v11/record.js');
const RUN_S = +(process.env.RUN_S || 180), N = +(process.env.NCOIN || 30);
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const out = { at: new Date().toISOString() };
  // the busiest SOL curves right now: 6 s of program logs, then DexScreener for their curve addresses
  const counts = new Map();
  const ws = new WebSocket('wss://api.mainnet-beta.solana.com');
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = ev => { const j = JSON.parse(ev.data); const v = j.params && j.params.result && j.params.result.value; if (!v || v.err) return;
    for (const l of v.logs || []) if (l.startsWith('Program data: ')) { const b = Buffer.from(l.slice(14), 'base64'); const t = T.decodeTrade(b, null); if (t) { const m = T.b58(b.subarray(8, 40)); counts.set(m, (counts.get(m) || 0) + 1); } } };
  ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'logsSubscribe', params: [{ mentions: [T.PUMP] }, { commitment: 'processed' }] }));
  await sleep(6000); ws.close();
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(x => x[0]).slice(0, 90);
  const coins = [];
  for (let i = 0; i < top.length && coins.length < N; i += 30) {
    const r = await fetch('https://api.dexscreener.com/tokens/v1/solana/' + top.slice(i, i + 30).join(','));
    const pairs = await r.json();
    for (const m of top.slice(i, i + 30)) { const p = (pairs || []).find(p => p && p.baseToken && p.baseToken.address === m && p.dexId === 'pumpfun' && p.quoteToken && p.quoteToken.symbol === 'SOL'); if (p && coins.length < N) coins.push({ m, bc: p.pairAddress, mc: p.marketCap }); }
  }
  out.coins = coins.length;
  // the lane, as the runtime runs it
  const rec = REC.recorder(), got = { tape: 0, curve: 0, tape_status: 0 }, samples = [], perCoin = {};
  const t0 = Date.now();
  const tape = T.createTape({ now: () => Date.now(), log: s => (out.log = out.log || []).push(s), ingest: ev => { got[ev.type] = (got[ev.type] || 0) + 1; if (ev.type === 'tape_status') (out.statusLog = out.statusLog || []).push([Math.round((Date.now() - t0) / 100) / 10, ev.up, ev.why]); rec.event(ev); if (samples.length < 4 && ev.type !== 'tape_status') samples.push(ev); if (ev.m) perCoin[ev.m] = (perCoin[ev.m] || 0) + 1; } });
  let lastWant = 0, lastPoll = 0;
  while (Date.now() - t0 < RUN_S * 1000) {
    const t = Date.now();
    if (t - lastWant >= 3000) { lastWant = t; tape.want(coins); }
    if (t - lastPoll >= 1000) { lastPoll = t; tape.maintain(); await tape.poll(); }
    await sleep(200);
  }
  tape.stop();
  const lines = rec.take(), raw = lines.join('\n') + '\n', gz = require('zlib').gzipSync(Buffer.from(raw), { level: 9 });
  out.seconds = RUN_S; out.got = got; out.stats = tape.stats; out.samples = samples;
  out.recording = { lines: lines.length, rawBytes: raw.length, gzBytes: gz.length, gzPerHourMB: +(gz.length / RUN_S * 3600 / 1e6).toFixed(2) };
  out.perCoinTop = Object.values(perCoin).sort((a, b) => b - a).slice(0, 10);
  { let up = 0, lastT = 0, st = false; for (const [ts, u] of out.statusLog || []) { if (st) up += ts - lastT; lastT = ts; st = u; } if (st) up += RUN_S - lastT; out.uptime = +(up / RUN_S).toFixed(3); }
  // the recorded inputs decode back to the same events
  const dec = [...REC.decode([lines])].filter(x => x.k === 'event').map(x => x.ev);
  out.decodeOk = dec.length === Object.values(got).reduce((a, b) => a + b, 0);
  console.log(JSON.stringify(out, null, 1));
  process.exit(0);
})();
