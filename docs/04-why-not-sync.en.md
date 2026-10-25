# 🚫 04 · Why **not** to sync at all

This document records the designs that were rejected, and why. It exists because almost everyone who sees "dual boot + one copy of the data" thinks "just put a sync tool on it and you're done".

<p>
  <a href="04-why-not-sync.en.md"><img alt="English" src="https://img.shields.io/badge/English-2f81f7?style=flat-square&amp;logo=googletranslate&amp;logoColor=white"></a>
  <a href="04-why-not-sync.md"><img alt="中文" src="https://img.shields.io/badge/%E4%B8%AD%E6%96%87-30363d?style=flat-square&amp;logo=googletranslate&amp;logoColor=white"></a>
</p>

---

## 0. The decisive premise

> **This is one laptop with two systems installed (macOS + Windows). Only one of them is running at any moment.**
> When Windows is up, macOS is necessarily shut down, and vice versa.

Three things follow:

1. **There is no concurrent writing** — the two sides can never hold this file at the same time.
2. **There is no divergence** — nobody "changed the same row on both sides", because there are not two sides.
3. **The only thing to defend against is misapplied trust** — whichever side boots later starts from the assumption "the file is fine", and keeps writing on top of that assumption.

So: **sync algorithms solve "divergence", and there is no divergence here.** Adding a sync tool means using a very heavy mechanism to solve a problem that does not exist, while **introducing** new problems of its own (see below).

---

## 1. ❌ A "working copy" on each side, merged on exit

**Why rejected**: it needs a real merge algorithm. A database is not text — for a row changed on both sides, merging relies either on business keys + timestamps (timestamps are untrustworthy on this filesystem, see [01·A3](01-failure-modes.en.md)) or on CRDTs (which means changing the application's data model). And wherever there is merge logic, there is a path where **the merge is wrong and nobody notices**.

**More fundamentally**: the premise of that design is "there are two copies of the data that need reconciling". Under mutual exclusion, **that premise is false**.

## 2. ❌ A snapshot chain as the transport channel (`gen0001.db → gen0002.db → …` + manifest)

**Why rejected**: this was the first design I came up with, and I rejected it myself. It turns "the current state" into "a series of histories", so every boot has to answer "which generation do I continue from" — and that question needs a chain of trust between the manifest and the snapshots, while the manifest itself lives on the same unreliable volume. Go all the way around, and **the trust problem has not shrunk at all; you have merely added a layer of state**.

What was kept: `snapshots/` in the current protocol is **only a rollback anchor** (2 generations), not a transport channel. The current state is always exactly one thing: `db/state.db`.

## 3. ❌ Syncthing / rsync / cloud-drive sync

**Why rejected**:

- they assume both ends are online at once; on a dual boot **exactly one end is ever online**, so their sync queue becomes "replay a round of historical changes at every boot". For a single 145 MB binary file, that round usually degenerates into a whole-file transfer.
- their conflict handling for binary files boils down to "keep both", so you end up with `state.sync-conflict-20261026.db` — **two database files, and nobody knows which one is right**.
- most importantly: **they do not know that SQLite only constitutes a complete state once the WAL has been merged.** Syncing a database that is being written means syncing half a transaction (see [01·B1](01-failure-modes.en.md)).

## 4. ❌ git

**Why rejected**: every commit of a large binary file is a full copy; the repository balloons to several GB within no time; and git's merge capability is **completely useless** for a SQLite file (it cannot merge a single row). Never mind that committing a private database to a repository is a privacy incident in itself.

## 5. ❌ Export to markdown / JSON text, one copy per side

**Why rejected**: text really can be diffed and merged, but **the application may not be able to import it back reliably**, and the round trip loses fields (embeddings, time series, internal ids, foreign keys). Once both sides rebuild from the other's text, the application has to "re-learn" its own data — and every stateful field drifts.

**This one used to look beautiful**, because `*.md` is naturally readable and versionable. But it trades **data integrity** for **human readability**, and the whole value of this database is its integrity.

## 6. ❌ Use a different filesystem (put the database on NTFS, or on APFS)

**Why rejected**:

- **APFS / HFS+**: Windows cannot read it (there is no reliable production read-write driver).
- **NTFS**: macOS is read-only natively; third-party drivers (Paragon / Tuxera) are **kernel extensions**, which on a hackintosh are an entire additional class of risk (SIP, kext signing, silently breaking after a system update).
- **exFAT**: both sides read and write it natively — which is the only reason it was chosen. The price is everything written above this line.

> **If you genuinely care about the data and can accept the cost**: keep the database on each system's own native partition and move it at shutdown/boot with **copy + verify** (which is what this protocol's steps actually do), rather than having both sides open a file on the shared volume directly. Then at least **filesystem damage cannot simultaneously mean "my only copy is damaged"**. The cost is 2× the disk space and a 1–2 second copy (measured: 152 MB ≈ 1.2 s).
>
> This is a **variant of this protocol, and it is not implemented**, because the user explicitly required "both sides read the same physical file directly" (no working copies). It is written here because it genuinely is the safer option — just more verbose.

---

## 7. What changes if a second machine ever appears

Every "no sync needed" conclusion above **rests entirely on "only one system runs at a time"**. The moment any of the following holds, this document no longer applies:

- two machines might be on at the same time (even "a phone app can also write");
- several application processes on the same system write concurrently;
- the data goes onto a network (NAS / cloud drive / shared folder).

Then what you need is not this protocol but: **a single-writer server plus read-only client caches**, or **real conflict resolution at the application layer (CRDT / operation log)**. Moving files around cannot solve concurrent writing.

---

## 8. So where this design sits

> It is not "synchronising data"; it is **stamping a handoff**.
>
> Because dual boot has already solved the hardest concurrency problem for you, everything that remains is answering the question "can I trust this file" with **one hash, one receipt, one dirty marker**.

If a design makes you feel like "it barely does anything", that is probably correct — under mutual exclusion, the right amount of machinery is genuinely small. **The point is not the line count; it is the location and the ordering of those three files.**
