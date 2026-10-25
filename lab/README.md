# lab/ · 可复现的探针

[English](README.en.md) ｜ 中文（本文）

这三个脚本产出 README 表格里的每一个数字，并验证 `handoff.mjs` 的行为。**请在自己的卷上跑一遍** —— 我的数字只属于我这块盘。

```bash
# 目录参数必须是**共享卷上**的路径，脚本会创建并删除自己的临时文件
node lab/exfat-probe.mjs  /Volumes/Shared/_probe      # macOS
node lab/exfat-probe.mjs  X:\_probe                   # Windows

node lab/crash-probe.mjs  /Volumes/Shared/_probe

node lab/handoff-selftest.mjs /Volumes/Shared/_hstest # 18 个断言，几秒钟
```

要求：**Node ≥ 22**（用的是内置 `node:sqlite`，不需要装任何依赖 —— 这也是选它的原因：一个裸 Node 就能复现，不用 `npm i`）。

三个脚本都只在自己创建的目录里活动，结束时会删掉（`--keep` 可保留）。`exfat-probe.mjs` 还会把结果写成 `./exfat-probe-result.json`（本目录里那份就是我这次运行的原始输出），方便直接贴进 issue。

---

## exfat-probe.mjs —— 文件系统与 SQLite 能力

| 测的东西 | 为什么重要 | 我这块盘的实测 |
|---|---|---|
| `mtime_granularity_seconds` | 决定你能不能靠时间戳判断新旧 | **2.000 s**（5 秒 20 次写入只有 4 个不同 mtime） |
| `case_insensitive` / `case_collision` | 大小写不同的两个"文件"可能是同一个 | `true` / 写小写名直接覆盖大写名 |
| `mode_after_chmod_0600` | 能不能给库设权限 | `0o666`（`chmod` 静默无效） |
| `links` | 卷内能不能做符号链接/硬链接布局 | `EISDIR / -4068`，两个都不行 |
| `rename_over_existing` | 协议 I3（原子写收据）依赖它 | `ok` ✔ |
| `exclusive_create_wx` | 锁文件/单写者原语 | `blocked: EEXIST` ✔ |
| `journal_mode_roundtrip` | 哪些模式真的能设上 | delete/truncate/persist/wal 全部接受 |
| `commit_cost_300_sync_commits` | 交接前该选哪种模式 | delete **4.9–5.2 ms**，wal **1.4–1.6 ms** |
| `wal_checkpoint_truncate` | 交接第 1 步能不能真的清空 WAL | `{busy:0, log:0, checkpointed:0}`，随后 `-wal` = 0 字节 ✔ |
| `transient_files_after_clean_close` | 干净关闭后还剩什么 | 全都没了 ✔ |
| `handoff_152MiB` | 一次交接的实际代价 | 读 97–474 + 写 221–237 + 校验 514–589 ms ≈ **0.9–1.2 s** |
| `one_byte_file_allocated_bytes` | 小文件有多浪费 | **131,072**（128 KiB 簇） |

## crash-probe.mjs —— 热拷贝与强杀

它在子进程里以 WAL 模式提交 500 行，然后在子进程仍然活着、从未 checkpoint 的情况下，做两件事：

1. **只复制 `state.db`**（丢掉 `-wal`/`-shm`），看这份"朴素交接"里有多少行 —— 这就是"忘了 `-wal`"的真实后果；
2. **`SIGKILL` 子进程**，看磁盘上剩下什么、下一次开机能不能读。

我这里的输出（**注意：和直觉不符**）：

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

**读法**：在 WAL 模式下提交了 500 行、进程还活着，磁盘上却**根本没有 `-wal` 文件**，数据已经在 16 KB 的主文件里。复现 3 次。

这与 WAL 的契约不符，我没能解释。两个候选：

- **(a)** 是 `node:sqlite`（Node 内置驱动）的连接参数问题，与卷无关；
- **(b)** 是这个卷的写缓存行为让它"看起来"直接落地。

**怎么证伪**：在同一块卷上，用原生 `sqlite3` CLI（或 Python `sqlite3`）做同一实验：

```bash
sqlite3 probe.db "pragma journal_mode=wal; create table t(x); insert into t values(1);"
ls -l probe.db*        # WAL 模式下执行完 insert 后，-wal 应该存在且非空
```

如果那边 `-wal` 正常存在，就是 (a)，请开 issue 并附上两边的输出；如果那边也没有，那这个卷的行为比本文写的更值得警惕。

**无论结论是 (a) 还是 (b)，协议的做法不变**：不要推理 WAL 的状态，显式 `wal_checkpoint(TRUNCATE)`，然后再算哈希、再体检、再写收据。

---

## handoff-selftest.mjs —— 参考实现的行为验证

```bash
node lab/handoff-selftest.mjs X:\_hstest
```

它在 `<dir>/selftest` 里造一个 500 行的小库，然后把 `handoff.mjs` 推过九种情形，逐条断言**退出码**（不是"看起来成功了"）：

| # | 情形 | 期望 |
|---|---|---|
| 2 | 首次运行没有收据 | `status` 说"no receipt"、`open` = **13**；`close` 之后建立基线 |
| 3 | 没 close 就再 open | **10**（脏标志起作用了） |
| 4 | 脏但健康 → recover | **0**，500 行全部保留（**不回滚**，因为库里才是最新的） |
| 5 | 干净 close | **0**，代次 +1，快照保留 2 份 |
| 6 | 库被外部改过 | **11**（sha256 不符） |
| 7 | 页级损坏 → recover | **0**，回滚到校验过的快照，500 行回来了，**坏库被改名保留** |
| 8 | 手改镜像 `.md` | `open` 仍 **0**，但明确 warn |
| 9 | 快照轮转 | 始终 ≤ 2 份 |

我这块盘上的结果：

```
all good: 18 passed, 0 failed
```

**它不能证明什么**：这是脚本自己造的数据，不是你的库；它跑在你这块卷上，但**不会**验 macOS 侧的行为（那需要真的开机进 macOS）。真正的演练仍然是 [../docs/03-recovery-runbook.md](../docs/03-recovery-runbook.md) §0：先留档一份，再动手。

---

## 注意

- 这三个脚本**会**在卷上创建/删除文件。不要指向你的生产目录，指一个空目录。
- `crash-probe.mjs` 会 `SIGKILL` 它自己启动的子进程 —— 不要改成本进程，那会把你自己杀掉。
- 我把 `stdio` 设成 `'ignore'`、用文件做回传，是因为某些沙箱禁止进程间管道。普通环境用管道也行，但文件更可靠。`handoff-selftest.mjs` 同理（子进程输出写进 `.selftest-child.log`）。
