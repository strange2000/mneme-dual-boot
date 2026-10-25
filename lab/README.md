# 🧪 lab/ · 可复现的探针

<p>
  <a href="README.en.md"><img alt="Read in English" src="https://img.shields.io/badge/English-30363d?style=flat-square&amp;logo=googletranslate&amp;logoColor=white"></a>
  <a href="README.md"><img alt="中文" src="https://img.shields.io/badge/%E4%B8%AD%E6%96%87-2f81f7?style=flat-square&amp;logo=googletranslate&amp;logoColor=white"></a>
</p>

这四个脚本产出 README 表格里的每一个数字，并验证 `handoff.mjs` 的行为。**请在自己的卷上跑一遍** —— 我的数字只属于我这块盘：macOS 上的 mtime 粒度就和我这块盘差了 200 倍。

```bash
# 目录参数必须是**共享卷上**的路径，脚本会创建并删除自己的临时文件
node lab/exfat-probe.mjs  /Volumes/Shared/_probe      # macOS
node lab/exfat-probe.mjs  X:\_probe                   # Windows

node lab/crash-probe.mjs  /Volumes/Shared/_probe

node lab/handoff-selftest.mjs /Volumes/Shared/_hstest # 18 个断言，几秒钟

node lab/b5-gc.mjs         /Volumes/Shared/_b5gc        # B5 的成因：A/B/C 三组对照
```

要求：**Node ≥ 22**（用的是内置 `node:sqlite`，不需要装任何依赖 —— 这也是选它的原因：一个裸 Node 就能复现，不用 `npm i`）。

四个脚本都只在自己创建的目录里活动，结束时会删掉（`--keep` 可保留）。`exfat-probe.mjs` 会把结果写成 `./exfat-probe-result.json`（本目录里那份是 **Windows 侧**的原始输出）；**macOS 侧**在 `./exfat-probe-result-macos.json`，其中三项探针原始值是错的，重测值与理由写在它的 `corrections` 段里。

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

> 📱 **macOS 侧的数字不一样，而且差别不小**：完整结果见 [`exfat-probe-result-macos.json`](exfat-probe-result-macos.json)。三处关键差异 —— mtime 粒度 **10 ms**（不是 2 s）；`chmod` 是**彻底空操作**但 mode 恒报 `0o700`，所以探针的 `permissions_enforced` 在 macOS 上是**假阳性**；**符号链接能建**（`EISDIR` 只在 Windows 上出现）。

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

**读法**：在 WAL 模式下提交了 500 行、进程还活着，磁盘上却**根本没有 `-wal` 文件**，数据已经在 16 KB 的主文件里。

这个现象当初被记成"无法解释"，现在查清了：**不是卷，是 V8 的垃圾回收。**

`node:sqlite` 的连接会在 `DatabaseSync` 对象被 GC 回收时关闭。这个子进程写完信号文件就开始空转，**之后再没引用过句柄** → 句柄不可达 → 被回收 → 连接被关闭。而连接关闭对 SQLite 就是一次**干净的 close**：先把 WAL checkpoint 进主文件，再删掉 `-wal`/`-shm`。父进程采到的正是"关闭之后"的终态，于是看起来像 WAL 帧被卷直接吞了。

`b5-gc.mjs` 把它做成了 A/B/C，一条命令就能证实：

```bash
node lab/b5-gc.mjs /Volumes/Shared/_b5gc
```

| 变体 | exFAT | APFS |
|---|---|---|
| A：`h` 之后不再被引用（`crash-probe` 原样） | `-wal` 消失 **3/3** | 消失 **2/2** |
| B：加一句 `globalThis.__keep = h` | 消失 **0/3** | 消失 **0/2** |
| C：显式 `h.close()` | 消失 3/3，盘上终态与 A 一致 | 同 |

唯一变量是 **JS 句柄是否还被引用**；文件系统、`journal_mode`、`synchronous`、显式事务都被分别排除（那些组合下 `-wal` 始终 2,080,632 B、主文件始终 4,096 B）。所以原来那两个候选解释 —— (a) 连接参数、(b) 卷写缓存 —— **都不成立**。

**协议的做法不变，而且理由更硬**：不要推理 WAL 的状态，显式 `wal_checkpoint(TRUNCATE)`，然后再算哈希、再体检、再写收据。另外，判活要用 `lsof +D <目录>`，不要用 `kill -0` —— 进程完全可能还活着，但已经把库关了。

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

**它不能证明什么**：这是脚本自己造的数据，不是你的库。它在 macOS 上也跑过一遍（`all good: 18 passed, 0 failed`），但两端跑的都还是"脚本造的小库"，不能代替拿你自己那份真库演练。真正的演练仍然是 [../docs/03-recovery-runbook.md](../docs/03-recovery-runbook.md) §0：先留档一份，再动手。

---

## 注意

- 这四个脚本**会**在卷上创建/删除文件。不要指向你的生产目录，指一个空目录。
- `crash-probe.mjs` 会 `SIGKILL` 它自己启动的子进程 —— 不要改成本进程，那会把你自己杀掉。
- 我把 `stdio` 设成 `'ignore'`、用文件做回传，是因为某些沙箱禁止进程间管道。普通环境用管道也行，但文件更可靠。`handoff-selftest.mjs` 同理（子进程输出写进 `.selftest-child.log`）。
