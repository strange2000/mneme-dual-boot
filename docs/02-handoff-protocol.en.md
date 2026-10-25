# 02 · The handoff protocol, spec v0

> **In one sentence**: verify before you enter, seal before you leave; anything unsealed is not to be trusted.
> **Applies to**: one machine, two operating systems taking turns (mutually exclusive), the data being a single file on a shared volume.
> **Does not apply to**: both sides running at once — that is concurrent writing and needs real conflict resolution, which this protocol does not do.

[中文](02-handoff-protocol.md) ｜ English (this file)

---

## 0. Goals and non-goals

**Goals**

1. On every boot, it must be possible to decide **before opening the app** whether this file can be trusted.
2. On every shutdown, the next boot's decision must be **documented** (the receipt holds the hash).
3. Once the verdict is "not trustworthy", there is a path that **loses no data** (keep the discarded file + roll back to the previous snapshot).
4. Every judgement relies only on **content hashes + a self-incremented generation** — never on timestamps, never on whether `-wal` exists.

**Non-goals**

- No merging of two sides' data (under mutual exclusion there is nothing to merge).
- No concurrent-write protection (within one system that is SQLite's locks; across boots it is `DIRTY`).
- No promise that the exFAT volume itself stays intact (impossible; the protocol can only **discover** damage afterwards).

---

## 1. Directory layout

One self-contained directory on the shared volume:

```
<shared>/state/
├── db/
│   ├── state.db                 # the single source of truth
│   ├── state.db-wal             # transient; should be 0 bytes or absent at handoff
│   └── state.db-shm             # transient
├── handoff.json                 # the receipt (last clean handoff)
├── DIRTY                        # dirty marker: written on open, deleted on clean close
└── snapshots/
    ├── gen0041.db
    ├── gen0041.sha256
    └── gen0042.db
    └── gen0042.sha256
```

Do not put small files on this disk (allocation unit is 128 KiB, see [01](01-failure-modes.en.md)). `snapshots/` keeps **2 generations** only.

---

## 2. File formats

### 2.1 `handoff.json` — the receipt

```json
{
  "protocol": 1,
  "gen": 42,
  "owner": "windows",
  "closed_at": "2026-10-26T02:31:00+08:00",
  "closed_at_unix": 1792953060,
  "rollback": false,
  "db": {
    "file": "db/state.db",
    "bytes": 104857600,
    "sha256": "9f2c…（64 hex）"
  },
  "sqlite": {
    "integrity_check": "ok",
    "journal_mode_at_close": "wal",
    "checkpoint": "truncate",
    "page_size": 4096,
    "page_count": 25600,
    "free_pages": 1152
  },
  "wal_bytes_at_close": 0,
  "content_digest": { "tables": 22, "rows_total": 5000 }
}
```

- `owner` is the side's name (`windows` / `macos`), used **for humans and logs only** — it never takes part in any decision.
- `closed_at*` is **informational only**; it is never compared or ordered (timestamps are untrustworthy, see 01·A3).
- `gen` is the only ordering authority.
- `content_digest` is optional, and exists to catch "structure intact but content replaced or rolled back" (see 01·B4).

### 2.2 `DIRTY` — the dirty marker

```json
{ "protocol": 1, "owner": "windows", "gen": 43, "opened_at": "2026-10-26T09:12:03+08:00", "pid": 8812 }
```

The contents are written out only to help debugging. **The decision is based on existence alone.**

---

## 3. Invariants

| # | Invariant | Why |
|---|---|---|
| I1 | At most one owner at any moment | mutual exclusion is the entire premise |
| I2 | `gen` is monotonically increasing; **a rollback also `+1`s it** and sets `rollback: true` | once generations go backwards, `handoff.json` stops being comparable |
| I3 | `handoff.json` must be written as **temp file + fsync + rename over** | exFAT supports rename-over (measured), but write-in-place leaves half a JSON on power loss |
| I4 | `DIRTY` is created **before the database is opened** and deleted **after the database is closed** | the other order leaves a window where "it was opened but nothing records it" |
| I5 | "Did it change" may only be decided with sha256; mtime, size and the presence of `-wal` are **forbidden** | 01·A3 / 01·B5 |
| I6 | A rollback must not delete the abandoned database; rename it and keep at least one generation | rollback deletes data, so it must be reversible |
| I7 | Identify the volume by **serial number / UUID**, never by drive letter or mount point | 01·C4 |
| I8 | Snapshots must be read back and re-hashed after writing | on exFAT, a successful write does not prove a successful read |

---

## 4. Boot: the open sequence

Precondition: the volume is mounted and its serial number matches (otherwise **refuse to start** — do not silently fall back to a local directory and create a fresh database, which is the most common way memories "vanish into thin air").

```
O1  The app must not be running (liveness = can we open db/state.db exclusively)
        └─ fails → refuse, report "the app is still running"

O2  Does DIRTY exist?
        ├─ yes → the last session did not finish cleanly → goto recover sequence R
        └─ no  → continue

O3  Does handoff.json exist, with protocol ≤ the version this side supports?
        ├─ no receipt     → first takeover → goto first-run sequence F
        └─ higher version → refuse (an older side must not touch a newer side's file)

O4  Compute sha256 of db/state.db and compare with handoff.json.db.sha256
        ├─ differs → the file was changed outside the protocol → goto recover sequence R
        └─ equal   → continue

O5  PRAGMA quick_check → must be ok
        └─ otherwise → goto recover sequence R

O6  Write DIRTY (with this session's gen, owner, pid)
        └─ must fsync and be sure it landed before continuing

O7  Open the database and work normally
```

**Why O6 comes before O7**: opening first and recording afterwards leaves a power-loss window in which "the database was written but nothing knows about it". That window is precisely the thing the next boot has to defend against.

---

## 5. Shutdown: the close sequence

Trigger: the user exits the app / logs out / a shutdown script. Execution on a hard power cut **cannot be guaranteed** — which is exactly why it must make its own absence **discoverable on the next boot** (that is why `DIRTY` is only deleted by the *next* successful close, never trusted from a previous one).

```
C1  Make the app really exit, and confirm we can open db/state.db exclusively (all handles gone)

C2  PRAGMA wal_checkpoint(TRUNCATE)
        └─ result busy must be 0; after checkpointing, the byte count of -wal must be 0
        └─ if busy != 0 → some other connection is still reading/writing → abort the close
           (keep DIRTY), report "something is still holding the database", and do not force a seal

C3  PRAGMA integrity_check → must be ok
        └─ otherwise → do not write a receipt; rename the database and keep it → goto recover sequence R

C4  New generation g = gen + 1
    Copy db/state.db → snapshots/gen<g>.db (zero-padded to 4 digits)
    Read the snapshot back, compute sha256 → write snapshots/gen<g>.sha256 (with byte count)
        └─ mismatch → writes on exFAT are not trustworthy → abort, keep DIRTY

C5  Compute sha256 and byte count of db/state.db

C6  Atomically write handoff.json: write handoff.json.tmp → fsync → rename over handoff.json
        gen=g, owner=this side, the clean check results

C7  Delete DIRTY          ← this must be the last step
    (then optionally: delete snapshots older than g-1, keeping 2 generations)
```

**C7 is the sealing stamp.** Only when it succeeds will the next boot consider this file trustworthy. If any step before it fails, `DIRTY` is still there — and that is exactly what we want: **rather let the next boot go through recovery than let it believe everything is fine.**

---

## 6. Recovery sequence

Entered when: `DIRTY` exists, or the sha256 does not match, or `quick_check` fails.

```
R1  Lock the whole procedure (create a RECOVERING marker under state/ to prevent concurrency)

R2  Examine the current db/state.db:
      PRAGMA integrity_check (full, not quick)

R3  Decision table ↓
```

| Situation | Verdict | Action |
|---|---|---|
| `integrity_check` = ok | structure intact | **keep the current database** (it holds the newest data), copy it to `snapshots/gen<g+1>.db` as the new rollback anchor, write a receipt with `rollback: false`, log "last session did not close cleanly, checks passed". Do **not** roll back just because you saw `DIRTY` — that throws away the entire session |
| `integrity_check` failed | structure broken | try the snapshots in `snapshots/` **from newest to oldest**: verify `.sha256`, then `integrity_check`. Replace `db/state.db` with the first one that passes (**first rename the current file to `db/state.db.abandoned-<gen>-<time>`; never delete it**), `gen+1` with `rollback: true` |
| Every snapshot fails | no way forward | **stop.** Copy the entire working directory aside for the record, report to the user, including the `abandoned-*` files and each snapshot's check result. Do not try to "repair" it — that destroys the evidence |
| `integrity_check` passes but `content_digest` shrank noticeably | possibly rolled back | keep the current database, but **report it to the user** (this is the patch for 01·B4: only when both the hash and the checks pass do you notice "content went missing") |

```
R4  Finish: write handoff.json (with the rollback flag) → delete DIRTY → delete RECOVERING
R5  After boot, the user **must** be shown a human-readable verdict:
      "The last session (windows) did not shut down cleanly. / Checks passed, continuing, no data lost."
      "Rolled back to gen0041; the abandoned database is at db/state.db.abandoned-… (not deleted)"
```

> **R5 is not optional.** The most dangerous failure mode of this protocol is "roll back quietly, continue quietly", and a week later you discover a large block of memories is gone.

---

## 7. First takeover (first run / migration)

```
F1  No state/ on the shared volume → this side **copies** (does not move) its existing database in
F2  Write a provenance file under state/: which side, source path, original sha256, time
F3  Run one full close sequence (C2–C7) to obtain a gen=1 receipt and snapshot
F4  Leave the original database where it was, **undeleted**, at least until the other side has opened it successfully once
```

Neither side may modify the original database during migration. The classic way to get this wrong: both sides "migrate" once, and the copy on the shared volume ends up being the later one — the earlier side's history survives only in its own original copy.

---

## 8. State machine

```
                 ┌────────────┐
    boot ───────►│  CHECKING  │
                 └─────┬──────┘
        DIRTY / hash mismatch / checks failed
                 │            │ all pass
                 ▼            ▼
           ┌──────────┐  ┌──────────┐
           │RECOVERING│  │  OPENED  │◄── write DIRTY
           └────┬─────┘  └────┬─────┘
   roll back /  │             │ user exits
   continue     └──────┬──────┘
                       ▼
                 ┌──────────┐
                 │ CLOSING  │  checkpoint → checks → snapshot → receipt
                 └────┬─────┘
              ok      │    failure (any step)
                      ▼         │
                 ┌─────────┐    │ DIRTY kept
                 │ SEALED  │    └──► next boot enters RECOVERING
                 └─────────┘
               (delete DIRTY)
```

---

## 9. Minimum implementation (pseudocode)

```python
def open_state(root):
    assert volume_serial(root) == EXPECTED_SERIAL        # I7
    assert can_open_exclusive(root/"db/state.db")        # O1
    if (root/"DIRTY").exists():                          # O2
        return recover(root)
    rec = json.load(root/"handoff.json")                 # O3
    assert rec["protocol"] <= PROTOCOL
    assert sha256(root/"db/state.db") == rec["db"]["sha256"]   # O4
    assert pragma(root/"db/state.db", "quick_check") == "ok"   # O5
    atomic_write(root/"DIRTY", {...}, fsync=True)         # O6 / I4
    return Db(root/"db/state.db")                         # O7

def close_state(root, db, owner):
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)")            # C2
    assert wal_bytes(root) == 0, "still held by a connection, refusing to seal"
    assert db.exec("PRAGMA integrity_check") == "ok"       # C3
    g = last_gen(root) + 1
    copy_verify(root/"db/state.db", root/f"snapshots/gen{g:04d}.db")   # C4 / I8
    rec = {..., "gen": g, "db": {"sha256": sha256(...), "bytes": ...}} # C5
    atomic_write(root/"handoff.json", rec, fsync=True)     # C6 / I3
    (root/"DIRTY").unlink()                                # C7 last step
```

---

## 10. What this protocol does **not** protect

- ❌ **Structural damage to the exFAT volume itself** (cluster chains broken after a power cut, `fsck_exfat` "repairing" on its own initiative). The protocol can only **discover** it afterwards, never prevent it. If you want real protection, do not use exFAT — use a filesystem with a journal, or do not share.
- ❌ **Permission leakage** (01·A2). On exFAT the database is world-readable.
- ❌ **Concurrent writing when both systems run at once.**
- ❌ **The app's own bugs** (e.g. it crashes halfway through writing). The protocol only guarantees that "the next boot knows whether to trust it".
- ❌ **A user who ignores the warnings and opens it anyway.** If nobody reads the recovery verdict, the protocol degrades into "a script that writes json".

---

## 11. Implementation status (`handoff.mjs`)

A spec is a spec; an implementation is an implementation. Here is the item-by-item comparison — **whatever is unimplemented says so**, so you don't trust your database against a table that "should work".

| Spec item | Status | Note |
|---|---|---|
| I1 dirty marker (write on open, delete last on clean close) | ✅ | `open` writes `DIRTY`; `close` deletes it only after everything is green |
| I2 receipt first, dirty marker deleted after | ✅ | the order is hard-coded, not left to discipline |
| I3 atomic replace (tmp + rename over) | ✅ | relies on exFAT supporting rename-over (01·A, measured ok) |
| I4 / I8 snapshots read back and re-hashed | ✅ | reads it back and recomputes sha256; mismatch is a failure |
| I5 trust only sha256 (no mtime / size / `-wal`) | ✅ | no timestamp or size comparison exists anywhere in the decision path |
| I6 `wal_checkpoint(TRUNCATE)` with `-wal` at zero | ✅ | not zero → exit 21, no receipt written |
| I7 volume serial instead of drive letter | ❌ | **not implemented.** Copy the whole directory to another disk and it will not notice |
| `content_digest` (table count / total rows) | ❌ | **not implemented** (an optional field in the spec). So the 01·B4 case — "structure intact, content rolled back" — still needs human attention |
| `files_digest` (sha256 of the directory manifest) | ➕ | **an extension beyond the spec**: when the handoff unit is a whole directory, not just `memory.db`. A mismatch in the mirror only warns, never blocks; the reason is in [05 §1](05-mneme-setup.en.md) |
| Full O1–O7 / C1–C7 sequences | ✅ | including explicit cleanup of `-shm` / `-wal` |
| Broken database renamed, never deleted | ✅ | moved into `.handoff/abandoned/`; a rollback always archives first |
| Only 2 snapshot generations | ✅ | the spec does not mandate a count; the implementation chose 2 |
| Boot automation (open before the app starts) | ❌ | not done, left to the human (reason in [05 §4](05-mneme-setup.en.md)) |
| "Is the app still running" detection | ⚠️ | only by trying to take a write lock (`BEGIN IMMEDIATE`); **a process that has the database open but no active transaction is not detected** — this is the step that needs a human confirmation |
