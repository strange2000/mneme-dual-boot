#!/usr/bin/env node
// handoff-selftest.mjs — end-to-end check of handoff.mjs against a real directory.
//
//   node lab/handoff-selftest.mjs <writable dir>     # e.g. E:/_handoff-test  or  /Volumes/Shared/_test
//
// Creates (and wipes) <dir>/selftest, drives the four commands through the
// situations that matter, and asserts the exit codes. Nothing outside
// <dir>/selftest is touched. Run it on the volume you actually intend to use:
// the point is to check the file system, not just the script.
//
// Zero dependencies. Node >= 22.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const handoff = path.join(import.meta.dirname, '..', 'handoff.mjs');

const root = process.argv[2];
if (!root) {
  console.error('usage: node lab/handoff-selftest.mjs <writable dir>');
  process.exit(30);
}
const T = path.join(root, 'selftest');
const db = path.join(T, 'state.db');

// --------------------------------------------------------------- harness ---
let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  if (actual === expected) { pass++; console.log(`  ✓ ${label} → ${actual}`); }
  else { fail++; console.log(`  ✗ ${label} → ${actual} (expected ${expected})`); }
};

// The child's output goes to a file rather than a pipe: some sandboxes deny
// piped stdio between processes, and a false failure here would be worse than
// a log file to look at.
const logFile = path.join(T, '.selftest-child.log');
const run = (cmd, ...flags) => {
  const fd = fs.openSync(logFile, 'w');
  let r;
  try {
    r = spawnSync(process.execPath, [handoff, cmd, T, '--db', 'state.db', ...flags], {
      stdio: ['ignore', fd, fd],
    });
  } finally { fs.closeSync(fd); }
  const out = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
  return { code: r.status ?? -1, out };
};
const rows = () => {
  const d = new DatabaseSync(db);
  try { return d.prepare('select count(*) c from state').get().c; }
  finally { d.close(); }
};
const tamperPage = (page) => {
  const fd = fs.openSync(db, 'r+');
  try {
    fs.writeSync(fd, Buffer.alloc(4096, 0xff), 0, 4096, page * 4096);
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
};
const snaps = () => {
  const d = path.join(T, '.handoff', 'snapshots');
  return fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith('.db')).length : 0;
};

// ------------------------------------------------------------------ seed ---
console.log(`\n[1] seed ${T}`);
fs.rmSync(T, { recursive: true, force: true });
fs.mkdirSync(T, { recursive: true });
{
  const d = new DatabaseSync(db);
  d.exec('PRAGMA journal_mode=wal');
  d.exec('create table state (id integer primary key, note text)');
  const ins = d.prepare('insert into state (note) values (?)');
  const tx = d.prepare('select 1');
  d.exec('begin');
  for (let i = 0; i < 500; i++) ins.run('note ' + i);
  d.exec('commit');
  tx.get();
  d.close();
}
fs.writeFileSync(path.join(T, 'mirror.md'), '# a human-editable mirror\n');
console.log(`    state.db = ${fs.statSync(db).size} B, ${rows()} rows`);

// ------------------------------------------------------------- baseline ---
console.log('\n[2] first run has no receipt');
const r2 = run('status');
check('status exits 0 and says there is no receipt', r2.code === 0 && /no receipt yet/.test(r2.out), true);
check('open', run('open', '--owner', 'windows').code, 13);
check('close establishes a baseline', run('close', '--owner', 'windows').code, 0);
check('status after baseline', run('status').code, 0);

// -------------------------------------------------------- open / re-open ---
console.log('\n[3] open, then open again without closing');
check('open', run('open', '--owner', 'windows').code, 0);
check('second open is refused as dirty', run('open', '--owner', 'windows').code, 10);

console.log('\n[4] recover a dirty-but-healthy directory (keeps the data)');
check('recover', run('recover', '--owner', 'windows').code, 0);
check('rows kept', rows(), 500);

console.log('\n[5] clean close');
check('close', run('close', '--owner', 'windows').code, 0);
const genBefore = JSON.parse(fs.readFileSync(path.join(T, '.handoff', 'handoff.json'), 'utf8')).gen;
console.log(`    gen = ${genBefore}, snapshots = ${snaps()}`);

// ------------------------------------------------------------- recovery ---
console.log('\n[6] a database that was changed outside a handoff is refused');
tamperPage(1);
check('open', run('open', '--owner', 'windows').code, 11);

console.log('\n[7] corrupt the database for real → rollback');
fs.rmSync(path.join(T, '.handoff', 'DIRTY'), { force: true });
const r7 = run('recover', '--owner', 'windows');
check('recover', r7.code, 0);
check('rolled back to a verified snapshot (rows)', rows(), 500);
check('the damaged database was kept, not deleted',
  fs.existsSync(path.join(T, '.handoff', 'abandoned')) &&
  fs.readdirSync(path.join(T, '.handoff', 'abandoned')).length > 0, true);

// ---------------------------------------------------------------- quirk ---
console.log('\n[8] a hand-edited mirror warns but does not block');
check('close', run('close', '--owner', 'windows').code, 0);
fs.appendFileSync(path.join(T, 'mirror.md'), '- a line I typed myself\n');
const r8 = run('open', '--owner', 'windows');
check('open still allowed', r8.code, 0);
check('but it says so', /differ from the receipt/.test(r8.out), true);
fs.rmSync(path.join(T, '.handoff', 'DIRTY'), { force: true });

// -------------------------------------------------------------- rotation ---
console.log('\n[9] snapshots are rotated');
check('close', run('close', '--owner', 'windows').code, 0);
check('at most two snapshots kept', snaps() <= 2, true);

// ----------------------------------------------------------------- done ---
console.log(`\n${fail === 0 ? 'all good' : 'FAILURES'}: ${pass} passed, ${fail} failed`);
console.log(`leaving ${T} in place — inspect it, or delete it.\n`);
process.exit(fail === 0 ? 0 : 1);
