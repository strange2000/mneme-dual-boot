# 🚑 03 · What to do on the bad day

> Precondition: you already keep the database on a shared volume, and now it looks suspicious.
> **First principle: before you touch anything, copy the whole scene as it is.** Every step below is reversible, but the act of "repairing" destroys evidence.

<p>
  <a href="03-recovery-runbook.en.md"><img alt="English" src="https://img.shields.io/badge/English-2f81f7?style=flat-square&amp;logo=googletranslate&amp;logoColor=white"></a>
  <a href="03-recovery-runbook.md"><img alt="中文" src="https://img.shields.io/badge/%E4%B8%AD%E6%96%87-30363d?style=flat-square&amp;logo=googletranslate&amp;logoColor=white"></a>
</p>

---

## 0. Do this first (30 seconds, in every situation)

```bash
# copy the whole state/ directory as-is to a LOCAL disk (not to the shared volume, and don't overwrite anything)
cp -a /Volumes/Shared/state ~/state-backup-$(date +%Y%m%d-%H%M%S)
```

Windows (PowerShell):

```powershell
$dst = "$env:USERPROFILE\state-backup-" + (Get-Date -f yyyyMMdd-HHmmss)
robocopy "X:\state" $dst /MIR /R:0 /W:0
```

**If this step fails because "the file is in use"**, something is still running — exit it cleanly (including tray processes) and try again. Don't fudge it with "well, I got a readable copy out": what you want to keep is the **original unreadable state**, which is the evidence and the only thing that might still be recoverable.

### ⚠️ 0.1 Never "take a read-only peek" on the shared volume — the error lies to you

You copied the scene in order to decide "is this still readable". **Do not open the original database on the shared volume read-only**:

```bash
# on macOS this line fails with "unable to open database file" (errno 14)
sqlite3 "file:/Volumes/Shared/state/db/state.db?mode=ro" "PRAGMA integrity_check;"
```

The cause is neither a missing file nor a corrupt database: **a WAL reader must create / map the `-shm` file in the same directory**. When the directory is not writable (or the volume is mounted read-only), SQLite cannot even open the database, and reports something that reads like "file missing / database corrupt". On the day of an incident, that error all but invites you to conclude the database is gone and perform a pointless rollback.

The most tempting and most dangerous move is to add `?immutable=1`:

```bash
sqlite3 "file:/Volumes/Shared/state/db/state.db?immutable=1" ".tables"   # opens fine, but…
```

`immutable=1` promises SQLite that the file cannot change, and therefore it **ignores the WAL entirely**. You will read a stale database missing a batch of rows, and may even get `no such table` for tables that exist only in the WAL — straight back into "the data is gone".

**The right move: copy the whole set to a writable local directory first, then inspect the copy.**

```bash
mkdir -p ~/state-inspect
cp -a /Volumes/Shared/state/db/state.db* ~/state-inspect/     # db + -wal + -shm together
sqlite3 -readonly ~/state-inspect/state.db "PRAGMA integrity_check;"
```

`state.db*` picks up `-wal` and `-shm` along with the database. **Copying `state.db` alone is data loss** (see [01·B2](01-failure-modes.en.md) and [01·B5](01-failure-modes.en.md)).

---

## 1. Decide which category you are in (do not skip steps)

```
① Is the shared volume mounted? Is the drive letter / mount point right? Is the volume serial right?
   ├─ not mounted / wrong serial → 【DO NOT create any new database】→ fix the mount, back to ①
   └─ mounted → ②

② Does state/DIRTY exist?
   ├─ yes → the last session did not finish cleanly → go to §2
   └─ no  → ③

③ Can the database be opened? (read-only open, no writes)
   ├─ cannot open (malformed / not a database) → go to §3
   └─ opens → ④

④ Does the sha256 match handoff.json?
   ├─ matches → all good, just use it (no DIRTY + matching hash = clean handoff)
   └─ differs → go to §3
```

Read-only, guaranteed-no-write open — **but read §0.1 first: opening the original on the shared volume either fails outright or lies to you.**

The reliable route is not "find a way to open the original read-only", but **inspect the copy**:

```bash
mkdir -p ~/state-inspect
cp -a /Volumes/Shared/state/db/state.db* ~/state-inspect/    # db + -wal + -shm
sqlite3 -readonly ~/state-inspect/state.db "PRAGMA integrity_check;"
```

> `immutable=1` is safe only when you have **confirmed the app has exited AND there is no `-wal` (or it has been checkpointed to zero)**; otherwise it ignores the WAL and hands you an inconsistent stale snapshot.

---

## 2. `DIRTY` exists — the last session did not close cleanly

This is the **most common** situation, and **most of the time it does not need a rollback**.

### 2.1 Examine it first; don't rush to roll back

# examine the LOCAL copy made in §0.1 (do not open the original on the shared volume)
sqlite3 -readonly ~/state-inspect/state.db "PRAGMA integrity_check;"

| Result | Action |
|---|---|
| `ok` | **Just keep using it.** Copy the current database into a new snapshot (`snapshots/gen<g+1>.db`) as the anchor, write a receipt (`rollback:false`), delete `DIRTY`. Log "last session did not close cleanly, checks passed". |
| not `ok` (a pile of `*** in database main ***` / `Page N is never used` etc.) | go to §3 |
| `malformed` / cannot open | go to §3 |

⚠️ **"Saw DIRTY, so roll back" is the easiest mistake to make with this protocol.** `DIRTY` only means "nobody stamped this", not "the database is broken". Rolling back blindly throws away your entire previous session.

