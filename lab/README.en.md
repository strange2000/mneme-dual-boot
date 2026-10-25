# 🧪 lab/ · Reproducible probes

These three scripts produce every number in the README table and verify the behaviour of `handoff.mjs`. **Run them on your own volume** — my numbers only describe my disk.

```bash
# the directory argument must be a path ON THE SHARED VOLUME; the scripts create and delete their own temp files
node lab/exfat-probe.mjs  /Volumes/Shared/_probe      # macOS
node lab/exfat-probe.mjs  X:\_probe                   # Windows

node lab/crash-probe.mjs  /Volumes/Shared/_probe

node lab/handoff-selftest.mjs /Volumes/Shared/_hstest # 18 assertions, a few seconds
```

Requirement: **Node ≥ 22** (built-in `node:sqlite`, zero dependencies — which is why it was chosen: reproduce it with a bare Node, no `npm i`).

All three stay inside directories they create and clean up on exit (`--keep` keeps them). `exfat-probe.mjs` also writes its result to `./exfat-probe-result.json` (the copy in this directory is the raw output of my run), so you can paste it straight into an issue.

<p>
  <a href="README.en.md"><img alt="English" src="https://img.shields.io/badge/English-2f81f7?style=flat-square&amp;logo=googletranslate&amp;logoColor=white"></a>
  <a href="README.md"><img alt="中文" src="https://img.shields.io/badge/%E4%B8%AD%E6%96%87-30363d?style=flat-square&amp;logo=googletranslate&amp;logoColor=white"></a>
</p>

---

## exfat-probe.mjs — filesystem and SQLite capabilities

| What is measured | Why it matters | My disk |
|---|---|---|
| `mtime_granularity_seconds` | decides whether you can judge recency by timestamp at all | **2.000 s** (20 writes in 5 s → only 4 distinct mtimes) |
| `case_insensitive` / `case_collision` | two "files" differing by case may be one file | `true` / writing the lower-case name overwrites the upper-case one |
| `mode_after_chmod_0600` | can you put permissions on the database | `0o666` (`chmod` silently does nothing) |
| `links` | can you build a symlink/hardlink layout inside the volume | `EISDIR / -4068`, neither works |
| `rename_over_existing` | protocol I3 (atomic receipt write) depends on it | `ok` ✔ |
| `exclusive_create_wx` | lock-file / single-writer primitive | `blocked: EEXIST` ✔ |
| `journal_mode_roundtrip` | which modes can actually be set | delete/truncate/persist/wal all accepted |
| `commit_cost_300_sync_commits` | which mode to pick before a handoff | delete **4.9–5.2 ms**, wal **1.4–1.6 ms** |
| `wal_checkpoint_truncate` | can step 1 of a handoff really empty the WAL | `{busy:0, log:0, checkpointed:0}`, then `-wal` = 0 bytes ✔ |
| `transient_files_after_clean_close` | what is left after a clean close | all gone ✔ |
| `handoff_152MiB` | the real cost of one handoff | read 97–474 + write 221–237 + verify 514–589 ms ≈ **0.9–1.2 s** |
| `one_byte_file_allocated_bytes` | how wasteful small files are | **131,072** (128 KiB clusters) |

## crash-probe.mjs — hot copy and hard kill

It commits 500 rows in WAL mode from a child process, and then — while the child is still alive and has never checkpointed — does two things:

1. **copies only `state.db`** (dropping `-wal`/`-shm`) and counts the rows in that "naive handoff" — the real consequence of "forgetting the `-wal`";
2. **`SIGKILL`s the child** and inspects what is left on disk and whether the next boot can read it.

My output (**note: this contradicts intuition**):

```json
{
  "child_reached_commit": true,
  "state_while_alive":   { "db": 16384, "-wal": null, "-shm": null },
  "naive_copy":          { "rows": 500, "integrity": "ok" },
  "state_after_kill":    { "db": 16384, "-wal": null, "-shm": null },
  "open_after_kill":     { "rows": 500, "integrity": "ok", "journal_mode": "wal" },
  "state_after_reader_close":      { "db": 16384, "-wal": 0, "-shm": 32768 },
  "db_only_copy_after_kill":       { "rows": 500, "integrity": "ok" }
}
```

**How to read it**: 500 rows were committed in WAL mode, the process is still alive, and there is **no `-wal` file on disk at all** — the data is already in the 16 KB main file. Reproduced 3 times.

This does not match the WAL contract and I could not explain it. Two candidates:

- **(a)** an issue with `node:sqlite`'s (Node's built-in driver) connection flags, unrelated to the volume;
- **(b)** this volume's write-cache behaviour makes it *appear* to land directly.

**How to falsify it**: run the same experiment on the same volume with the native `sqlite3` CLI (or Python's `sqlite3`):

```bash
sqlite3 probe.db "pragma journal_mode=wal; create table t(x); insert into t values(1);"
ls -l probe.db*        # after an insert in WAL mode, -wal should exist and be non-empty
```

If `-wal` is present there, it is (a) — please open an issue with both outputs. If it is absent there too, then this volume's behaviour deserves more suspicion than this document already gives it.

**Whatever the answer is, (a) or (b), the protocol does not change**: don't reason about the WAL's state — explicitly `wal_checkpoint(TRUNCATE)`, then hash, then check, then write the receipt.

---

## handoff-selftest.mjs — behavioural verification of the reference implementation

```bash
node lab/handoff-selftest.mjs X:\_hstest
```

It builds a 500-row database under `<dir>/selftest`, then pushes `handoff.mjs` through nine situations, asserting the **exit code** at each step (not "it looked like it worked"):

| # | Situation | Expected |
|---|---|---|
| 2 | first run, no receipt | `status` says "no receipt", `open` = **13**; `close` establishes the baseline |
| 3 | open again without closing | **10** (the dirty marker did its job) |
| 4 | dirty but healthy → recover | **0**, all 500 rows kept (**no rollback**, because the database *is* the newest data) |
| 5 | clean close | **0**, generation +1, 2 snapshots kept |
| 6 | database modified externally | **11** (sha256 mismatch) |
| 7 | page-level corruption → recover | **0**, rolled back to a verified snapshot, 500 rows back, **the bad database renamed and kept** |
| 8 | hand-edited mirror `.md` | `open` still **0**, but warns explicitly |
| 9 | snapshot rotation | always ≤ 2 |

Result on my disk:

```
all good: 18 passed, 0 failed
```

**What it cannot prove**: the data is generated by the script, not your database; it runs on your volume, but it will **not** verify macOS-side behaviour (that needs actually booting into macOS). The real rehearsal is still [../docs/03-recovery-runbook.en.md](../docs/03-recovery-runbook.en.md) §0: archive a copy first, then act.

---

## Notes

- These three scripts **do** create and delete files on the volume. Do not point them at your production directory; point them at an empty one.
- `crash-probe.mjs` `SIGKILL`s a child process it started — do not change it to kill the current process, that would kill you.
- I set `stdio` to `'ignore'` and pass results back through files because some sandboxes forbid inter-process pipes. Pipes are fine in a normal environment, but files are more reliable. Same for `handoff-selftest.mjs` (child output goes to `.selftest-child.log`).
