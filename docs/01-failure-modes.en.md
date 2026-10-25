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

### A2 Permissions are fake [measured: Windows + macOS]
On Windows: `chmod 0600` results in `mode = 666`.
On macOS: mode is **frozen at `0o700`** — `chmod 600` / `777` / `000` change nothing and raise no error, and the file is still readable after `chmod 000`. **chmod is a complete no-op**, because the mount carries `noowners`. Anything on that volume can be read and written by any account that can log in to the machine.

**There is no way to put permissions on a single file on exFAT.** Either make the whole volume encrypted (VeraCrypt / BitLocker To Go — check macOS can still read it), or accept it.

> ⚠️ **On macOS this trap disguises itself as "permissions work".** The probe's `permissions_enforced` test asks whether `mode & 0o077 === 0`, and macOS reports 0700 unconditionally, so it answered `true` on macOS. To decide whether permissions are enforced, test whether mode *changes* after chmod and whether the file is still readable after `chmod 000` — never judge by the absolute mode value.

### A3 Timestamp granularity: 2 seconds on Windows, 10 milliseconds on macOS [measured]
One volume, one exFAT specification, and the two drivers differ by **200×**:

| Side | Granularity | How it was measured |
|---|---|---|
| Windows | **2.000 s** | 20 writes within 5 s produced 4 distinct mtimes |
| macOS | **10 ms** | 200 consecutive rewrites produced 78 distinct mtimes, positive steps always exactly 10.000 ms (min = median = max) |
| APFS (same machine) | sub-millisecond | 200 rewrites, 200 distinct values |

10 ms is precisely the unit exFAT reserves for mtime, so **macOS follows the specification and the 2 seconds are a Windows driver artifact** — do not read it as "that is just how exFAT is".

[inferred, not cross-checked on this machine] Worse is the semantics: FAT/exFAT timestamps are **local time** fields, Windows writes them in local time, macOS mostly interprets them as UTC. Across dual boot the same file can show an mtime hours apart, and a DST change shifts the difference.

**Conclusion: mtime is unusable for both jobs** — it can neither order files nor tell you whether one changed. With a 200× spread between the two sides, "unchanged here" may simply mean "just written there".

### A4 Case-insensitive [measured]
`CaseProbe.TXT` and `caseprobe.txt` are **the same file**. Writing the lower-case name overwrites the upper-case one and both names remain.

Any logic that keeps case-varied copies, dedupes by normalised path, or validates path spelling is wrong on this volume.

### A5 Symlinks: no on Windows, yes on macOS; hard links: no on both [measured: Windows + macOS]
Windows: `fs.symlinkSync` / `fs.linkSync` both fail, `EISDIR`, `errno = -4068`.
macOS: **symlinks work** — absolute and relative both create, `readlink` round-trips, the link follows and reads the right content, `lstat` reports `Symbolic Link`, and there is **no `._*` companion file** (the driver represents it directly). **Hard links fail**, `ENOTSUP`, `errno = -45`.

So "the volume cannot host a `current → gen0007.db` pointer layout" is **true only on Windows**. macOS can, but then the two sides' layouts diverge: Windows cannot create one.

> Distinguish this from links that *point into* exFAT: those work on both sides (on Windows it is `mklink`). This machine's `~/.dsh/memory` is exactly such a link, pointing at the library directory on the shared volume.
>
> ⚠️ **UNVERIFIED**: whether Windows can read a symlink that macOS created inside the exFAT volume. exFAT has no representation for symlinks; the macOS driver extends it. A Windows driver most likely sees an ordinary file, or errors out. **Do not build the protocol's layout on it.**

Publishing therefore still has to be built on `rename`.

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

### B5 ~~An anomaly (unexplained)~~ Explained: it is V8's GC, not the volume [measured]
> Correction: an earlier version of this section recorded "50 commits / 8192-byte main file". `lab/crash-probe.mjs` actually performs **500** commits and leaves a **16,384-byte** main file. The numbers are corrected here; the observation was real, only its cause was wrong.

