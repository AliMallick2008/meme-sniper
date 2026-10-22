'use strict';
/* Probe 3 (read-only): what curves do pump.fun coins use now? 20 s of program logs; for each mint, the reserves from its
   TradeEvents: initial virtual SOL (vSol - rSol), virtual-only tokens (vTok - rTok), the quote side, and where the quote
   mint sits in the event bytes. Paper only. */
const crypto = require('crypto');
const RPC = process.env.RPC || 'https://api.mainnet-beta.solana.com';
const WS = RPC.replace(/^http/, 'ws');
const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const RUN_S = +(process.env.RUN_S || 20);
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58(buf) { let n = BigInt('0x' + (buf.toString('hex') || '0')), s = ''; while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; } for (const b of buf) { if (b === 0) s = '1' + s; else break; } return s; }
function unb58(s) { let n = 0n; for (const ch of s) n = n * 58n + BigInt(B58.indexOf(ch)); let h = n.toString(16).padStart(64, '0'); return Buffer.from(h, 'hex'); }
const WSOL = unb58('So11111111111111111111111111111111111111112'), USDC = unb58('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const TRADE = crypto.createHash('sha256').update('event:TradeEvent').digest().subarray(0, 8).toString('hex');
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const out = { at: new Date().toISOString(), wsolHex: WSOL.toString('hex'), mints: {}, lens: {}, quoteAt: {}, zeroSol: 0, trades: 0 };
  const ws = new WebSocket(WS);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = ev => {
    const j = JSON.parse(ev.data); const v = j.params && j.params.result && j.params.result.value; if (!v || v.err) return;
    for (const l of v.logs || []) {
      if (!l.startsWith('Program data: ')) continue;
      const b = Buffer.from(l.slice(14), 'base64'); if (b.length < 225 || b.subarray(0, 8).toString('hex') !== TRADE) continue;
      out.trades++; out.lens[b.length] = (out.lens[b.length] || 0) + 1;
      const mint = b58(b.subarray(8, 40)), sol = Number(b.readBigUInt64LE(40)), vSol = Number(b.readBigUInt64LE(97)), vTok = Number(b.readBigUInt64LE(105)), rSol = Number(b.readBigUInt64LE(113)), rTok = Number(b.readBigUInt64LE(121));
      if (sol === 0) out.zeroSol++;
      // where (if anywhere) the wrapped-SOL or USDC mint appears in the event
      const iw = b.indexOf(WSOL), iu = b.indexOf(USDC);
      const qk = iw >= 0 ? 'wsol@' + iw : iu >= 0 ? 'usdc@' + iu : 'none';
      out.quoteAt[qk] = (out.quoteAt[qk] || 0) + 1;
      const m = out.mints[mint] || (out.mints[mint] = { n: 0, vSol0: Math.round((vSol - rSol) / 1e7) / 100, vTokVirt: Math.round((vTok - rTok) / 1e12) / 1e3, len: b.length, q: qk, zeroSol: 0, mcSol: null, tail: b.subarray(225).toString('hex').slice(0, 120) });
      m.n++; if (sol === 0) m.zeroSol++;
      m.mcSol = vTok > 0 ? Math.round((vSol / 1e9) / (vTok / 1e6) * 1e9 * 10) / 10 : null;
    }
  };
  ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'logsSubscribe', params: [{ mentions: [PUMP] }, { commitment: 'processed' }] }));
  await sleep(RUN_S * 1000);
  ws.close();
  const ms = Object.values(out.mints);
  const hist = {}; for (const m of ms) { const k = m.zeroSol === m.n ? 'zeroSol' : String(Math.round(m.vSol0)); hist[k] = (hist[k] || 0) + 1; }
  out.distinct = ms.length; out.vSol0Hist = hist;
  const virt = {}; for (const m of ms) { const k = String(m.vTokVirt); virt[k] = (virt[k] || 0) + 1; } out.vTokVirtHist = virt;
  out.examples = Object.entries(out.mints).sort((a, b) => b[1].n - a[1].n).slice(0, 40).map(([k, m]) => Object.assign({ m: k.slice(0, 8) }, m));
  delete out.mints;
  console.log(JSON.stringify(out, null, 1));
  process.exit(0);
})();
