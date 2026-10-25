#!/usr/bin/env node
// handoff.mjs — reference implementation of the handoff protocol (docs/02-handoff-protocol.md).
//
//   node handoff.mjs status  /Volumes/Shared/mneme
//   node handoff.mjs open    /Volumes/Shared/mneme --owner macos     # 0 = safe to start the app
//   node handoff.mjs close   /Volumes/Shared/mneme --owner macos     # seal before shutdown
//   node handoff.mjs recover /Volumes/Shared/mneme --owner windows   # only after a suspected bad handoff
//
// Zero dependencies. Node >= 22 (uses the built-in node:sqlite).
// The directory it manages is any app data directory that holds ONE sqlite database
// plus whatever else the app keeps there. Nothing outside it is touched.
//
// Exit codes
//   0  ok / safe
//   10 dirty: the last session did not close cleanly → run recover
//   11 content hash does not match the receipt
//   12 integrity_check failed
//   13 no receipt (first run) → run `close` once to establish a baseline
//   14 receipt was written by a newer protocol version
//   20 refused: something still holds the database
//   21 refused: checkpoint left data in the WAL
//   22 rollback needed but no usable snapshot
//   30 bad usage

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const PROTOCOL = 1;
const EXIT = {
  ok: 0, dirty: 10, hash: 11, integrity: 12, noreceipt: 13, version: 14,
  busy: 20, wal: 21, nosnap: 22, usage: 30,
};

// ---------------------------------------------------------------- helpers ---
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const sha256File = (p) => sha256(fs.readFileSync(p));
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '');
const exists = (p) => { try { fs.statSync(p); return true; } catch { return false; } };
const sizeOf = (p) => (exists(p) ? fs.statSync(p).size : null);

const say = (s) => console.log(s);
const ok = (s) => console.log('  ✓ ' + s);
const warn = (s) => console.log('  ! ' + s);
const bad = (code, s) => { console.error('  ✗ ' + s); process.exit(code); };

// write tmp -> fsync -> rename over the target. The protocol depends on this
// being atomic, and overwrite-rename is the one primitive that works on exFAT.
function atomicWrite(file, text) {
  const tmp = file + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  try { fs.writeSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}

function meta(dir) { return path.join(dir, '.handoff'); }
function receiptPath(dir) { return path.join(meta(dir), 'handoff.json'); }
function dirtyPath(dir) { return path.join(meta(dir), 'DIRTY'); }
function snapDir(dir) { return path.join(meta(dir), 'snapshots'); }

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// ------------------------------------------------------------------ files ---
// Everything in the data directory except the database and its transient
// sidecars is content we must be able to prove unchanged. Markdown mirrors in
// particular are editable by humans, so a stale copy is a real hazard.
const TRANSIENT = /(^|\/)[^/]*\.db(-wal|-shm|-journal)$/;
const JUNK = /(^|\/)(\._|\.DS_Store$|Thumbs\.db$)/;

function manifest(dir, dbName) {
  const skipDir = path.basename(meta(dir));
  const entries = [];
  const walk = (abs, rel) => {
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (JUNK.test(r)) continue;
      if (!rel && e.name === skipDir) continue;
      const p = path.join(abs, e.name);
      if (e.isDirectory()) { walk(p, r); continue; }
      if (!e.isFile()) continue;
      if (r === dbName) continue;                 // covered by db.sha256
      if (TRANSIENT.test(r)) continue;            // covered by the checkpoint step
      entries.push({ path: r, bytes: fs.statSync(p).size, sha256: sha256File(p) });
    }
  };
  walk(dir, '');
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return entries;
}

const manifestDigest = (entries) => sha256(JSON.stringify(entries));

function lastGen(dir) {
  const rec = readJson(receiptPath(dir));
  return typeof rec?.gen === 'number' ? rec.gen : 0;
}

// ---------------------------------------------------------------- sqlite ----
async function sqlite() {
  try { return await import('node:sqlite'); }
  catch { bad(EXIT.usage, 'node:sqlite unavailable — need Node >= 22'); }
}

async function check(dbPath, pragma) {
  const { DatabaseSync } = await sqlite();
  const db = new DatabaseSync(dbPath);
  try { return db.prepare(`PRAGMA ${pragma}`).get(); } finally { db.close(); }
}

// ---------------------------------------------------------------- commands ---