Original record: a child process committed 500 times in WAL mode, never closed, then got `SIGKILL`ed — and there was **no `-wal` on disk**, yet another process read 500 rows, `integrity_check` = ok, `journal_mode` still `wal`. The suspects were `node:sqlite` connection flags and this volume's write cache.

**Actual cause: `node:sqlite` closes its connection when the `DatabaseSync` object is garbage-collected.** That child wrote its signal file and then spun in a busy loop, never referencing the handle again; it became unreachable, was collected, and the connection closed. For SQLite, the last connection closing is **a clean close**: checkpoint the WAL into the main file, then delete `-wal`/`-shm`. The parent sampled exactly that post-close state, so it looked like the volume was swallowing WAL frames.

[`lab/b5-gc.mjs`](../lab/b5-gc.mjs) is a one-command A/B/C (`node lab/b5-gc.mjs <dir>`):

| Variant | exFAT | APFS |
|---|---|---|
| A: `h` never referenced again (original) | `-wal` gone **3/3** | gone **2/2** |
| B: one extra line, `globalThis.__keep = h` | gone **0/3** | gone **0/2** |
| C: explicit `h.close()` | gone 3/3, end state identical to A | same |

The only variable is whether the JS handle is still referenced. Filesystem, `journal_mode`, `synchronous` and explicit transactions were each ruled out separately (in every such combination `-wal` stayed at 2,080,632 B and the main file at 4,096 B); APFS behaves identically, so both "volume write cache" and "connection flags" are dead.

Two consequences: **no data was lost** (GC triggers a clean close; all 500 rows are in the main file — the danger is the inference, not the data); and **a live process does not mean a live database** (a process can close its database without exiting: `ps` still shows `R`, while at that instant `lsof` shows not a single `state.db`).

**The conclusion is harder than before: never treat "is there a `-wal`", "`-wal` size" or "main file size" as evidence of anything, and never infer "the database is still open" from "the process is still running".** Test liveness with `lsof +D <dir>` (verified on macOS/exFAT: it names the holder of `state.db` / `state.db-wal`), not with `kill -0`. Trust only hashes you computed, integrity checks you ran, and receipts you wrote.

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
| D6 | "keep whichever was modified last" | see A3: 2 s (Windows) / 10 ms (macOS) granularity, cross-system offset — that judgement is luck |

---

## Unverified list (the honest boundary)

I have **not** tested the following, either because I lack the environment or because it would genuinely destroy the only database I have. Items since measured on macOS are marked in place:

1. **Crash / repair behaviour on macOS**: how the exFAT driver unmounts after a hard shutdown, what `fsck_exfat` actually "repairs", whether `.Spotlight-V100` / `.fseventsd` touch the database file while the app is writing. → Within this same item, **`lsof`-based liveness is now measured and reliable** (`lsof +D <dir>` accurately lists the holder of `state.db` / `state.db-wal`), and these probes produced no `._*` companion files on the volume.
2. **A real power loss / really yanking the disk**: every "crash" conclusion here comes from `SIGKILL`. A kill only affects **file content**; a power loss also affects **filesystem structure** — and structure is exactly where exFAT has no journal. **Read this document as "the worst case is worse than what is written here".**
3. **Behaviour when the exFAT volume fills up** (does it fail atomically, does it leave half a file).
4. **Large databases after long runtimes** (everything here was measured at 145–148 MB).
5. ~~**The cause of the B5 anomaly.**~~ → **Explained**; see B5: V8 GC collects the `DatabaseSync` handle and the connection is closed.
6. **The cross-system mtime semantics difference** (the inferred half of A3). → Granularity is now measured (Windows 2 s / macOS 10 ms / APFS sub-millisecond); **the semantics (local time vs UTC interpretation) remain unverified**.
7. **Whether Windows can read a symlink macOS created on exFAT** (see A5) — newly added.
8. **Opening a WAL database read-only inside a non-writable directory**: on macOS this fails with `unable to open database file (14)` (no `-shm` can be created), and `?immutable=1` opens it but ignores the WAL. Documented in [`03`](03-recovery-runbook.en.md), but the harsher case of a read-only *mount* is untested.

If you measure any of these on the macOS side, please open an issue — it is the part this document is most missing.
