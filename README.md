# mneme-dual-boot

<p align="center">
  <img src="assets/banner.svg" alt="mneme-dual-boot — verified handoff for one SQLite database on a dual-boot shared volume" width="100%">
</p>

<p align="center">
  <a href="README.md"><img alt="Read in English" src="https://img.shields.io/badge/ENGLISH-2f81f7?style=for-the-badge&amp;logo=googletranslate&amp;logoColor=white"></a>
  <a href="README.zh-CN.md"><img alt="用中文阅读" src="https://img.shields.io/badge/%E4%B8%AD%E6%96%87-30363d?style=for-the-badge&amp;logo=googletranslate&amp;logoColor=white"></a>
</p>

<sub>中文版 (Chinese): [README.zh-CN.md](README.zh-CN.md) — use the button above, or this link.</sub>

<p align="center">
  <img alt="license MIT" src="https://img.shields.io/badge/license-MIT-3fb950?style=flat-square">
  <img alt="node 22 or newer" src="https://img.shields.io/badge/node-%E2%89%A522-339933?style=flat-square&amp;logo=nodedotjs&amp;logoColor=white">
  <img alt="zero dependencies" src="https://img.shields.io/badge/dependencies-0-2f81f7?style=flat-square">
  <img alt="platforms Windows and macOS" src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS-8b949e?style=flat-square">
  <img alt="protocol v0" src="https://img.shields.io/badge/protocol-v0-d29922?style=flat-square">
</p>

**One laptop. Two operating systems (hackintosh macOS + Windows). One memory database. One at a time.**