async function status(dir, dbName) {
  say(`dir      ${dir}`);
  const dbPath = path.join(dir, dbName);
  if (!exists(dbPath)) bad(EXIT.usage, `${dbName} not found in ${dir}`);
  const st = fs.statSync(dbPath);
  say(`database ${dbName}  ${st.size} B`);
  const wal = sizeOf(dbPath + '-wal'), shm = sizeOf(dbPath + '-shm');
  say(`sidecars -wal ${wal ?? 'absent'}   -shm ${shm ?? 'absent'}`);

  const dirty = readJson(dirtyPath(dir)) ?? (exists(dirtyPath(dir)) ? {} : null);
  say(`DIRTY    ${exists(dirtyPath(dir)) ? 'present → last session did not close cleanly' : 'absent'}`);
  if (dirty && dirty.owner) say(`         owner=${dirty.owner} gen=${dirty.gen} since=${dirty.opened_at}`);

  const rec = readJson(receiptPath(dir));
  if (!rec) { warn('no receipt yet — first run will need one `close`'); return; }
  say(`receipt  gen=${rec.gen} owner=${rec.owner} closed_at=${rec.closed_at}${rec.rollback ? ' ROLLBACK' : ''}`);

  const now = sha256File(dbPath);
  if (now === rec.db?.sha256) ok('database hash matches the receipt');
  else warn(`database hash differs from the receipt\n         receipt ${rec.db?.sha256}\n         actual  ${now}`);

  const man = manifestDigest(manifest(dir, dbName));
  if (rec.files_digest && man === rec.files_digest) ok('directory contents match the receipt');
  else if (rec.files_digest) warn('directory contents differ from the receipt (files edited outside the app?)');

  const snaps = exists(snapDir(dir))
    ? fs.readdirSync(snapDir(dir)).filter((f) => f.endsWith('.db')).sort().reverse()
    : [];
  say(`snapshots ${snaps.length ? snaps.slice(0, 2).join(', ') : 'none'}`);
}

async function open(dir, owner, dbName) {
  const dbPath = path.join(dir, dbName);
  if (!exists(dbPath)) bad(EXIT.usage, `${dbName} not found in ${dir}`);
  fs.mkdirSync(meta(dir), { recursive: true });

  if (exists(dirtyPath(dir))) {
    const d = readJson(dirtyPath(dir));
    bad(EXIT.dirty, `DIRTY present (owner=${d?.owner ?? '?'} gen=${d?.gen ?? '?'}) — the last session did not close cleanly. Run: handoff.mjs recover ${dir}`);
  }
  const rec = readJson(receiptPath(dir));
  if (!rec) bad(EXIT.noreceipt, 'no receipt — establish a baseline first: handoff.mjs close (with the app stopped)');
  if ((rec.protocol ?? 0) > PROTOCOL) {
    bad(EXIT.version, `receipt uses protocol ${rec.protocol}, this tool speaks ${PROTOCOL} — do not let an older hand write over a newer one`);
  }

  const now = sha256File(dbPath);
  if (now !== rec.db?.sha256) {
    bad(EXIT.hash, `database changed outside a clean handoff\n    receipt ${rec.db?.sha256}\n    actual  ${now}\n  This is what a crash, a rollback by hand, or a second writer looks like. Run: handoff.mjs recover ${dir}`);
  }
  const man = manifestDigest(manifest(dir, dbName));
  if (rec.files_digest && man !== rec.files_digest) {
    warn('directory contents differ from the receipt (mirrors may have been edited outside the app) — continuing, but see docs/02 §6');
  }

  const qc = await check(dbPath, 'quick_check');
  if (qc.quick_check !== 'ok') bad(EXIT.integrity, `quick_check: ${qc.quick_check}`);

  // Write the dirty marker BEFORE the app is allowed to open the database.
  // That ordering is the whole point: a crash between here and the next
  // `close` must be visible to the next boot.
  atomicWrite(dirtyPath(dir), JSON.stringify({
    protocol: PROTOCOL, owner, gen: (rec.gen ?? 0) + 1, opened_at: new Date().toISOString(), pid: process.pid,
  }, null, 2) + '\n');
  ok(`verified: hash, directory contents, quick_check. DIRTY written — you may start the app.`);
  say(`  (when the app has exited, run: handoff.mjs close ${dir} --owner ${owner})`);
}

