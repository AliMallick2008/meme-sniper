'use strict';
/* Probe 4 (read-only): raw samples for test fixtures. A few seconds of pump.fun program logs; keeps the raw base64 of
   TradeEvents (SOL coins and zero-SOL coins), one CompleteEvent if any, one whole logsNotification for a SOL coin's
   curve subscription, and the raw getMultipleAccounts answer for two curves. Paper only. */
const RPC = process.env.RPC || 'https://api.mainnet-beta.solana.com';
const WS = RPC.replace(/^http/, 'ws');
const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const crypto = require('crypto');
const D = n => crypto.createHash('sha256').update('event:' + n).digest().subarray(0, 8).toString('hex');
const TRADE = D('TradeEvent'), COMPLETE = D('CompleteEvent');
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58(buf) { let n = 0n; for (const x of buf) n = (n << 8n) + BigInt(x); let s = ''; while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; } for (const x of buf) { if (x === 0) s = '1' + s; else break; } return s; }
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const out = { at: new Date().toISOString(), sol: [], zero: [], complete: [], notification: null, accounts: null };
  const mintsSol = new Map();
  let ws = new WebSocket(WS);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = ev => {
    const j = JSON.parse(ev.data); const v = j.params && j.params.result && j.params.result.value; if (!v || v.err) return;
    for (const l of v.logs || []) {
      if (!l.startsWith('Program data: ')) continue;
      const b = Buffer.from(l.slice(14), 'base64'), d = b.subarray(0, 8).toString('hex');
      if (d === COMPLETE && out.complete.length < 2) out.complete.push({ b64: l.slice(14), sig: v.signature });
      if (d !== TRADE || b.length < 225) continue;
      const vSol = Number(b.readBigUInt64LE(97)), mint = b58(b.subarray(8, 40));
      if (vSol > 0) { if (out.sol.length < 6 && !out.sol.some(x => x.mint === mint)) out.sol.push({ mint, b64: l.slice(14), sig: v.signature, slot: j.params.result.context.slot }); mintsSol.set(mint, (mintsSol.get(mint) || 0) + 1); }
      else if (out.zero.length < 2) out.zero.push({ mint, b64: l.slice(14) });
    }
  };
  ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'logsSubscribe', params: [{ mentions: [PUMP] }, { commitment: 'processed' }] }));
  await sleep(10000);
  ws.close();
  // the busiest SOL coin: its curve, a whole notification from a per-curve subscription, and the account data
  const top = [...mintsSol.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(x => x[0]);
  const r = await fetch('https://api.dexscreener.com/tokens/v1/solana/' + top.join(','));
  const pairs = await r.json();
  const curves = top.map(m => { const p = pairs.find(p => p.baseToken && p.baseToken.address === m && p.dexId === 'pumpfun'); return p ? { m, bc: p.pairAddress } : null; }).filter(Boolean);
  out.curves = curves;
  if (curves.length) {
    ws = new WebSocket(WS);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    ws.onmessage = ev => { const j = JSON.parse(ev.data); if (j.method === 'logsNotification' && !out.notification && !j.params.result.value.err) out.notification = { bc: curves[0].bc, m: curves[0].m, msg: j }; if (j.id === 7) out.subReply = j; };
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'logsSubscribe', params: [{ mentions: [curves[0].bc] }, { commitment: 'processed' }] }));
    for (let i = 0; i < 30 && !out.notification; i++) await sleep(1000);
    ws.close();
    const a = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getMultipleAccounts', params: [curves.slice(0, 2).map(c => c.bc), { encoding: 'base64', commitment: 'processed' }] }) });
    out.accounts = await a.json();
  }
  console.log(JSON.stringify(out, null, 1));
  process.exit(0);
})();