This is how I run [`@modusensus/dsh-mneme`](https://github.com/slow-stack/mneme)'s `memoryDir` on a volume that both systems mount — written up so the next person doesn't have to rediscover it the hard way. The protocol underneath is generic (any single SQLite state file, any dual-boot machine); the case that produced it is mine.

> ⚠️ **This is not a sync tool.**
> A dual-boot machine never runs both systems at once, so there is **nothing to synchronise** — whoever booted owns the file.
> The real enemy is not "the two sides disagree", it is **"the next side trusts whatever the previous side left behind"**.
> An SQLite database on a journal-less volume looks perfectly fine after a crash, a hard shutdown, or an unclean unmount — right up until you write enough data to discover it was already broken. That is the single problem this repo is about.

📄 **Fully bilingual.** Every document exists twice — `docs/NN-*.md` (中文) and `docs/NN-*.en.md` (English) — and every file carries the same switcher at the top. This README: [中文版](README.zh-CN.md).

---

## 💥 Why this needed writing down

Putting a database on a shared volume is, on the surface, two lines:

```bash
ln -s /Volumes/Shared/state.db ~/.app/state.db     # macOS
mklink  C:\Users\me\.app\state.db X:\state.db      # Windows
```

**Those two lines destroy people's databases.** They aren't wrong, they just don't mention the price:

- exFAT has no journal — a crash inside a write transaction can damage not just the file but the volume;
- exFAT has no POSIX permissions — your database is readable by every account on the machine;
- exFAT timestamps have **2-second** granularity, and the two systems' clocks drift — you cannot use mtime to decide which side is newer;
- both systems see **the same bytes** but bring **their own cache, their own mount state, their own crash-recovery logic**.

Everything below is the verifiable envelope around those two lines.

---

## 📊 Measured (Windows side, Node 24 + SQLite 3.53.4)

Reproduce with [`lab/`](lab/README.en.md). All of it on a real dual-boot shared exFAT volume, not a simulation.

| Property | Measured | Consequence |
|---|---|---|
| Volume | exFAT, hundreds of GB (plenty free) | no journal, no permissions, no hard links |
| Allocation unit | **128 KiB** (a 1-byte file occupies 131,072 bytes) | a snapshot chain of small files wastes a lot of space |
| mtime granularity | **2.000 s** (20 writes in 5 s produced 4 distinct timestamps) | ⚠️ **never judge recency by timestamp** |
| Case sensitivity | insensitive: `CaseProbe.TXT` and `caseprobe.txt` are the same file; writing the lower name overwrites the upper | path checks and case-varied copies actively collide |
| POSIX permissions | `chmod 0600` yields mode `666` | ⚠️ the database is world-readable on that machine |
| Symlinks / hard links | both fail (`EISDIR`, errno −4068) | no link-based layout inside the volume |
| `rename` over an existing file | **works** | ✔ atomic replacement available (the protocol needs it) |
| Exclusive create `open(...,'wx')` | **works**; second writer gets `EEXIST` | ✔ lock primitive available |
| SQLite cross-process locks | **work**: second process refused in both `delete` and `wal` modes (`database is locked`) | ✔ single-writer enforcement available |
| WAL | works; `wal_checkpoint(TRUNCATE)` takes `-wal` to 0; a clean close removes `-wal`/`-shm` | handoff must checkpoint explicitly |
| Commit cost | `journal_mode=delete`: **4.9–5.2 ms**; `wal`: **1.4–1.6 ms** (300 synchronous commits, two runs) | WAL is ~3.5× faster, at the cost of one more state to handle at handoff |
| Cost of a 152 MB handoff | read 97–474 ms + write with fsync 221–237 ms + sha256 514–589 ms ≈ **0.9–1.2 s** (second read hit the file cache) | roughly one second per boot/shutdown |
| ⚠️ Does the `-wal` file reach the disk? | **a child process committed 500 times in WAL mode and no `-wal` file existed on disk** (3 reproductions) | see conclusion 5: never use WAL presence/size as evidence |
| A real database, checked | a few hundred MB (plus a multi-MB WAL), page 4096, freelist 4.5%, 22 tables, `integrity_check` = ok in 1141 ms | for this size, a physical runs in about a second |

### 🧠 Five conclusions

1. **The locks are fine; the timestamps are not.** SQLite's cross-process locking works on exFAT, and so do `rename` and `open(wx)` — every primitive the protocol needs is there. The one thing that is broken is the naive "how long has this file been idle" test: 2-second granularity, incomparable across systems. **Hash the content; never trust mtime.**
2. **Permissions are simply gone.** `chmod 600` fails silently. A database on this volume is readable by any account that can log in. Accept it, or make the volume encrypted — but don't pretend `chmod` protects you.
3. **Case-insensitivity means "two files" can be one file.** Any design that keeps copies distinguished by case, or validates by path spelling, is wrong on this filesystem.
4. **WAL makes you faster and hands you one more state to handle at handoff.** On a clean close SQLite checkpoints and removes `-wal`/`-shm` by itself; after a crash or a hard shutdown it does not. **The first step of any handoff is an explicit `PRAGMA wal_checkpoint(TRUNCATE)` — never hope the app did it on exit.**
5. **One anomaly I could not explain (important).** A child process committed **500 times** in WAL mode, never closed, then got `SIGKILL`ed: throughout, there was **no `-wal` file on disk**, and all the data was already inside the 16 KB main file — another process read all 500 rows, `integrity_check` was ok, `journal_mode` still reported `wal`. **Reproduced 3 times.** The same operations from the parent process do produce a `-wal` (measured at 12,392 and 1,351,392 bytes in two runs).
   Two candidate explanations, neither confirmed: **(a)** it is a connection-flag issue in `node:sqlite` (Node's built-in driver), nothing to do with the volume; **(b)** the volume's write cache makes WAL frames appear to land directly. Falsifying it takes the native `sqlite3` CLI doing the same experiment on the same volume — that is the single most welcome PR here.
   The conclusion does not depend on the explanation, which makes it stronger: **never treat "is there a `-wal`", "-wal size" or "main file size" as evidence of anything.** Trust only hashes you computed, integrity checks you ran, and receipts you wrote.

---

## 🧭 The protocol in one sentence

> **Verify before you enter; seal before you leave; anything unsealed is not to be trusted.**

The full spec (file formats, state machine, atomicity requirements, rotation and rollback) is [`docs/02-handoff-protocol.en.md`](docs/02-handoff-protocol.en.md). It comes down to three artifacts:

- `state.db` — the single source of truth, on the shared volume;
- `handoff.json` — the **receipt**: generation, owner, close time, size, sha256, integrity result;
- `DIRTY` — a marker **written on open, deleted on clean close**. If the next boot sees it, the previous session did not finish properly: go to recovery, do not open the database.

The generation (`gen`) is **an integer you increment yourself**, not a timestamp — because timestamps are not trustworthy on this filesystem.

<p align="center">
  <img src="assets/handoff-flow.svg" alt="The daily loop: boot, open, use, close, shut down — alternating between macOS and Windows, always the same database on the shared volume" width="100%">
</p>

---

## 🧰 Reference implementation: `handoff.mjs`

Zero dependencies, one file, Node ≥ 22 (uses `node:sqlite`, `node:crypto`, `node:fs`). Copy it anywhere and run it; there is nothing to install.

```bash
node handoff.mjs open    <shared-dir> --owner windows   # after boot, before starting the app
node handoff.mjs close   <shared-dir> --owner windows   # after the app exits, before shutdown
node handoff.mjs status  <shared-dir>                   # read-only: can this database be trusted now
node handoff.mjs recover <shared-dir>                   # last session did not finish: check, then roll back if needed
```

Metadata lives in `<shared-dir>/.handoff/`, next to your data — so it travels with the volume, and you can never end up with the receipt on one disk and the database on another.

| Exit code | Meaning | What to do |
|---|---|---|
| 0 | ok | carry on |
| 10 | `DIRTY` present — last session did not close cleanly | run `recover` |
| 11 | database sha256 does not match the receipt | run `recover` (a crash, a manual edit, or a second writer) |
| 12 | `integrity_check` failed | run `recover`; the bad file was renamed into `abandoned/`, **not deleted** |
| 13 | no receipt (first run) | `close` once to establish a baseline; see `docs/02` §7 |
| 14 | receipt came from a newer protocol version | don't let an older hand write over a newer one |
| 20 | cannot take the write lock — something still holds the database | stop the app (including tray/menubar processes) and retry |
| 21 | `wal_checkpoint` left data in the `-wal` | don't shut down; find out who is still writing |
| 22 | no usable snapshot | see `docs/03` §5 |
| 30 | bad usage | see `--help` |

**`close` does not "try its best".** If any step fails it does not write a receipt and does not delete `DIRTY`; it would rather make you run it again. That is deliberate: a database that *looks* clean is far more dangerous than one that clearly reports a problem.

The implementation has been driven through 13 end-to-end scenarios on a real exFAT volume (normal handoff, double open, dirty marker, healthy recovery, bad-page detection, rollback, snapshot rotation, hand-edited mirror, hand-edited database, another process holding the lock) — all as expected. A damaged database is always **renamed and kept**, never deleted; snapshots are **read back and re-hashed after writing**, not trusted on write.

Want to see it yourself? Clone onto the shared volume and run one command:

```bash
node lab/handoff-selftest.mjs E:/_hstest     # 18 assertions, a few seconds
```

It creates a database **on your volume**, then pushes it through nine situations (including page-level corruption and rollback), asserting exit codes. Expected values are tabulated in [`lab/README.en.md`](lab/README.en.md).

---

## ✨ Where this came from: mneme

None of this was designed in the abstract. It solves one specific problem: **my AI memory database ([`@modusensus/dsh-mneme`](https://github.com/slow-stack/mneme), MIT) has to be the same `memory.db` in both systems of one dual-boot laptop.**

So the most convincing evidence is that it is actually running:

```yaml
# both sides point at the same physical directory
memoryDir: E:/mneme                      # Windows
memoryDir: /Volumes/Shared/mneme          # macOS — the same directory
```

```bash
node handoff.mjs open  E:/mneme --owner windows   # after boot
#   ... use DSH, write memories freely ...
node handoff.mjs close E:/mneme --owner windows   # after DSH exits AND the daemon is stopped
```

mneme guarantees a single writer **within one process** (memory consolidation is only wired into the host process). It cannot see that the previous boot belonged to a different operating system — exactly the hole this protocol fills. The concrete setup, why the daemon (`dsh-mneme-serve`, default `127.0.0.1:8790`) must be stopped before `close`, and why the handoff unit is **the whole directory** rather than just `memory.db`, are in [`docs/05-mneme-setup.en.md`](docs/05-mneme-setup.en.md).

> Not using mneme? Then you only need `docs/01`–`04`. The protocol does not know about mneme, and neither does `handoff.mjs`.

---

## ✅ Scope

**✅ Fits**

- one machine, two systems taking turns (mutually exclusive)
- the state lives in **a single file** (SQLite, KeePass, some note apps, a git repo)
- the shared volume is exFAT / FAT32 / NTFS (read-only on macOS) — anything without POSIX semantics
- you are willing to pay 1–2 seconds per boot and per shutdown

**❌ Does not fit**

- ❌ **two machines that can be on at the same time** — that is real concurrent writing and needs real conflict resolution
- ❌ several applications writing the same database
- ❌ a filesystem without atomic `rename` (then there is no safe way to land a receipt)
- ❌ "I want it invisible and free" — every step here is deliberate friction, and the friction is the insurance

---

## 🙈 What is not here

The honest limits are listed in [`docs/01-failure-modes.en.md`](docs/01-failure-modes.en.md) (see the unverified list at the end). Short version:

- **Nothing on the macOS side was measured** (I only ran this on Windows): the exFAT driver's unmount behaviour, interference from `.Spotlight-V100` / `.fseventsd`, `lsof`-based liveness checks, behaviour after a real power loss.
- **No destructive experiments** (power loss, yanking the disk) — they would destroy the only database I have. Every "crash" result here comes from `SIGKILL`, not from cutting power; the difference is **the filesystem's own consistency**, which is precisely what exFAT does not have. This is the biggest known blind spot: read everything as "the worst case is worse than what is written here".
- **No boot automation.** No systemd / launchd / scheduled task, and nothing guarantees `open` runs before the app starts. Two systems need two setups, and getting it wrong is worse than not having it, so it is left to you.
- **No volume identity check.** The protocol (I7) says identify the volume by serial number, not drive letter; the implementation does not do it yet — copy the whole directory to another disk and it will not notice.
- **No GUI, no daemon, no installer.** It is four commands. That's it.

---

## 🗂️ Layout

| File | Contents |
|---|---|
| [`handoff.mjs`](handoff.mjs) | **Reference implementation**: `open` / `close` / `status` / `recover`, zero dependencies |
| [`docs/01-failure-modes`](docs/01-failure-modes.en.md) | Failure-mode inventory: filesystem / SQLite / timing / human |
| [`docs/02-handoff-protocol`](docs/02-handoff-protocol.en.md) | **Handoff protocol spec v0**: receipt, dirty marker, state machine, rollback |
| [`docs/03-recovery-runbook`](docs/03-recovery-runbook.en.md) | What to do on the bad day (including "when not to rescue") |
| [`docs/04-why-not-sync`](docs/04-why-not-sync.en.md) | Why there is **no** sync: the designs that were rejected, and why |
| [`docs/05-mneme-setup`](docs/05-mneme-setup.en.md) | The concrete mneme setup (daemon, whole-directory handoff) |
| [`lab/`](lab/README.en.md) | Reproducible probes: every row of the table above comes out of these |

---

## 📜 License

MIT. These numbers and this protocol were paid for in mistakes; hopefully someone else skips one.

If you measure something different (especially on the macOS side), please open an issue — that is the part of this document that is most missing.
