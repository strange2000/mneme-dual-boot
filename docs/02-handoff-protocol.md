# 02 · 交接协议规范 v0

> **一句话**：进之前先验，出之前先封；凡是没封的，一律不信。
> **适用**：同一台机器、两个操作系统轮流开机（互斥），数据是共享卷上的单个文件。
> **不适用**：两端可能同时开机 —— 那是并发写，需要真正的冲突解决，本协议不解决。

---

## 0. 设计目标与非目标

**目标**

1. 任何一次开机，都能在**打开应用之前**判断出"这个文件能不能信"。
2. 任何一次关机，都能让下一次开机的判断**有据可查**（收据里有哈希）。
3. 一旦判断为"不能信"，有**一条不丢数据**的路（保留被丢弃的文件 + 回滚到上一代快照）。
4. 全部判断只依赖 **内容哈希 + 自己递增的代次**，不依赖时间戳、不依赖 `-wal` 是否存在。

**非目标**

- 不做双端数据合并（互斥前提下没有可合并的东西）。
- 不做并发写保护（同一系统内交给 SQLite 的锁，跨启动交给 `DIRTY`）。
- 不保证 exFAT 卷本身不坏（做不到，只能在坏之后**发现**它）。

---

## 1. 目录布局

共享卷上，一个自包含的目录：

```
<shared>/state/
├── db/
│   ├── state.db                 # 唯一真源
│   ├── state.db-wal             # 瞬态，交接时应为 0 字节或不存在
│   └── state.db-shm             # 瞬态
├── handoff.json                 # 收据（最后一次干净交接）
├── DIRTY                        # 脏标志：打开时写，干净关闭时删
└── snapshots/
    ├── gen0041.db
    ├── gen0041.sha256
    └── gen0042.db
    └── gen0042.sha256
```

