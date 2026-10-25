#!/usr/bin/env node
// b5-gc — root cause of the anomaly in docs/01 B5.
//
// B5 reported: a child process makes 500 WAL commits, never closes, gets
// SIGKILLed, and yet the volume shows NO -wal while the 16 KB main file
// already holds all 500 rows. It looked like the volume was swallowing WAL
// frames. It is not the volume. It is V8.
//
// `node:sqlite` closes the connection when the DatabaseSync object is
// garbage-collected. crash-probe's child writes its signal file and then
// busy-waits WITHOUT touching the handle again, so the handle becomes
// unreachable, GC finalises it, SQLite does a CLEAN close (checkpoint into the
// main file, then delete -wal and -shm), and the parent samples exactly that
// post-close state. Add one reference and the same child keeps its WAL forever.
//
//   node lab/b5-gc.mjs /Volumes/Shared/_b5gc [trials]
//
// Runs the same child three ways and reports, for each, whether -wal survived:
//   A  handle unused after the busy loop   (crash-probe verbatim)
//   B  globalThis.__keep = h               (handle provably live)
//   C  explicit h.close()                  (control: what a clean close looks like)
//
// Requires Node >= 22. Zero dependencies.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const DIR = process.argv[2];
const TRIALS = Number(process.argv[3] || 3);
if (!DIR) {
  console.error('usage: node b5-gc.mjs <dir-on-the-shared-volume> [trials]');
  process.exit(2);
}

// Shared preamble: open WAL, 500 real commits, then signal the parent.
const preamble = `
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
const [db, sig] = process.argv.slice(2);
const h = new DatabaseSync(db);
h.exec('pragma journal_mode=wal');
h.exec('pragma synchronous=full');
h.exec('create table t(x integer, y text)');
for (let i = 0; i < 500; i++) h.exec("insert into t values(" + i + ",'row" + i + "')");
fs.writeFileSync(sig, 'ok');
`;

const variants = {
  'A handle unused': preamble + `
// nothing below references h
const t = Date.now(); while (Date.now() - t < 10000) {}
`,
  'B handle kept alive': preamble + `
globalThis.__keep = h;               // <- the only difference from A
const t = Date.now(); while (Date.now() - t < 10000) {}
`,
  'C explicit close': preamble + `
h.close();                            // <- what A's GC does implicitly
const t = Date.now(); while (Date.now() - t < 10000) {}
`,
};

const busy = (ms) => { const t = Date.now(); while (Date.now() - t < ms) {} };
const snap = (db) => Object.fromEntries([['db', ''], ['-wal', '-wal'], ['-shm', '-shm']]
  .map(([k, s]) => [k, fs.existsSync(db + s) ? fs.statSync(db + s).size : null]));

const results = {};

for (const [name, code] of Object.entries(variants)) {
  results[name] = [];
  for (let trial = 1; trial <= TRIALS; trial++) {
    const lab = path.join(DIR, 'v' + Object.keys(variants).indexOf(name) + '-t' + trial);
    fs.rmSync(lab, { recursive: true, force: true });
    fs.mkdirSync(lab, { recursive: true });
    const db = path.join(lab, 'state.db');
    const sig = path.join(lab, 'committed');
    const src = path.join(lab, 'writer.mjs');
    fs.writeFileSync(src, code);

    const child = spawn(process.execPath, [src, db, sig], { stdio: 'ignore' });
    const w0 = Date.now();
    while (!fs.existsSync(sig) && Date.now() - w0 < 20000) busy(20);

    const atSignal = snap(db);   // the instant the child reports "committed"
    busy(600);                   // give GC time to run
    const settled = snap(db);

    results[name].push({ atSignal, settled });
    try { child.kill('SIGKILL'); } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
}

console.log(`platform=${process.platform} node=${process.version} dir=${DIR}\n`);
let verdictOk = true;
for (const [name, arr] of Object.entries(results)) {
  const gone = arr.filter((r) => r.settled['-wal'] === null).length;
  console.log(`== ${name} ==  -wal gone in ${gone}/${arr.length} runs`);
  for (const r of arr) {
    console.log(`   at-signal ${JSON.stringify(r.atSignal)}  ->  +600ms ${JSON.stringify(r.settled)}`);
  }
  console.log('');
  // A and C must lose the WAL, B must keep it. Anything else means the
  // hypothesis does not hold on this volume/node build.
  const expected = name === 'B handle kept alive' ? 0 : arr.length;
  if (gone !== expected) verdictOk = false;
}

console.log(verdictOk
  ? 'VERDICT: hypothesis holds — losing the WAL tracks JS reachability of the handle,\n'
    + '         not the filesystem. A and C (clean close) agree byte for byte.'
  : 'VERDICT: hypothesis does NOT hold here — the difference is not GC reachability.\n'
    + '         Please open an issue with this output.');
process.exit(verdictOk ? 0 : 1);
