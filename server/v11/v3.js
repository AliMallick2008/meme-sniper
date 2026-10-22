'use strict';
/* v3.0: the V2 strategies with tape execution (research/v3_protocol.md).
     A3   v2.0's A, valued, reviewed and filled on the trade tape while it is live
     A3e  A3 plus two emergency exits from the tape: the creator sells, or a 20% drop inside 10 seconds
     B3   v2.0's B on the tape
   Entries are v2.0's (v2.js) plus one requirement: the coin's tape is live. The tape mechanics (curve fills 2 s after
   the decision, curve marks, a review after every tape observation) are in engine.js; they apply only to accounts with
   `tape: true`. Rules are locked at LOCKED; a change is a new version beside this one, never an edit. */
const V2 = require('./v2.js');

const VERSION = 'v3.0';
const LOCKED = Date.UTC(2026, 9, 22, 15, 20, 0);   // Thu Oct 22 2026, 3:20 PM UTC (11:20 AM ET), research/v3_protocol.md
const FILL_MS = 2000;                               // fills use the curve as last received at or before decision + 2 s
const CRASH = { drop: 0.20, winMs: 10000 };         // A3e: 20% under the highest trade price of the last 10 s

const DEFS = {
  A3: { from: 'A', name: 'A3: Launch Momentum on the tape',
    desc: 'The same rules as A, but the position is valued and reviewed on every trade (the trade tape) and orders fill against the bonding curve 2 s after the decision. Only coins whose tape is live.' },
  A3e: { from: 'A', name: 'A3e: A3 with rug exits', tapeEmergency: true,
    desc: 'A3, plus it sells at once if the coin\'s creator wallet sells anything after the buy, or if the price drops 20% inside 10 seconds.' },
  B3: { from: 'B', name: 'B3: Pullback Recovery on the tape',
    desc: 'The same rules as B, valued, reviewed and filled on the trade tape while it is live.' },
};

function accounts() {
  const base = Object.fromEntries(V2.accounts().map(a => [a.id, a]));
  return Object.entries(DEFS).map(([id, d]) => {
    const b = base[d.from];
    return Object.assign({}, b, { id, exp: `v11-${VERSION}/${id}`, version: VERSION, locked: LOCKED, name: d.name, desc: d.desc, tape: true, tapeEmergency: !!d.tapeEmergency,
      P: Object.assign({}, b.P), C: Object.assign({}, b.C) });
  });
}

/* A3e: the creator sold after the entry, or the curve price is 20%+ under the highest price the curve had in the last
   10 s: every trade in that window, and the price it started the window at (the last trade before it), count
   (Amendment 1, research/v3_protocol.md: a quiet coin dumped in one trade must count as a drop) */
function emergency(pos, c, at) {
  const t = c.tp; if (!t) return null;
  if (t.crSellAt && t.crSellAt > pos.openAt && t.crSellAt <= at) return `the creator wallet (${t.cr}) sold after the buy`;
  const ps = t.last && t.last.ps;
  let hi = 0;
  for (let i = t.tr.length - 1; i >= 0; i--) {
    const x = t.tr[i]; if (x[0] > at) continue;
    if (x[6] > hi) hi = x[6];
    if (at - x[0] > CRASH.winMs) break;          // the last trade before the window: the price the window started at
  }
  if (hi > 0 && ps && ps <= hi * (1 - CRASH.drop)) return `the price fell ${((1 - ps / hi) * 100).toFixed(0)}% inside 10 seconds`;
  return null;
}
module.exports = { VERSION, LOCKED, FILL_MS, CRASH, DEFS, accounts, emergency };
