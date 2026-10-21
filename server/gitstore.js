'use strict';
/* Where the server keeps things on GitHub: the bots' state on the `data` branch (one force-pushed commit with no history,
   so the branch never grows) and research files on the `research` branch (normal commits through the REST API). */
const fs = require('fs'), path = require('path');
const { execFile } = require('child_process');

function makeStore({ repo, token, dir, branch = 'data', log = () => {} }) {
  const API = `https://api.github.com/repos/${repo}`;
  const GH = { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'meme-sniper-bot' };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const DIR = dir, BRANCH = branch;
  async function gh(method, p, body) {
    const r = await fetch(API + p, { method, headers: GH, body: body ? JSON.stringify(body) : undefined });
    const j = r.status === 204 ? null : await r.json().catch(() => null);
    return { status: r.status, j };
  }
  function git(args, timeout = 120000) {
    const auth = token ? ['-c', 'http.https://github.com/.extraheader=AUTHORIZATION: basic ' + Buffer.from('x-access-token:' + token).toString('base64')] : [];
    return new Promise((res, rej) => execFile('git', [...auth, ...args], { cwd: DIR, timeout, maxBuffer: 256 << 20 },
      (e, out, err) => e ? rej(new Error(String(err || e.message).trim().split('\n').slice(-2).join(' ').slice(0, 300))) : res(String(out))));
  }
  const written = new Map();   // tc files already on the branch: mint -> version
  const store = {
    async load() {
      fs.rmSync(DIR, { recursive: true, force: true }); fs.mkdirSync(DIR, { recursive: true });
      await git(['init', '-q']);
      await git(['config', 'user.name', 'github-actions[bot]']);
      await git(['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com']);
      await git(['remote', 'add', 'origin', `https://github.com/${repo}.git`]);
      let heads = null;
      for (let i = 0; i < 6 && heads == null; i++) { try { heads = await git(['ls-remote', '--heads', 'origin', BRANCH]); } catch (e) { log('ls-remote: ' + e.message); await sleep(10000 * (i + 1)); } }
      if (heads == null) throw new Error('GitHub unreachable: not starting, so the saved state is never overwritten');
      if (!heads.trim()) return null;
      await git(['fetch', '-q', '--depth', '1', 'origin', BRANCH]);
      await git(['checkout', '-q', 'FETCH_HEAD', '--', '.']);
      const rd = f => { try { return JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); } catch (e) { return null; } };
      const state = rd('state.json');
      if (!state || !state.J || !state.J.bots) throw new Error(`state.json on the ${BRANCH} branch is missing or broken`);
      const tc = {}, td = path.join(DIR, 'tc');
      if (fs.existsSync(td)) for (const f of fs.readdirSync(td)) { const v = rd('tc/' + f); if (v && Array.isArray(v.r)) { const m = f.replace(/\.json$/, ''); tc[m] = v; written.set(m, v.u); } }
      return { state, young: rd('young.json') || [], rq: rd('rq.json') || [], tc, extra: { 'v11.json': rd('v11.json') } };
    },
    // one commit with no history each time (force-pushed), so the branch never grows
    async save({ state, young, rq, tc, extra }) {
      const files = [['state.json', JSON.stringify(state)], ['young.json', JSON.stringify(young)], ['rq.json', JSON.stringify(rq)]];
      for (const [f, obj] of Object.entries(extra || {})) if (obj) files.push([f, JSON.stringify(obj)]);
      const tcs = Object.entries(tc || {}).filter(([m, v]) => written.get(m) !== v.u).map(([m, v]) => [m, v.u, JSON.stringify(v)]);
      const keep = new Set(Object.keys(tc || {}));
      for (const [f, s] of files) fs.writeFileSync(path.join(DIR, f), s);
      const td = path.join(DIR, 'tc'); fs.mkdirSync(td, { recursive: true });
      for (const [m, , s] of tcs) fs.writeFileSync(path.join(td, m + '.json'), s);
      for (const f of fs.readdirSync(td)) if (!keep.has(f.replace(/\.json$/, ''))) fs.unlinkSync(path.join(td, f));
      await git(['add', '-A']);
      const tree = (await git(['write-tree'])).trim();
      const c = (await git(['commit-tree', tree, '-m', `bot state ${new Date().toISOString()}`])).trim();
      await git(['push', '-q', '-f', 'origin', `${c}:refs/heads/${BRANCH}`]);
      for (const [m, u] of tcs) written.set(m, u);
    },
    async putResearch(p, buf) {
      const body = { message: `research ${p}`, content: buf.toString('base64'), branch: 'research' };
      let r = await gh('PUT', `/contents/${p}`, body);
      if (r.status === 404 || (r.status === 422 && /branch/i.test(JSON.stringify(r.j || {})))) { await researchBranch(); r = await gh('PUT', `/contents/${p}`, body); }
      if (r.status !== 201 && r.status !== 200) throw new Error(`HTTP ${r.status} ${(r.j && r.j.message) || ''}`.trim().slice(0, 120));
    },
  };
  async function researchBranch() {
    const readme = '# Meme Sniper research data\n\nEvery pump.fun coin the server saw cross $7K market cap: its rug checks at that moment and its final 1-minute candles (market cap in USD, plus SOL/USD) from launch to 2 h after the crossing. Gzipped JSON lines, one file per hour per server run.\n';
    const t = await gh('POST', '/git/trees', { tree: [{ path: 'README.md', mode: '100644', type: 'blob', content: readme }] });
    if (!t.j || !t.j.sha) throw new Error('tree HTTP ' + t.status);
    const c = await gh('POST', '/git/commits', { message: 'Start the research data', tree: t.j.sha, parents: [] });
    if (!c.j || !c.j.sha) throw new Error('commit HTTP ' + c.status);
    const r = await gh('POST', '/git/refs', { ref: 'refs/heads/research', sha: c.j.sha });
    if (r.status !== 201 && r.status !== 422) throw new Error('ref HTTP ' + r.status);
  }
  return { store, gh, git };
}
module.exports = { makeStore };
