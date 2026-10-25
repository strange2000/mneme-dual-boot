#!/usr/bin/env node
// exFAT capability probe — every number in the README's table comes from here.
//
//   node lab/exfat-probe.mjs /Volumes/Shared/_probe     (macOS)
//   node lab/exfat-probe.mjs X:\_probe                  (Windows)
//
// Nothing outside the given directory is touched; it is removed at the end
// unless you pass --keep. Requires Node >= 22 (uses node:sqlite).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const LAB = process.argv[2];
const KEEP = process.argv.includes('--keep');
if (!LAB) {
  console.error('usage: node exfat-probe.mjs <dir-on-the-shared-volume> [--keep]');
  process.exit(2);
}

const out = { lab: LAB, platform: process.platform, node: process.version, at: new Date().toISOString(), tests: {} };
const rec = (k, v) => { out.tests[k] = v; console.log(String(k).padEnd(38), JSON.stringify(v)); };
const clean = (p) => { try { fs.rmSync(p, { recursive: true, force: true }); } catch {} };
const busy = (ms) => { const t = Date.now(); while (Date.now() - t < ms) {} };

clean(LAB);
fs.mkdirSync(LAB, { recursive: true });
console.log(`\n== ${LAB} (${process.platform}, node ${process.version}) ==\n`);

// 1. timestamp granularity ---------------------------------------------------
{
  const f = path.join(LAB, 'grain.bin');
  const samples = [];
  for (let i = 0; i < 20; i++) {
    fs.writeFileSync(f, 'x'.repeat(i + 1));
    samples.push(fs.statSync(f, { bigint: true }).mtimeNs.toString());
    busy(250);
  }
  const nums = [...new Set(samples)].map(BigInt).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  let min = null;
  for (let i = 1; i < nums.length; i++) { const d = Number(nums[i] - nums[i - 1]); if (d > 0 && (min === null || d < min)) min = d; }
  rec('mtime_distinct_of_20_writes_5s', nums.length);
  rec('mtime_granularity_seconds', min === null ? null : +(min / 1e9).toFixed(3));
  fs.rmSync(f, { force: true });
}

// 2. case sensitivity -------------------------------------------------------
{
  const f = path.join(LAB, 'CaseProbe.TXT');
  fs.writeFileSync(f, 'first');
  let viaLower = 'ERR';
  try { viaLower = fs.readFileSync(path.join(LAB, 'caseprobe.txt'), 'utf8'); } catch (e) { viaLower = 'ERR:' + e.code; }
  let collide = 'ERR';
  try { fs.writeFileSync(path.join(LAB, 'caseprobe.txt'), 'second'); collide = 'wrote-through-lower-name'; } catch (e) { collide = 'ERR:' + e.code; }
  rec('case_insensitive', viaLower === 'first');
  rec('case_collision', collide);
  rec('content_after_lowercase_write', fs.readFileSync(f, 'utf8'));
  fs.rmSync(f, { force: true });
}

// 3. POSIX permissions ------------------------------------------------------
{
  const f = path.join(LAB, 'perm.bin');
  fs.writeFileSync(f, 'secret');
  try { fs.chmodSync(f, 0o600); } catch {}
  const mode = fs.statSync(f).mode & 0o777;
  rec('mode_after_chmod_0600', '0o' + mode.toString(8));
  rec('permissions_enforced', (mode & 0o077) === 0);
  fs.rmSync(f, { force: true });
}

// 4. links ------------------------------------------------------------------
{
  const f = path.join(LAB, 'l.bin'); fs.writeFileSync(f, 'd');
  const t = {};
  for (const [k, fn] of [
    ['symlink', () => fs.symlinkSync(f, path.join(LAB, 'l.sym'))],
    ['hardlink', () => fs.linkSync(f, path.join(LAB, 'l.hard'))],
  ]) {
    try { fn(); t[k] = 'ok'; } catch (e) { t[k] = `${e.code ?? 'ERR'}/${e.errno ?? '?'}`; }
  }
  rec('links', t);
  clean(f); clean(path.join(LAB, 'l.sym')); clean(path.join(LAB, 'l.hard'));
}

// 5. primitives the protocol depends on -------------------------------------
{
  const a = path.join(LAB, 'a.bin'), b = path.join(LAB, 'b.bin');
  fs.writeFileSync(a, 'A'); fs.writeFileSync(b, 'BBBB');
  let ren = 'ERR';
  try { fs.renameSync(a, b); ren = 'ok:' + fs.readFileSync(b, 'utf8'); } catch (e) { ren = 'ERR:' + e.code; }
  rec('rename_over_existing', ren);

  const l = path.join(LAB, 'lock.probe');
  fs.writeFileSync(l, '1');
  let wx = 'ERR';
  try { const fd = fs.openSync(l, 'wx'); fs.closeSync(fd); wx = 'SUCCEEDED — no exclusion!'; } catch (e) { wx = 'blocked:' + e.code; }
  rec('exclusive_create_wx', wx);
  clean(a); clean(b); clean(l);
}