### 2.2 While you're here, confirm nothing went missing

Intact structure ≠ nothing lost (see [01·B4](01-failure-modes.en.md)). Compare with `content_digest` from the previous receipt:

```bash
sqlite3 -readonly ~/state-inspect/state.db "SELECT COUNT(*) FROM sqlite_master WHERE type='table';"
# row counts depend on your own tables, e.g.:
sqlite3 -readonly ~/state-inspect/state.db "SELECT COUNT(*) FROM <your main table>;"
```

If the row count is **clearly lower than the receipt says**, a rollback or replacement happened somewhere — stop using it and look for `abandoned-*` per §4.

---

## 3. The database is broken / the hash does not match — roll back

### 3.1 Preserve the scene

```bash
cd /Volumes/Shared/state/db
mv state.db "state.db.abandoned-$(date +%Y%m%d-%H%M%S)"      # rename, DO NOT delete!
rm -f state.db-wal state.db-shm state.db-journal             # transient — but only after the file above is moved
```

> Do **not** rename the transient files (`-wal`/`-shm`/`-journal`) along with it — they only mean anything next to *the original main file*. If you suspect the main file is still salvageable, copy all three aside first, then act.

### 3.2 Find a usable snapshot, newest first

```bash
cd /Volumes/Shared/state/snapshots
for f in $(ls -r gen*.db); do
  echo "=== $f"
  echo "$(cat ${f%.db}.sha256 2>/dev/null)  $f" | sha256sum -c - 2>&1 | head -1
  sqlite3 -readonly "file:$PWD/$f?mode=ro&immutable=1" "PRAGMA integrity_check;" 2>&1 | head -3
done
```

Pick the **newest one whose sha256 and integrity_check both pass**.

### 3.3 Land it

```bash
cp -a gen0041.db ../db/state.db
# verify the copy immediately (on exFAT a successful write does not prove a successful read)
sqlite3 -readonly "../db/state.db" "PRAGMA integrity_check;"
```

Then write the receipt: `gen = 42` (**never go backwards**), `rollback: true`, recompute `db.sha256`, `owner` = the current side. Delete `DIRTY`.

### 3.4 Tell the user (mandatory)

> The last session (windows) did not shut down cleanly and the database was damaged.
> Rolled back to gen0041 (macos, 2026-10-25 23:35).
> **The abandoned database was not deleted**: `db/state.db.abandoned-20261026-021500`.
> The data from that hour and a half in between has to be salvaged by hand from abandoned.

**If this is not reported, "rolling back" equals "silently deleting that stretch of memory".**

---

## 4. Salvaging data from `abandoned-*` / older snapshots

```bash
sqlite3 -readonly "abandoned.db" ".tables"
sqlite3 -readonly "abandoned.db" ".schema <table>"
sqlite3 -readonly "abandoned.db" "SELECT * FROM <table> ORDER BY rowid DESC LIMIT 20;"
```

When salvaging:

- open **read-only** (`-readonly`), and work on a copy on a local disk where possible — never run writes against a broken database on the shared volume.
- timestamps are untrustworthy (01·A3); order by auto-increment primary key / rowid / your own sequence column.
- do **not** `INSERT` what you salvage straight back into the main database: export it as text, review it by hand, then merge.

---

## 5. No snapshot works — stop

All you can do at this point:

1. Copy the entire `state/` directory to a local disk for the record (two copies: one read-only archive, one to experiment on).
2. Report: each snapshot's check result, file sizes, the `handoff.json` history.
3. Try `sqlite3 .recover` **on a copy**:

```bash
cp abandoned.db /tmp/try.db
sqlite3 /tmp/try.db ".recover" | sqlite3 /tmp/recovered.db
sqlite3 /tmp/recovered.db "PRAGMA integrity_check;"
```

`.recover` pulls as much page-level data as it can out of a damaged database. **It is not a repair, it is a salvage.** The resulting structure may be a patchwork, so always do it on a copy.

4. Do **not** run any "database repair tool" against this exFAT disk — they typically rewrite the file in place, and one failure means it is gone for good.

---

## 6. The 6 things you must never do

| ❌ | Why |
|---|---|
| roll back the moment you see `DIRTY` | in most cases the checks pass, and a rollback throws data away for nothing |
| delete `abandoned-*` | it is the only thing left that might still hold the data |
| run a repair tool in place on the shared volume | in-place rewrite; failure is total loss, and exFAT has no journal to fall back on |
| keep whichever copy has the "most recent modification time" | 2 s (Windows) / 10 ms (macOS) granularity + cross-system timezone offset (01·A3); essentially a coin flip |
| "just take a quick look" from the other machine / the other system | you are creating the second concurrent access |
| hastily reinstall the app / rebuild the database | rebuilding silently produces an empty database, which then "normally" overwrites everything |

---

## 7. Afterwards: turn the lesson into a checkup

Once recovery is done, do at least this:

- [ ] run a full `PRAGMA integrity_check` and record the result in the receipt
- [ ] confirm `snapshots/` holds 2 usable generations
- [ ] confirm the close script **actually ran** (if it relies on "triggered at logoff", it may never have run at all — this is the most common root cause)
- [ ] fill in `content_digest` (table count + total rows) so the next time "content shrank" is detectable
- [ ] if this was caused by a power loss / hard shutdown: decide whether you are still willing to use exFAT (see [04](04-why-not-sync.en.md) §6)
