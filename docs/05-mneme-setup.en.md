# ✨ 05 · Wiring it up on mneme

This document attaches the generic protocol of the previous four to one concrete thing: **`@modusensus/dsh-mneme`** (the memory plugin for DSH, MIT, [slow-stack/mneme](https://github.com/slow-stack/mneme)).

This repository grew out of that plugin: one machine, two systems taking turns, both reading the same `memory.db`. So what follows was measured, not guessed.

> If you only want the generic approach (valid for any "single SQLite state file"), read [02-handoff-protocol.en.md](02-handoff-protocol.en.md); you don't need this one.

<p>
  <a href="05-mneme-setup.en.md"><img alt="English" src="https://img.shields.io/badge/English-2f81f7?style=flat-square&amp;logo=googletranslate&amp;logoColor=white"></a>
  <a href="05-mneme-setup.md"><img alt="中文" src="https://img.shields.io/badge/%E4%B8%AD%E6%96%87-30363d?style=flat-square&amp;logo=googletranslate&amp;logoColor=white"></a>
</p>

---

## 0. The division of labour in one line

| | Responsible for | Guaranteed by |
|---|---|---|
| **mneme itself** | no concurrent writing within one process; recovery after a crash via WAL replay | consolidation (autoDream/autoSummarize) is only wired into the DSH host process |
| **this protocol** | **across systems and across boots**, not trusting what the previous side left behind | receipt (sha256) + DIRTY + rollback |

mneme's single-writer guarantee is **process-level**; it cannot see that "the previous boot was a different operating system". That is the hole this protocol fills.

---

## 1. The handoff unit is the whole directory, not `memory.db`

A real `memoryDir` (0.9.4, a database in daily use for months) contains:

```
memory.db            151,846,912 B
memory.db-wal          4,144,752 B      ← must be handled together, see 01-B2
memory.db-shm             32,768 B
constraints.md            55 KB
decisions.md             205 KB
history.md               149 KB
pitfalls.md              365 KB
preferences.md           124 KB
projects.md              328 KB
rejected-solutions.md     10 KB
summary.md                 2 KB
agents/dsh-agent-persona-....json
```

Those 8 `.md` files are **human-readable mirrors, and they are bidirectional** — mneme renders them out and also reads them back in and merges (`generation` / `applied_generation`). In other words, people edit them by hand.

Conclusion: the unit of handoff is **the whole directory**. `files_digest` in `handoff.json` covers every file except `memory.db*` and `.handoff/`, which is exactly why.

**However**: when the mirror does not match, `open` only warns, it does not block (exit code is still 0). The reason: hand-editing the mirror is a normal mneme operation, and blocking it would mean overruling the user's own tool on their behalf; and the mirror is regenerable — `recoverMirror` heals it. The cost is written up in §4.

---

## 2. Three steps to wire it up

### Step 1 — point mneme at the shared directory

In DSH's profile config (`~/.dsh/profiles/<profile>/cordis.patch.yml`):

```yaml
- id: dsh-mneme
  config:
    memoryDir: E:/mneme          # Windows
    # memoryDir: /Volumes/Shared/mneme    # macOS — the same directory
```

Both sides name **the same physical directory**, each in its own system's form. Do not use the default `~/.dsh/memory` location — the two defaults point at two different disks, and that is precisely "two databases, each changing itself".

> Already on the default location? Archive it as-is per [03](03-recovery-runbook.en.md) §0 first, then change the config, and migrate with F1–F4 of 02 §7 on first start.

### Step 2 — after boot, before starting DSH: open

```bash
node handoff.mjs open E:/mneme --owner windows     # macOS: --owner macos
```

Only start DSH if the exit code is 0. For any other code, see [03](03-recovery-runbook.en.md) first.

`open` does: read the receipt → verify the sha256 of the database and the directory manifest → `quick_check` → `recover` any leftover `-wal` (if the previous side did not clean up) → **write `DIRTY`**.

### Step 3 — after exiting DSH (and the daemon): close

```bash
node handoff.mjs close E:/mneme --owner windows
```

`close` does: take the write lock to prove nobody else is using it → `wal_checkpoint(TRUNCATE)` and **force-verify `-wal` is zero** → `integrity_check` → take a snapshot and **read it back to verify** → write the receipt → **finally** delete `DIRTY`.

On failure (exit codes 10/11/12/20/21/22) it does not pretend to succeed. **It would rather make you run it again than leave a database that "looks clean".**

---

## 3. The hardest step: confirming that nothing still has it open

This is the only part of the whole thing that cannot be fully automated, and the place where I learned the hardest lesson on this machine.

`close` proves exclusivity with `BEGIN IMMEDIATE` (measured: with another process holding the lock it really does get `database is locked`, exit code 20). But that only proves that no write transaction was running **at that instant**; it does not prove that no process has the database **open**, waiting to write next.

And mneme happens to have something that keeps the database open long-term: **`dsh-mneme-serve` (the daemon, the data plane, default `127.0.0.1:8790`)**. It can write — `saveWithDedupe`, mirror rendering and `/maintenance/reclaim` all write.

So the order must be:

```
close DSH  →  stop the daemon  →  close  →  shut down
```

Confirming no stray processes remain:

```powershell
# Windows
Get-NetTCPConnection -LocalPort 8790 -ErrorAction SilentlyContinue
Get-Process node -ErrorAction SilentlyContinue | Select-Object Id,StartTime
```

```bash
# macOS
lsof /Volumes/Shared/mneme/memory.db
```

Both must come back empty. **Don't believe "there's no icon in the taskbar/menubar so it's closed"** — tray processes are the most common escapee, which is why `handoff.mjs` calls them out specifically in exit code 20.

If the daemon is still running and you run `close` anyway: `close` may succeed (it has no active transaction while idle), and then the daemon writes once after the close → that write is not in the receipt → the next `open` reports a sha256 mismatch (exit code 11). **Nothing is wrong with the data, but you will be asked to run a recover.** That is what "fail safe" looks like, as opposed to data corruption.

### Where reclaim / VACUUM goes

`/maintenance/reclaim` (VACUUM + analyse) takes an exclusive lock, runs for a long time, and **rewrites the whole file**. Run it before `close`, and run `close` again afterwards; or simply do it at the end of a session where you won't start DSH again. Never straddle a handoff with it.

---

## 4. Known simplifications (missing from my implementation, not holes in the protocol)

The honest list:

1. **I7 (volume identity) is not implemented.** The protocol says identify the volume by serial number, not by drive letter; `handoff.mjs` currently records only owner and path in the receipt, no volume serial. Consequence: copy the whole directory onto another disk and it will not notice.
2. **No boot automation.** systemd / launchd / scheduled task, and "who guarantees `open` runs before DSH", are not done — it needs two hand-written setups, one per system. Left to the human, because getting it wrong is worse than not having it.
3. **"DSH is closed but the daemon is open" is not detected.** Only the database lock can be probed, not "some process has the database open but no transaction right now". See §3; it relies on a human confirmation.
4. **A hand-edited mirror only warns.** See the reasoning in §1. If you require "the mirror must match byte for byte", change that warning in `open` into a block (one `process.exit`).
5. **`-shm` is not verified.** It is cross-process shared memory by definition, meaningless across boots; `close` removes it and `open` recreates it.

No destructive experiments were run: really pulling the power, really losing power mid-transaction — there is only one database in use on this machine and I did not dare. That is why the 01-C class (timing / power loss) is tagged [inferred], not [measured].

---

## 5. A full ordinary day (copy-paste ready)

```bash
# boot (Windows shown)
node handoff.mjs open  E:/mneme --owner windows     # 0 = you may start DSH
# ... use DSH, write memories freely ...
# wrapping up
#   1) exit DSH (including tray)
#   2) confirm the daemon is stopped (both commands in §3 come back empty)
node handoff.mjs close E:/mneme --owner windows     # 0 = sealed cleanly, you may shut down
```

On the macOS side, swap `E:/mneme` for `/Volumes/<your-volume>/mneme` (whatever the shared volume is mounted as) and `--owner` for `macos`; everything else is identical.
