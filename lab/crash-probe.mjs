#!/usr/bin/env node
// crash-probe — two questions that decide the whole protocol:
//
//   (1) NAIVE HANDOFF: if you copy only `state.db` while the app is running and
//       there is a hot -wal, what does the copy actually contain?
//   (2) HARD KILL: after SIGKILL (no clean close, no checkpoint), what is left
//       on disk, and can the next boot read it?
//
//   node lab/crash-probe.mjs /Volumes/Shared/_probe
//   node lab/crash-probe.mjs X:\_probe
//
// Requires Node >= 22 (node:sqlite). The child reports through a file because
// some sandboxes block piped stdio between processes.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const LAB = process.argv[2];
if (!LAB) {
  console.error('usage: node crash-probe.mjs <dir-on-the-shared-volume>');
  process.exit(2);
}

const clean = (p) => { try { fs.rmSync(p, { recursive: true, force: true }); } catch {} };
const busy = (ms) => { const t = Date.now(); while (Date.now() - t < ms) {} };
const snap = (p) => Object.fromEntries(['', '-wal', '-shm', '-journal']
  .map((s) => [s || 'db', fs.existsSync(p + s) ? fs.statSync(p + s).size : null]));
const rowsIn = async (file) => {
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const h = new DatabaseSync(file, { readOnly: true });
    const r = {
      rows: h.prepare('select count(*) c from t').get().c,
      integrity: h.prepare('pragma integrity_check').get().integrity_check,
      journal_mode: h.prepare('pragma journal_mode').get().journal_mode,
    };
    h.close();
    return r;
  } catch (e) { return { error: e.message }; }
};

clean(LAB);
fs.mkdirSync(LAB, { recursive: true });

const script = path.join(LAB, 'writer.mjs');
const signal = path.join(LAB, 'committed');
const dbPath = path.join(LAB, 'state.db');

fs.writeFileSync(script, `
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
const [db, sig] = process.argv.slice(2);
const h = new DatabaseSync(db);
h.exec('pragma journal_mode=wal');
h.exec('pragma synchronous=full');
h.exec('create table t(x integer, y text)');
for (let i = 0; i < 500; i++) h.exec("insert into t values(" + i + ",'row" + i + "')");
fs.writeFileSync(sig, 'ok');
const t = Date.now(); while (Date.now() - t < 30000) {}
`);

const res = { lab: LAB, platform: process.platform, node: process.version };
const child = spawn(process.execPath, [script, dbPath, signal], { stdio: 'ignore' });
let exitEvent = null;
child.on('exit', (code, sig) => { exitEvent = { code, signal: sig }; });

const t0 = Date.now();
while (!fs.existsSync(signal) && Date.now() - t0 < 30000) busy(50);
res.child_reached_commit = fs.existsSync(signal);
res.state_while_alive = snap(dbPath);

// ---- (1) naive handoff: copy the .db only, while the app is still running ----
{
  const naive = path.join(LAB, 'naive-copy.db');
  fs.copyFileSync(dbPath, naive);
  res.naive_copy = { copied: ['state.db'], skipped: ['-wal', '-shm'], ...(await rowsIn(naive)) };
  clean(naive);
}

// ---- (2) hard kill ----
try { process.kill(child.pid, 0); res.alive_before_kill = true; } catch { res.alive_before_kill = false; }
try { process.kill(child.pid, 'SIGKILL'); res.kill = 'SIGKILL sent'; } catch (e) { res.kill = 'ERR:' + e.message; }
busy(1500);
res.exit_event = exitEvent;
res.state_after_kill = snap(dbPath);
res.open_after_kill = await rowsIn(dbPath);
res.state_after_reader_close = snap(dbPath);

// ---- (3) and a db-only copy of the killed state ----
{
  const copy = path.join(LAB, 'killed-copy.db');
  fs.copyFileSync(dbPath, copy);
  res.db_only_copy_after_kill = await rowsIn(copy);
  clean(copy);
}

console.log(JSON.stringify(res, null, 2));
clean(LAB);