async function close(dir, owner, dbName) {
  const dbPath = path.join(dir, dbName);
  if (!exists(dbPath)) bad(EXIT.usage, `${dbName} not found in ${dir}`);
  fs.mkdirSync(meta(dir), { recursive: true });

  const { DatabaseSync } = await sqlite();
  const db = new DatabaseSync(dbPath);
  let ck;
  try {
    // Prove nobody else is writing: a write lock that cannot be taken means
    // the app (or a leftover daemon) still holds the database.
    try { db.exec('BEGIN IMMEDIATE'); db.exec('ROLLBACK'); }
    catch (e) { bad(EXIT.busy, `cannot take a write lock — something still holds ${dbName} (${e.message}). Stop the app (including tray/menubar processes) and retry.`); }

    ck = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    if (ck.busy !== 0) bad(EXIT.busy, `wal_checkpoint reported busy=${ck.busy} — readers/writers still attached`);
    if ((sizeOf(dbPath + '-wal') ?? 0) !== 0) bad(EXIT.wal, `-wal is still ${sizeOf(dbPath + '-wal')} bytes after TRUNCATE — refusing to seal`);

    const ic = db.prepare('PRAGMA integrity_check').get().integrity_check;
    if (ic !== 'ok') {
      db.close();
      const abandoned = path.join(meta(dir), 'abandoned', `${dbName}.${stamp()}`);
      fs.mkdirSync(path.dirname(abandoned), { recursive: true });
      fs.renameSync(dbPath, abandoned);
      bad(EXIT.integrity, `integrity_check failed: ${String(ic).split('\n')[0]}\n    moved aside (not deleted): ${abandoned}\n    now run: handoff.mjs recover ${dir}`);
    }
  } finally {
    try { db.close(); } catch {}
  }

  const gen = lastGen(dir) + 1;
  const snapDirAbs = snapDir(dir);
  fs.mkdirSync(snapDirAbs, { recursive: true });
  const snap = path.join(snapDirAbs, `gen${String(gen).padStart(4, '0')}.db`);

  // copy, then read the copy back — a successful write is not a successful
  // write on this class of filesystem.
  fs.copyFileSync(dbPath, snap);
  const srcHash = sha256File(dbPath);
  const snapHash = sha256File(snap);
  if (srcHash !== snapHash) bad(EXIT.hash, `snapshot readback mismatch (wrote ${snapHash}, expected ${srcHash}) — the volume is not writing what it says`);
  atomicWrite(path.join(snapDirAbs, `gen${String(gen).padStart(4, '0')}.sha256`), `${snapHash}  ${path.basename(snap)}\n`);

  const files = manifest(dir, dbName);
  const rec = {
    protocol: PROTOCOL,
    gen,
    owner,
    closed_at: new Date().toISOString(),
    rollback: false,
    db: { file: dbName, bytes: fs.statSync(dbPath).size, sha256: srcHash },
    sqlite: { integrity_check: 'ok', checkpoint: 'truncate', wal_bytes_at_close: 0, ...(ck ? { checkpoint_result: ck } : {}) },
    files_digest: manifestDigest(files),
    files,
  };
  atomicWrite(receiptPath(dir), JSON.stringify(rec, null, 2) + '\n');

  if (exists(dirtyPath(dir))) fs.unlinkSync(dirtyPath(dir));   // the seal — always last

  // keep two generations, no more: small files are expensive here.
  const snaps = fs.readdirSync(snapDirAbs).filter((f) => f.endsWith('.db')).sort();
  for (const f of snaps.slice(0, Math.max(0, snaps.length - 2))) {
    fs.rmSync(path.join(snapDirAbs, f), { force: true });
    fs.rmSync(path.join(snapDirAbs, f.replace(/\.db$/, '.sha256')), { force: true });
  }

  ok(`sealed gen ${gen}: ${rec.db.bytes} B, sha256 ${srcHash.slice(0, 16)}…, ${files.length} file(s) hashed`);
  say(`  snapshot: ${snap}`);
}