// 6. sqlite -----------------------------------------------------------------
try {
  const { DatabaseSync } = await import('node:sqlite');
  const p = path.join(LAB, 'probe.db');
  [p, p + '-wal', p + '-shm', p + '-journal'].forEach(clean);
  const db = new DatabaseSync(p);
  rec('sqlite_version', db.prepare('select sqlite_version() v').get().v);

  const modes = {};
  for (const m of ['delete', 'truncate', 'persist', 'wal']) {
    try { modes[m] = db.prepare(`pragma journal_mode=${m}`).get().journal_mode; } catch (e) { modes[m] = 'ERR:' + e.message; }
  }
  rec('journal_mode_roundtrip', modes);

  // commit cost, 300 synchronous commits
  const bench = (mode) => {
    db.exec(`pragma journal_mode=${mode}`); db.exec('pragma synchronous=FULL');
    db.exec('create table if not exists t(x integer, y text)'); db.exec('delete from t');
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < 300; i++) { db.exec('begin'); db.prepare('insert into t values(?,?)').run(i, 'y'.repeat(100)); db.exec('commit'); }
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    return { per_commit_ms: +(ms / 300).toFixed(2) };
  };
  rec('commit_cost_300_sync_commits', { delete: bench('delete'), wal: bench('wal') });

  // WAL materialises, and TRUNCATE really empties it
  db.exec('pragma journal_mode=wal');
  db.exec("insert into t values(1,'hot')");
  rec('wal_bytes_while_open', fs.existsSync(p + '-wal') ? fs.statSync(p + '-wal').size : null);
  const ck = db.prepare('pragma wal_checkpoint(TRUNCATE)').get();
  rec('wal_checkpoint_truncate', ck);
  rec('wal_bytes_after_truncate', fs.existsSync(p + '-wal') ? fs.statSync(p + '-wal').size : 'absent');
  rec('integrity_check', db.prepare('pragma integrity_check').get().integrity_check);
  db.close();
  rec('transient_files_after_clean_close', {
    wal: fs.existsSync(p + '-wal'), shm: fs.existsSync(p + '-shm'), journal: fs.existsSync(p + '-journal'),
  });
  [p, p + '-wal', p + '-shm', p + '-journal'].forEach(clean);
} catch (e) {
  rec('sqlite', 'unavailable: ' + e.message);
}

// 7. what one handoff actually costs (152 MiB of bytes) ----------------------
{
  const src = path.join(LAB, 'big.src'), dst = path.join(LAB, 'big.dst');
  const buf = crypto.randomBytes(1 << 20);
  const fd = fs.openSync(src, 'w');
  for (let i = 0; i < 152; i++) fs.writeSync(fd, buf);
  fs.fsyncSync(fd); fs.closeSync(fd);

  let t0 = process.hrtime.bigint();
  const data = fs.readFileSync(src);
  const readMs = Number(process.hrtime.bigint() - t0) / 1e6;

  t0 = process.hrtime.bigint();
  fs.writeFileSync(dst, data);
  const wfd = fs.openSync(dst, 'r+'); fs.fsyncSync(wfd); fs.closeSync(wfd);
  const writeMs = Number(process.hrtime.bigint() - t0) / 1e6;

  t0 = process.hrtime.bigint();
  const h1 = crypto.createHash('sha256').update(fs.readFileSync(dst)).digest('hex');
  const hashMs = Number(process.hrtime.bigint() - t0) / 1e6;

  rec('handoff_152MiB', {
    read_ms: Math.round(readMs), write_fsync_ms: Math.round(writeMs), hash_ms: Math.round(hashMs),
    total_ms: Math.round(readMs + writeMs + hashMs),
    write_verified: crypto.createHash('sha256').update(data).digest('hex') === h1,
  });
  clean(src); clean(dst);
}

// 8. allocation unit --------------------------------------------------------
{
  const f = path.join(LAB, 'one-byte.bin');
  fs.writeFileSync(f, 'x');
  const st = fs.statSync(f, { bigint: true });
  const allocated = st.blocks ? Number(st.blocks * 512n) : null;
  rec('one_byte_file_allocated_bytes', allocated);
  fs.rmSync(f, { force: true });
}

if (!KEEP) clean(LAB);
const json = JSON.stringify(out, null, 2);
fs.writeFileSync('exfat-probe-result.json', json);
console.log('\n--- JSON (also written to ./exfat-probe-result.json) ---');
console.log(json);
