'use strict';
/* Replays recorded v11 inputs (the .jsonl.gz files under v11-inputs/) through the engine.
     node server/tools/v11_replay.js <dir> [--state <v11.json>]
   <dir> holds a v11-inputs/ folder (a checkout of the research branch, or a sim output folder). Every server run after
   the first must load exactly the state the replay rebuilt for it, and with --state the last save that reached the data
   branch must equal that file. Prints "V11 REPLAY EXACT" when everything matches. */
const fs = require('fs');
const path = require('path');
const REC = require('../v11/record.js');

function files(dir) {
  const out = [];
  (function walk(d) { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else if (/\.jsonl\.gz$/.test(f.name)) out.push(p); } })(dir);
  return out.sort();
}
function main() {
  const dir = process.argv[2], si = process.argv.indexOf('--state');
  const list = files(path.join(dir, 'v11-inputs'));
  if (!list.length) { console.log('no v11 inputs under', dir); process.exit(1); }
  const t = Date.now();
  const r = REC.replayExact(list.map(f => fs.readFileSync(f)));
  let ok = r.loads > 0;
  console.log(`replayed ${list.length} files: ${r.loads} loads, ${r.events} events, ${r.ticks} ticks in ${((Date.now() - t) / 1000).toFixed(1)} s`);
  for (const c of r.checks) { console.log(`  run start ${new Date(c.at).toISOString()}: ${c.same ? 'loaded state matches the replay' : 'DIFFERENT: ' + c.detail}`); ok = ok && c.same; }
  if (si > 0) {
    const want = JSON.parse(fs.readFileSync(process.argv[si + 1], 'utf8'));
    const d = r.lastSave ? REC.firstDiff(REC.roundTrip(r.lastSave), want) : 'no committed save in the recording';
    console.log(d ? `  final state DIFFERENT: ${d}` : '  final saved state matches the replay');
    ok = ok && !d;
  }
  const S = r.eng && r.eng.state();
  if (S) for (const A of Object.values(S.accts)) console.log(`  ${A.id.padEnd(8)} cash ${A.cash.toFixed(4)} trades ${A.trades.length}${A.pos ? ' holding ' + A.pos.sym : ''}`);
  console.log(ok ? 'V11 REPLAY EXACT' : 'V11 REPLAY DIFFERS');
  process.exit(ok ? 0 : 1);
}
if (require.main === module) main();
module.exports = { files };