不要在这块盘上放小文件（分配单元 128 KiB，见 [01](01-failure-modes.md#a6-分配单元-128-kib-实测)）。`snapshots/` 只保留 **2 代**。

---

## 2. 文件格式

### 2.1 `handoff.json` —— 收据

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

- `owner` 是端名（`windows` / `macos`），只用于**人类阅读和日志**，不参与判断。
- `closed_at*` **仅供参考**，不参与任何排序或比较（时间戳不可信，见 01·A3）。
- `gen` 是唯一的顺序依据。
- `content_digest` 可选，用于发现"结构完好但内容被替换/回退"（见 01·B4）。

### 2.2 `DIRTY` —— 脏标志

```json
{ "protocol": 1, "owner": "windows", "gen": 43, "opened_at": "2026-10-26T09:12:03+08:00", "pid": 8812 }
```

内容写清楚只是方便排查。**判断只看它存在与否。**

---

## 3. 不变量

| # | 不变量 | 为什么 |
|---|---|---|
| I1 | 同一时刻最多一个 owner | 互斥是全部前提 |
| I2 | `gen` 单调递增；**回滚也 +1** 并置 `rollback: true` | 代次一旦倒退，`handoff.json` 就失去可比性 |
| I3 | `handoff.json` 必须是**写临时文件 + fsync + rename 覆盖** | exFAT 支持覆盖式 rename（实测），但 write-in-place 会在断电时留半个 JSON |
| I4 | `DIRTY` 的创建在**打开数据库之前**，删除在**关闭数据库之后** | 反过来就有"打开了但没留痕"的窗口 |
| I5 | 判断"变没变"只允许用 sha256；**禁止**用 mtime、size、`-wal` 存在性 | 01·A3 / 01·B5 |
| I6 | 回滚不得删除被放弃的库，改名保留至少 1 代 | 回滚是数据删除，必须可逆 |
| I7 | 认卷靠**卷序列号/UUID**，不靠盘符或挂载点 | 01·C4 |
| I8 | 快照写完必须回读校验 sha256 | exFAT 上写成功不代表读得回来 |

---

## 4. 开机：打开序列（Open）

前置：卷已挂载且序列号匹配（否则**拒绝启动**，不要退回到本地目录静默建一个新库 —— 那是最常见的"记忆凭空消失"）。

```
O1  应用必须未运行（判活：能独占打开 db/state.db）
        └─ 失败 → 拒绝，提示"应用还在跑"

O2  DIRTY 存在？
        ├─ 是 → 上一次没干净收尾 → goto 恢复序列 R
        └─ 否 → 继续

O3  handoff.json 存在且 protocol ≤ 本机支持的版本？
        ├─ 不存在 → 首次接管 → goto 首启序列 F
        └─ 版本更高 → 拒绝（旧端不要碰新端写的库）

O4  计算 db/state.db 的 sha256，与 handoff.json.db.sha256 比较
        ├─ 不等 → 文件在系统之外被改过 → goto 恢复序列 R
        └─ 相等 → 继续

O5  PRAGMA quick_check  → 必须为 ok
        └─ 否则 → goto 恢复序列 R

O6  写 DIRTY（含本次 gen、owner、pid）
        └─ 必须 fsync 并确认落盘后才继续

O7  打开数据库，正常工作
```

**为什么 O6 在 O7 之前**：如果先打开再写标志，断电窗口里就会出现"库被写了、但没人知道"的状态，而这个状态正是下次开机唯一要防的东西。

---

## 5. 关机：关闭序列（Close）

触发时机：用户主动退出应用 / 系统注销 / 关机脚本。**无法保证**在强制断电时执行 —— 所以它必须让"没执行"这件事**可被下次发现**（这就是 `DIRTY` 到下次才被删的原因）。

```
C1  让应用真正退出，并确认能独占打开 db/state.db（句柄全放）

C2  PRAGMA wal_checkpoint(TRUNCATE)
        └─ 结果 busy 必须为 0，checkpointed 归零后 -wal 字节数必须为 0
        └─ 若 busy != 0 → 还有别的连接在读写 → 中止关闭（保持 DIRTY 不删），
           提示"还有进程占用"，不要硬封

C3  PRAGMA integrity_check  → 必须 ok
        └─ 否则 → 不要写收据；把库改名保留 → goto 恢复序列 R

C4  新代次 g = gen + 1
    复制 db/state.db → snapshots/gen<g>.db（000 表示 g 补齐 4 位）
    回读快照计算 sha256 → 写入 snapshots/gen<g>.sha256（含字节数）
        └─ 校验不等 → exFAT 写入不可信 → 中止，保持 DIRTY

C5  计算 db/state.db 的 sha256 与字节数

C6  原子写 handoff.json：写 handoff.json.tmp → fsync → rename 覆盖 handoff.json
        gen=g, owner=本端, clean 的体检结果

C7  删除 DIRTY          ← 必须是最后一步
    （然后可选：删除 gen < g-1 的快照，只留 2 代）
```

**C7 是收尾的"盖章"动作。** 只有它成功了，下一次开机才会认为这个文件可信。中间任何一步失败，`DIRTY` 都还在 —— 这正是我们要的：**宁可让下次开机走恢复流程，也不要让它以为一切正常。**

---

## 6. 恢复序列（Recover）

进入条件：`DIRTY` 存在，或 sha256 不匹配，或 `quick_check` 失败。

```
R1  锁住整个流程（在 state/ 下建 RECOVERING 标记，防止并发）

R2  体检当前 db/state.db：
      PRAGMA integrity_check（全量，不是 quick）

R3  决策表 ↓
```

| 情况 | 判断 | 动作 |
|---|---|---|
| `integrity_check` = ok | 结构完好 | **保留当前库**（它含最新数据），把当前库复制成 `snapshots/gen<g+1>.db` 作为新的回滚锚点，写收据（`rollback:false`），日志记一条"上次未干净关闭，已体检通过"。**不要**因为看到 DIRTY 就回滚 —— 那会丢掉整段工作 |
| `integrity_check` 失败 | 结构已坏 | 依次尝试 `snapshots/` 里**从新到旧**的快照：验证 `.sha256` → `integrity_check`。用第一个通过的替换 `db/state.db`（**先 rename 现库为 `db/state.db.abandoned-<gen>-<时间>`，不删除**），`gen+1` 且 `rollback: true` |
| 所有快照都失败 | 无路可走 | **停下来**。把现场整个目录复制一份留档，报告用户，附上 `abandoned-*` 与各快照的体检结果。不要试图"修" —— 那会把证据弄没 |
| `integrity_check` 通过但 `content_digest` 明显变小 | 可能被回滚过 | 保留当前库，但**向用户报告**（这是 01·B4 的补丁：只有哈希和体检都通过时，才会注意到"内容少了"） |

```
R4  收尾：写 handoff.json（含 rollback 标记）→ 删除 DIRTY → 删除 RECOVERING
R5  开机后**必须**向用户显示一条人类可读的结论：
      "上一次（windows）没有正常关闭。/ 体检通过，已继续，未丢数据。" 
      "已回滚到 gen0041，被放弃的库在 db/state.db.abandoned-…（未删除）"
```

> **R5 不是可选的。** 这个协议最危险的失败方式是"悄悄回滚、悄悄继续"，然后一周后才发现记忆少了一大块。

---

## 7. 首次接管（First run / 迁移）

```
F1  共享卷上没有任何 state/ → 由当前端把它现有的库**复制**（不是移动）进来
F2  在 state/ 下写一个 provenance 文件：来源端、来源路径、原始 sha256、时间
F3  走一次完整的关闭序列（C2–C7），得到 gen=1 的收据与快照
F4  原库留在原处**不删除**，至少保留到另一端成功打开过一次
```

迁移期两端都不许直接改原库。这一步做错的经典后果：两端各自"迁移"了一次，最后共享盘上那份是后来者的，前者的历史只存在它的原库副本里。

---

## 8. 状态机

```
                 ┌────────────┐
   开机 ────────►│  CHECKING  │
                 └─────┬──────┘
        DIRTY / hash 不符 / 体检失败
                 │            │ 全部通过
                 ▼            ▼
           ┌──────────┐  ┌──────────┐
           │RECOVERING│  │  OPENED  │◄── 写 DIRTY
           └────┬─────┘  └────┬─────┘
      回滚/继续  │             │ 用户退出
                └──────┬──────┘
                       ▼
                 ┌──────────┐
                 │ CLOSING  │  checkpoint → 体检 → 快照 → 收据
                 └────┬─────┘
              成功    │    失败（任一步）
                      ▼         │
                 ┌─────────┐    │ DIRTY 保留
                 │ SEALED  │    └──► 下次开机进 RECOVERING
                 └─────────┘
              （删 DIRTY）
```

---

## 9. 最小实现要点（伪代码）

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
    assert wal_bytes(root) == 0, "还有连接占用，拒绝封口"
    assert db.exec("PRAGMA integrity_check") == "ok"       # C3
    g = last_gen(root) + 1
    copy_verify(root/"db/state.db", root/f"snapshots/gen{g:04d}.db")   # C4 / I8
    rec = {..., "gen": g, "db": {"sha256": sha256(...), "bytes": ...}} # C5
    atomic_write(root/"handoff.json", rec, fsync=True)     # C6 / I3
    (root/"DIRTY").unlink()                                # C7 最后一步
```

---

## 10. 这个协议**不**保护什么

- ❌ **exFAT 卷本身的结构损坏**（断电后簇链坏掉、`fsck_exfat` 擅自"修"）。协议只能在事后**发现**，不能预防。想真正防，就别用 exFAT —— 用有日志的文件系统，或者别共享。
- ❌ **权限泄露**（01·A2）。库在 exFAT 上是全局可读的。
- ❌ **两端同时开机**时的并发写。
- ❌ **应用自己的 bug**（比如它把库写到一半就崩）。协议只保证"下一次开机知道该不该信"。
- ❌ **用户无视警告硬开**。如果恢复流程给出结论没人看，这个协议就退化成"一个会写 json 的脚本"。
