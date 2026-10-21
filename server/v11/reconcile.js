'use strict';
/* Legacy vs causal reconciliation (audit Section I evidence): every legacy-v10 trade and open position, checked against
   the timing rules v11 enforces, and paired with what its E0 twin (same rules, causal timing) did on the same coin.
   Flags:
     checks-late      the entry candle started before the coin's checks had come in (Finding 01)
     booked-late      the buy or sell was booked well after its candle (a replay, not a live decision)
     same-candle      a green-candle entry filled at the close of the candle that made the signal (Finding 02)
     in-gap           an entry or exit candle falls inside a time the server was offline (Finding 19)
     stop-unreachable the 90% stop sits under the bonding-curve floor (Finding 03)
     time-not-enforced an open position is past its time limit because no new candle arrived (Findings 11, 15)
   node server/v11/reconcile.js <legacy state.json> [v11.json] [--md] */
const fs = require('fs');
const LEGACY = require('../sniper.js');

function reconcile(st, v11, opts = {}) {
  const J = st.J, now = opts.now || (st.srv && st.srv.t ? st.srv.t / 1000 : J.last), sol = opts.sol || (st.srv && st.srv.sol) || J.lastSol || 100;
  const floorMc = LEGACY.CURVE_FLOOR * sol * LEGACY.SUPPLY;
  const evs = J.ev || [];
  const checksAt = m => { const e = evs.find(x => x[2] === 'watch' && x[4] === m); return e ? e[0] / 1000 : null; };
  const booked = (bot, kind, m, after) => { const e = evs.find(x => x[1] === bot && x[4] === m && (kind === 'buy' ? x[2] === 'buy' : (x[2] === 'win' || x[2] === 'loss')) && x[0] / 1000 >= after - 1); return e ? e[0] / 1000 : null; };
  const gaps = evs.filter(e => e[2] === 'gap').map(e => { const mm = String(e[3]).match(/offline for (?:(\d+)h )?(\d+)m/); const s = mm ? (+(mm[1] || 0) * 3600 + +mm[2] * 60) : 0; return [e[0] / 1000 - s, e[0] / 1000]; });
  const inGap = t => gaps.some(([a, b]) => t >= a && t < b);
  const rows = [];
  for (const b of LEGACY.RULES.BOTS) {
    const B = J.bots[b.id]; if (!B) continue;
    // v11.json keeps every trade; the page view inside state.json has an array of accounts with recent trades only
    const E = v11 && v11.accts && (Array.isArray(v11.accts) ? ((x => x && { trades: x.recent || [], pos: x.pos })(v11.accts.find(x => x.id === 'E0-' + b.id))) : v11.accts['E0-' + b.id]);
    const items = B.trades.map(t => ['closed', t]).concat(B.pos ? [['open', B.pos]] : []);
    for (const [kind, t] of items) {
      const k = J.coins[t.m] || {}, ca = checksAt(t.m), bIn = booked(b.id, 'buy', t.m, t.entryT), bOut = kind === 'closed' ? booked(b.id, 'sell', t.m, t.exitT) : null;
      const flags = [];
      if (ca && t.entryT < ca) flags.push(`checks-late: entry candle ${hm(t.entryT)}, checks in ${hm(ca)}`);
      if (bIn && bIn - (t.entryT + 60) > 120) flags.push(`booked-late: buy booked ${Math.round(bIn - t.entryT - 60)} s after its candle closed`);
      if (bOut && bOut - (t.exitT + 60) > 120) flags.push(`booked-late: sell booked ${Math.round(bOut - t.exitT - 60)} s after its candle closed`);
      if (t.how === 'green') flags.push('same-candle: filled at the close of its own signal candle');
      if (inGap(t.entryT) || (kind === 'closed' && inGap(t.exitT))) flags.push('in-gap: a fill inside a server outage');
      if (b.P.sl && t.entryMc * (1 - b.P.sl) < floorMc) flags.push(`stop-unreachable: stop at ${fmc(t.entryMc * (1 - b.P.sl))} under the curve floor ${fmc(floorMc)}`);
      if (kind === 'open' && b.P.maxHold && now - t.entryT > b.P.maxHold * 60 + 300) flags.push(`time-not-enforced: ${b.P.maxHold} min limit passed ${Math.round((now - t.entryT - b.P.maxHold * 60) / 60)} min ago, no candle since`);
      let twin = null;
      if (E) {
        const et = (E.trades || []).concat(E.pos ? [E.pos] : []).filter(x => x.m === t.m);
        twin = et.length ? et.map(x => ({ at: x.at, fill: x.quoteAt, exit: x.exitQuoteAt || null, reason: x.exitReason || 'open', net: x.net != null ? x.net : null })) : 'no trade on this coin';
      }
      rows.push({ bot: b.id, kind, sym: t.sym || k.sym, m: t.m, crossed: k.x || null, checks: ca, entryT: t.entryT, buyBooked: bIn, entryMc: t.entryMc, exitT: t.exitT || null, sellBooked: bOut,
        out: kind === 'closed' ? t.out : 'open', net: kind === 'closed' ? t.net : null, flags, twin });
    }
  }
  return { at: now, sol, floorMc, gaps, rows };
}
const hm = t => new Date(t * 1000).toISOString().slice(11, 16);
const fmc = v => '$' + (v >= 1000 ? (v / 1000).toFixed(1) + 'K' : v.toFixed(0));
function markdown(r) {
  const out = ['| Bot | Coin | Entry candle (UTC) | Booked | Checks in | Entry MC | Exit | Net SOL | Flags | E0 twin |', '|---|---|---|---|---|---|---|---|---|---|'];
  for (const x of r.rows) out.push(`| ${x.bot} | ${x.sym} | ${hm(x.entryT)} | ${x.buyBooked ? new Date(x.buyBooked * 1000).toISOString().slice(11, 19) : '?'} | ${x.checks ? new Date(x.checks * 1000).toISOString().slice(11, 19) : '?'} | ${fmc(x.entryMc)} | ${x.out}${x.exitT ? ' ' + hm(x.exitT) : ''} | ${x.net != null ? (x.net >= 0 ? '+' : '') + x.net.toFixed(4) : 'open'} | ${x.flags.join('; ') || 'none'} | ${x.twin == null ? 'not running yet' : typeof x.twin === 'string' ? x.twin : x.twin.map(y => `${y.reason}${y.net != null ? ' ' + y.net.toFixed(4) : ''}`).join(', ')} |`);
  return out.join('\n');
}
module.exports = { reconcile, markdown };

if (require.main === module) {
  const a = process.argv.slice(2), md = a.includes('--md'), f = a.filter(x => !x.startsWith('--'));
  const st = JSON.parse(fs.readFileSync(f[0], 'utf8')), v11 = f[1] ? JSON.parse(fs.readFileSync(f[1], 'utf8')) : (st.v11 || null);
  const r = reconcile(st, v11);
  console.log(md ? markdown(r) : JSON.stringify(r, null, 1));
}
