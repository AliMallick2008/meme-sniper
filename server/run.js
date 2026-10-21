'use strict';
/* GitHub Actions entry: runs the paper bots for RUN_SECONDS (about 5 h 45 min), then asks GitHub for the next run and
   exits; the next run picks up the saved state. State lives on the `data` branch (state.json, read by the page, plus
   young.json, rq.json and tc/<coin>.json); research data goes to the `research` branch.
   Needs GH_TOKEN (the workflow's own token) and GITHUB_REPOSITORY. Paper only: no wallet, no keys, no orders. */
const os = require('os'), path = require('path');
const { runServer } = require('./main.js');
const { makeStore } = require('./gitstore.js');

const REPO = process.env.GITHUB_REPOSITORY;
const TOKEN = process.env.GH_TOKEN;
const RUN_S = +process.env.RUN_SECONDS || 20700;
const SHA = process.env.GITHUB_SHA || '';
const RUN = process.env.GITHUB_RUN_ID || 'local';
const DIR = path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'sniper-data');
const BRANCH = process.env.DATA_BRANCH || 'data';
const UA = `meme-sniper-paper-bot/1.0 (+https://github.com/${REPO})`;
const log = s => console.log(`${new Date().toISOString()} ${s}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));
let stopAsked = false;
const { store, gh, git } = makeStore({ repo: REPO, token: TOKEN, dir: DIR, branch: BRANCH, log });

async function http(url) {
  const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { accept: 'application/json', 'user-agent': UA } });
    return { status: r.status, json: r.ok ? await r.json() : null };
  } finally { clearTimeout(to); }
}

// the next run waits (same concurrency group) until this one has saved and exited, then starts on the saved state
async function handover(why) {
  if (why === 'signal') return;   // cancelled: the watchdog decides
  const r = await gh('POST', '/actions/workflows/sniper.yml/dispatches', { ref: 'main' });
  log(`asked for the next run (${why}): HTTP ${r.status}`);
}
async function checkUpdate() {
  try { const out = await git(['ls-remote', 'origin', 'refs/heads/main'], 30000); const sha = out.split(/\s/)[0]; return !!(SHA && sha && sha !== SHA); } catch (e) { return false; }
}

process.on('unhandledRejection', e => log('unhandled: ' + (e && e.stack || e)));
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { log('got ' + sig); stopAsked = true; });
(async () => {
  if (!REPO || !TOKEN) { console.error('GITHUB_REPOSITORY and GH_TOKEN are needed'); process.exit(1); }
  const t0 = Date.now();
  try {
    const r = await runServer({ clock: { now: () => Date.now(), sleep }, http, store, runS: RUN_S, log, handover, checkUpdate, shouldStop: () => stopAsked, info: { run: RUN, sha: SHA.slice(0, 7) } });
    log('done: ' + r.why);
    process.exit(0);
  } catch (e) {
    log('fatal: ' + (e && e.stack || e));
    if (Date.now() - t0 > 10 * 60000) { try { await handover('crash'); } catch (e2) { /* the watchdog restarts it */ } }
    process.exit(1);
  }
})();
