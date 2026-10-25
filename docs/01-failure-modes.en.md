# 🔥 01 · Failure-mode inventory

Grouped by **which layer breaks**. Every entry is tagged **[measured]** or **[inferred]** — I don't want guesses dressed up as conclusions.

<p>
  <a href="01-failure-modes.en.md"><img alt="English" src="https://img.shields.io/badge/English-2f81f7?style=flat-square&amp;logo=googletranslate&amp;logoColor=white"></a>
  <a href="01-failure-modes.md"><img alt="中文" src="https://img.shields.io/badge/%E4%B8%AD%E6%96%87-30363d?style=flat-square&amp;logo=googletranslate&amp;logoColor=white"></a>
</p>

---

## A. Filesystem layer (exFAT itself)

### A1 No journal, and damage is **volume-level** [measured·partly]
FAT/exFAT updates directory entries and cluster chains non-transactionally. Cut the power or yank the disk and exFAT may leave behind:

- a filename that exists with 0-byte content;
- a file of plausible size whose cluster chain points at the wrong clusters (so the content becomes someone else's data, or a long run of `0xFF`);
- a half-written directory entry (mangled filename).

On the next mount, macOS runs `fsck_exfat`, and it **"repairs" by itself** — usually by discarding cluster chains it considers inconsistent. Which means: **the filesystem may already have changed your database before you ever opened it.**

This is fundamentally different from NTFS/APFS with a journal: there, the worst case after a crash is rolling back to the last transaction; here, the worst case is the file structure itself being broken.

### A2 Permissions are fake [measured]
`chmod 0600` results in `mode = 666`. Anything on that volume can be read and written by any account that can log in to the machine.

**There is no way to put permissions on a single file on exFAT.** Either make the whole volume encrypted (VeraCrypt / BitLocker To Go — check macOS can still read it), or accept it.

### A3 Timestamp granularity is 2 seconds, and incomparable across systems [measured + inferred]
Measured: 20 writes within 5 seconds produced **4** distinct mtimes; the smallest step was **2.000 s**.

[inferred, not cross-checked on this machine] Worse is the semantics: FAT/exFAT timestamps are **local time** fields, Windows writes them in local time, macOS mostly interprets them as UTC. Across dual boot the same file can show an mtime hours apart, and a DST change shifts the difference.

**Conclusion: mtime is unusable for both jobs** — it can neither order files nor tell you whether one changed.

### A4 Case-insensitive [measured]
`CaseProbe.TXT` and `caseprobe.txt` are **the same file**. Writing the lower-case name overwrites the upper-case one and both names remain.

Any logic that keeps case-varied copies, dedupes by normalised path, or validates path spelling is wrong on this volume.

### A5 No symlinks, no hard links [measured]
`fs.symlinkSync` and `fs.linkSync` both fail: `EISDIR`, `errno = -4068`.

So **there is no `current → gen0007.db` pointer layout inside the volume.** Either atomically replace by `rename`, or copy. That is why every "publish" step in the protocol is built on `rename`.

> Keep the distinction clear: **a symlink from NTFS pointing into exFAT works fine** (that is what the usual `mklink` setup does). What is unsupported is creating a link *inside* an exFAT volume.

### A6 Allocation unit is 128 KiB [measured]
A 1-byte file occupies 131,072 bytes. That is the default large cluster on a few-hundred-GB volume.

**Consequence**: do not design anything that "stores a pile of small files per handoff" on this disk. A snapshot should be one large file (fine), or it should not exist.

### A7 Hidden junk from both sides [measured]
macOS writes `.Spotlight-V100`, `.fseventsd`, `.TemporaryItems`, `.Trashes` at the volume root, plus `._filename` companions for files with extended attributes; Windows writes `System Volume Information`, `$RECYCLE.BIN`, and sometimes `msdownld.tmp`. On the root of this machine's shared volume, **all of them are present**.

**Consequence**: any logic that "walks the directory and treats every file as data" will step on them; backup and hashing tools must exclude them explicitly.

---

## B. SQLite layer

### B1 Locks do not survive a boot; they only span processes [measured + inferred]
Measured: on exFAT, while one process holds `BEGIN IMMEDIATE`, another process gets `database is locked` in both `delete` and `wal` modes. **The locking works.**

But locks are **in-memory state** (implemented with OS file locks). A lock left unreleased when OS A is force-shut-down **does not exist at all** as far as OS B is concerned — the lock table was in A's memory and died with the power.

Therefore:

- within one system, the app's SQLite lock prevents double writers ✔
- across systems / across boots, **only a persistent dirty marker works** — not locks

### B2 The WAL is extra state that must be moved with the database [measured]
`-wal` holds **transactions not yet merged into the main file**. Hot-copy the main file and ignore `-wal` and you get "the view before the WAL".

Measured: a main file of a few hundred MB had a **multi-MB `-wal`** next to it.

- on a clean close SQLite checkpoints and deletes `-wal`/`-shm` by itself (measured: neither file exists afterwards)
- on a crash or a kill it **does not** (see the anomaly recorded under B5 for what the scene looks like after a kill)

**Rule: the first step of any handoff is `PRAGMA wal_checkpoint(TRUNCATE)`, then confirming `-wal` is really 0 bytes or absent.**

### B3 A leftover `-journal` may fail to roll back [inferred]
Under `journal_mode=delete`, a crash leaves a `-journal`, and SQLite rolls back from it on the next open. But if that `-journal` was itself truncated or half-written during the crash, the rollback can fail — the classic error being `database disk image is malformed`.

This is why "force a TRUNCATE and a physical before handoff" beats "hope it self-heals next time": **keep the uncertainty in this session, do not hand it to the next boot.**

### B4 `integrity_check` passing ≠ the data is intact [inferred, but important]
`integrity_check` verifies **page structure and index consistency**. It has no idea that "the 300 memories from yesterday are supposed to still be there".

Main database pages carry **no checksums** (only WAL frames do). A single page can be corrupted and give no sign until something reads that page.

So a physical only proves "the structure is intact", never "nothing was lost". Proving the latter needs:

- a **content digest** recorded at every handoff (row counts, max generation/timestamp per key table);
- or a full `integrity_check` plus sampled reads on a schedule;
- and **keeping the previous snapshot**, so that "a batch went missing" is at least comparable by hand.

### B5 An anomaly (unexplained, recorded as-is) [measured]
A child process committed 50 times in WAL mode, never closed, then got `SIGKILL`ed:

```json
{ "db": 8192, "-wal": null, "-shm": null }
```

There is **no `-wal` on disk**, yet another process opening the database reads **50 rows**, `integrity_check` = ok, `journal_mode` still reports `wal`.

Run from the parent process, the same operations do leave a `-wal` (12,392 bytes). Reproduced twice.

No explanation (suspected to be `node:sqlite`'s VFS / connection flags, or this volume's write-cache behaviour).

**The conclusion does not depend on the explanation, and it strengthens the design: never use "is there a `-wal`" or "how big is `-wal`" as evidence of anything.** Trust only hashes you computed, integrity checks you ran, and receipts you wrote.

---

## C. Timing layer (this is the one that hurts)

### C1 Stale trust: the next side believes the previous side unconditionally [design issue]
The two systems never run together, so **there is no data divergence**. There is exactly one way to get this wrong: **side B opens a file that side A never sealed properly, and writes on top of it.** Once is enough.

That is the entire reason `DIRTY` exists.

### C2 Rollback is silent data deletion [design issue]
"Roll back to the last good snapshot" sounds safe, but it **throws away new data**. It must satisfy:

- the current database is **renamed and kept** before rolling back (`state.db.abandoned-<time>`), never deleted;
- the rollback is logged, and **the next boot tells the user "I rolled back, and the old data is in this file"**;
- `gen` never goes backwards because of a rollback (a rollback also `+1`s it and sets `rollback: true`), otherwise generations stop being monotonic.

### C3 The application never exited [measured experience]
On Windows, when a file is held by a handle, many operations fail in **strange ways** (not a clean `EBUSY`). The classic accident: "I thought it had exited, but a tray process was still there and two processes were writing the same database."

Liveness must be **checked**, and the check must be "can I open this file exclusively", not "it doesn't appear in Task Manager".

### C4 Volume not mounted / mounted somewhere else [common]
Across dual boot the shared volume's drive letter / mount point differs, and may change when enumeration order changes. The protocol must **identify the volume by serial number or UUID**, never by letter or path.

---

## D. Human layer

| # | Accident | Consequence |
|---|---|---|
| D1 | keep a "working copy" on each side and merge | needs real conflict resolution; one wrong merge step loses a batch |
| D2 | manual copy that forgets `-wal` | silently loses the last transactions |
| D3 | volume fills up / copy interrupted halfway | half a file passes as a complete database; on exFAT a failure does not necessarily delete the target |
| D4 | commit the database to git | privacy leak + huge repo; and git merge is meaningless for this file |
| D5 | different app versions on the two sides | schema migrations are usually one-way; going back breaks things |
| D6 | "keep whichever was modified last" | see A3: 2-second granularity, cross-system offset — that judgement is luck |

---

## Unverified list (the honest boundary)

I have **not** tested the following, either because there is no macOS environment here, or because it would genuinely destroy the only database I have:

1. **Anything on the macOS side**: how the exFAT driver (kext) unmounts after a hard shutdown, what `fsck_exfat` actually "repairs", whether `.Spotlight-V100` / `.fseventsd` touch the database file while the app is writing, whether `lsof`-based liveness checks are reliable.
2. **A real power loss / really yanking the disk**: every "crash" conclusion here comes from `SIGKILL`. A kill only affects **file content**; a power loss also affects **filesystem structure** — and structure is exactly where exFAT has no journal. **Read this document as "the worst case is worse than what is written here".**
3. **Behaviour when the exFAT volume fills up** (does it fail atomically, does it leave half a file).
4. **Large databases after long runtimes** (everything here was measured at 145 MB).
5. **The cause of the B5 anomaly.**
6. **The cross-system mtime semantics difference** (the inferred half of A3).

If you measure any of these on the macOS side, please open an issue — it is the part this document is most missing.