async function recover(dir, owner, dbName) {
  const dbPath = path.join(dir, dbName);
  const gen = lastGen(dir) + 1;

  say(`recovering ${dir} (next gen = ${gen})`);

  // A missing database is not a usage error here: `close` moves a corrupt one
  // into .handoff/abandoned/ and then hands over to recover.
  let integrity = null;
  if (!exists(dbPath)) integrity = 'database file is missing';
  else {
    try {
      integrity = (await check(dbPath, 'integrity_check')).integrity_check;
    } catch (e) {
      integrity = 'open failed: ' + e.message;
    }
  }

  if (integrity === 'ok') {
    ok('integrity_check: ok — keeping the current database (it holds the newest data)');
    const files = manifest(dir, dbName);
    const snapDirAbs = snapDir(dir);
    fs.mkdirSync(snapDirAbs, { recursive: true });
    const snap = path.join(snapDirAbs, `gen${String(gen).padStart(4, '0')}.db`);
    fs.copyFileSync(dbPath, snap);
    const h = sha256File(dbPath);
    if (sha256File(snap) !== h) bad(EXIT.hash, 'snapshot readback mismatch');
    atomicWrite(path.join(snapDirAbs, `gen${String(gen).padStart(4, '0')}.sha256`), `${h}  ${path.basename(snap)}\n`);
    atomicWrite(receiptPath(dir), JSON.stringify({
      protocol: PROTOCOL, gen, owner, closed_at: new Date().toISOString(), rollback: false, recovered: true,
      note: 'previous session did not close cleanly; integrity verified, data kept',
      db: { file: dbName, bytes: fs.statSync(dbPath).size, sha256: h },
      files_digest: manifestDigest(files), files,
    }, null, 2) + '\n');
    if (exists(dirtyPath(dir))) fs.unlinkSync(dirtyPath(dir));
    ok('sealed. no data was lost.');
    return;
  }

  warn(`integrity_check failed: ${String(integrity).split('\n')[0]}`);
  const snapDirAbs = snapDir(dir);
  const snaps = exists(snapDirAbs)
    ? fs.readdirSync(snapDirAbs).filter((f) => f.endsWith('.db')).sort().reverse()
    : [];
  if (!snaps.length) bad(EXIT.nosnap, 'no snapshot to roll back to — see docs/03-recovery-runbook.md §5 before touching anything else');

  for (const f of snaps) {
    const p = path.join(snapDirAbs, f);
    const expected = (() => { try { return fs.readFileSync(path.join(snapDirAbs, f.replace(/\.db$/, '.sha256')), 'utf8').split(/\s+/)[0]; } catch { return null; } })();
    if (expected && sha256File(p) !== expected) { warn(`${f}: checksum file does not match, skipping`); continue; }
    let ic;
    try { ic = (await check(p, 'integrity_check')).integrity_check; } catch (e) { ic = 'open failed'; }
    if (ic !== 'ok') { warn(`${f}: ${String(ic).split('\n')[0]}`); continue; }

    const abandoned = path.join(meta(dir), 'abandoned', `${dbName}.${stamp()}`);
    fs.mkdirSync(path.dirname(abandoned), { recursive: true });
    if (exists(dbPath)) fs.renameSync(dbPath, abandoned);    // keep it: rollback deletes data otherwise
    else fs.writeFileSync(abandoned + '.missing', `database was already absent when recover ran\n`);
    fs.rmSync(dbPath + '-wal', { force: true });
    fs.rmSync(dbPath + '-shm', { force: true });
    fs.copyFileSync(p, dbPath);
    const h = sha256File(dbPath);
    if (h !== sha256File(p)) bad(EXIT.hash, 'rollback copy readback mismatch');

    const files = manifest(dir, dbName);
    atomicWrite(receiptPath(dir), JSON.stringify({
      protocol: PROTOCOL, gen, owner, closed_at: new Date().toISOString(), rollback: true,
      rolled_back_to: f, abandoned_as: path.relative(dir, abandoned),
      db: { file: dbName, bytes: fs.statSync(dbPath).size, sha256: h },
      files_digest: manifestDigest(files), files,
    }, null, 2) + '\n');
    if (exists(dirtyPath(dir))) fs.unlinkSync(dirtyPath(dir));

    ok(`rolled back to ${f}; sealed as gen ${gen}`);
    say(`  ⚠ the database that was in place is NOT deleted: ${abandoned}`);
    say(`  ⚠ anything written between ${f} and now must be recovered by hand (docs/03 §4)`);
    return;
  }
  bad(EXIT.nosnap, 'no snapshot passed integrity_check — stop here and read docs/03-recovery-runbook.md §5');
}

// -------------------------------------------------------------------- cli ---
const [cmd, dirArg, ...rest] = process.argv.slice(2);
if (!cmd || !dirArg || ['-h', '--help', 'help'].includes(cmd)) {
  console.log(`handoff.mjs — verify and seal one database on a shared volume

  node handoff.mjs status  <dir> [--db memory.db]
  node handoff.mjs open    <dir> [--db memory.db] [--owner windows|macos]
  node handoff.mjs close   <dir> [--db memory.db] [--owner windows|macos]
  node handoff.mjs recover <dir> [--db memory.db] [--owner windows|macos]

  exit codes: 0 ok, 10 dirty, 11 hash, 12 integrity, 13 no receipt,
              14 protocol, 20 busy, 21 wal, 22 no snapshot, 30 usage`);
  process.exit(cmd ? 0 : EXIT.usage);
}
const arg = (name, dflt) => {
  const i = rest.indexOf('--' + name);
  return i >= 0 && rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[i + 1] : dflt;
};
const dir = path.resolve(dirArg);
const dbName = arg('db', 'memory.db');
const owner = arg('owner', process.platform === 'darwin' ? 'macos' : 'windows');

if (!exists(dir)) bad(EXIT.usage, `no such directory: ${dir}`);
if (!fs.statSync(dir).isDirectory()) bad(EXIT.usage, `not a directory: ${dir}`);

switch (cmd) {
  case 'status': await status(dir, dbName); break;
  case 'open': await open(dir, owner, dbName); break;
  case 'close': await close(dir, owner, dbName); break;
  case 'recover': await recover(dir, owner, dbName); break;
  default: bad(EXIT.usage, `unknown command: ${cmd}`);
}
