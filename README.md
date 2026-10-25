# exfat-handoff

**一台笔记本、两个操作系统（macOS + Windows 双系统）、只有一份数据文件，轮流开机。**
这个仓库记录的，是让这种布局**不丢数据**所需要知道的全部事情 —— 以及我在这台机器上实测出来的数字。

这是一个**方法论仓库**，不是一个同步工具：一份能照着实现的协议规范、一份出事那天照着做的恢复手册、一个零依赖的参考实现（`handoff.mjs`），外加一套可复现的实测脚本。它起源于我自己的 [mneme](#这个项目从哪来mneme) 记忆库，但协议本身跟 mneme 无关 —— 任何"单个 SQLite 状态文件放在双系统共享盘上"的场景都适用。

> ⚠️ **这不是同步工具。**
> 双系统永远不会同时开机，所以**不需要任何同步算法**：谁开机，谁独占那一个文件。
> 真正的敌人不是"两端数据不一致"，而是**"下一端无条件相信上一端留下的文件是好的"**。
> 一份放在共享盘上的 SQLite 数据库，在崩溃、强关机、卷未干净卸载之后，看起来完全正常，
> 直到你写进去一大批数据才发现它是坏的。这个仓库就是围绕这一件事写的。

<sub>English TL;DR — Field notes + a handoff protocol for keeping **one** SQLite database on an exFAT (or any journal-less) volume that two operating systems take turns mounting. Dual boot means mutual exclusion, so no sync algorithm is needed; what is needed is a *verified handoff*: checkpoint → integrity check → content hash → receipt, plus a dirty marker so the next boot knows whether it can trust the file. Measured facts, failure modes, protocol spec, recovery runbook, and a zero-dependency reference implementation (`handoff.mjs`, verified on real hardware). Docs are in Chinese; numbers are reproducible with `lab/`.</sub>

---

## 为什么值得写成文档

把数据库放到共享盘上这件事，说穿了就是两行：

```bash
ln -s /Volumes/Shared/state.db ~/.app/state.db     # macOS
mklink  C:\Users\me\.app\state.db X:\state.db      # Windows
```

**这两行会毁掉别人的数据库。** 它没有错，它只是没告诉你代价：

- exFAT 没有日志（journal），崩在写事务里坏的可能不只是这个文件，而是整卷；
- exFAT 没有 POSIX 权限，你的库对同机任何账户可读；
- exFAT 的时间戳粒度是 **2 秒**，跨系统的时钟还会偏 —— 你没法用 mtime 判断谁更新；
- 两端看到的是**同一份字节**，却带着**各自的缓存、各自的挂载状态、各自的崩溃恢复逻辑**。

所以这份文档的全部内容，就是给那两行加一个**能验证的信封**。

---

## 实测数据（Windows 侧，node 24 + SQLite 3.53.4）

复现方式见 [`lab/`](lab/)。全部是在真实的双系统共享 exFAT 卷上跑的，不是模拟。

| 属性 | 实测值 | 后果 |
|---|---|---|
| 卷格式 / 容量 | exFAT，数百 GB（余量充足） | 无日志、无权限、无硬链接 |
| 分配单元 | **128 KiB**（写 1 字节的文件也占 131,072 字节） | 快照链里塞一堆小文件等于白扔空间 |
| mtime 粒度 | **2.000 s**（5 秒内 20 次写入只产生 4 个不同时间戳） | ⚠️ **绝不能用时间戳判断新旧** |
| 大小写 | 不敏感：`CaseProbe.TXT` 与 `caseprobe.txt` 是同一个文件，写后者直接覆盖前者 | 路径校验、双份副本策略会互相踩 |
| POSIX 权限 | `chmod 0600` 之后实际 mode = `666` | ⚠️ 库对同机任何账户可读 |
| 符号链接 / 硬链接 | 均不支持（`EISDIR`, errno −4068） | 卷内不能做 link 布局 |
| 覆盖式 `rename` | **支持** | ✔ 原子替换可用（协议依赖它） |
| 独占创建 `open(..., 'wx')` | **支持**，第二个 writer 得到 `EEXIST` | ✔ 锁文件原语可用 |
| SQLite 跨进程锁 | **可用**：`delete` 与 `wal` 两种模式下第二进程均被拒（`database is locked`） | ✔ 单写者保护可用 |
| WAL | 可用；`wal_checkpoint(TRUNCATE)` 后 `-wal` 归零；干净关闭自动删除 `-wal`/`-shm` | 交接前必须显式 checkpoint |
| 提交成本 | `journal_mode=delete`：**4.9–5.2 ms/次**；`wal`：**1.4–1.6 ms/次**（300 次同步提交，两次运行） | WAL 快 ~3.5×，但代价是交接时必须处理 WAL 状态 |
| 152 MB 交接成本 | 读 97–474 ms + 写含 fsync 221–237 ms + sha256 校验 514–589 ms ≈ **0.9–1.2 秒**（第二次读命中了文件缓存） | 每次开关机付 1 秒左右，可接受 |
| ⚠️ WAL 文件是否落盘 | **子进程 WAL 模式提交 500 次后，磁盘上没有 `-wal`，数据已在主文件里**（复现 3 次） | 见结论 5：不要用 WAL 文件的存在性做任何判断 |
| 真实库体检 | 数百 MB（另有数 MB WAL）、page 4096、freelist 4.5%、22 张表、`integrity_check` = ok / 1141 ms | 这个规模的库，体检成本 1 秒级 |

### 五个结论

1. **锁是好的，时间戳是坏的。** SQLite 的跨进程锁在 exFAT 上工作正常，`rename`、`open(wx)` 也都能用 —— 协议需要的原语**都在**。唯一坏掉的是"文件多久没变"这个朴素判断，粒度 2 秒且跨系统不可比。**用内容哈希，永远别用 mtime。**
2. **权限这条没了。** `chmod 600` 是静默无效的。共享盘上的数据库是"这台机器上任何能登录的账户都能读"的。要么接受，要么把卷做成加密卷，别指望 `chmod`。
3. **大小写不敏感会造成"两个文件其实是一个"。** 任何按大小写区分副本、按路径做校验的设计，在这个文件系统上都是错的。
4. **WAL 让你更快，也让你多了一个必须在交接时处理的状态。** 干净关闭时 SQLite 自己会 checkpoint 并删除 `-wal`/`-shm`；但崩溃 / 强关机时不会。**交接流程的第一条永远是显式 `PRAGMA wal_checkpoint(TRUNCATE)`，不能指望"退出时它会自己弄好"。**
5. **一个没能解释的反常现象（重要）：** 子进程以 WAL 模式提交 **500 次**、不关闭、随后被 `SIGKILL` —— 全程磁盘上**没有 `-wal` 文件**，而数据已经全在 16 KB 的主文件里：另一个进程读得到 500 行，`integrity_check` = ok，`journal_mode` 仍报 `wal`。**复现 3 次。** 但同样操作在主进程里做时，`-wal` 确实存在（实测 12,392 与 1,351,392 字节两种情形）。
   两个候选解释，我没能证实：**(a)** 这是 node:sqlite（Node 内置驱动）的连接参数问题，与卷无关；**(b)** 是这个卷的写缓存行为让 WAL 帧"看起来"直接落地。要证伪需要拿原生 `sqlite3` CLI 在同一卷上做同一实验 —— 这是本仓库最欢迎的一个 PR。
   结论不依赖解释，反而因此更硬：**不要把「有没有 `-wal`」「`-wal` 多大」「主文件多大」当作任何判断依据。** 只信你自己算的哈希、你自己跑的 `integrity_check`、和你自己写的收据。

---

## 协议一句话

> **进之前先验，出之前先封；凡是没封的，一律不信。**

完整的规范（文件格式、状态机、原子性要求、轮转与回滚）在 [`docs/02-handoff-protocol.md`](docs/02-handoff-protocol.md)。核心只有三个东西：

- `state.db` —— 唯一真源，放在共享卷上；
- `handoff.json` —— 交接单（**收据**）：代次、来源端、关闭时间、大小、sha256、体检结果；
- `DIRTY` —— 脏标志：**打开时写、干净关闭时删**。下次开机看到它，说明上一次没好好收尾，直接进恢复流程，不要硬开。

代次（`gen`）是**你自己递增的整数**，不是时间戳 —— 因为时间戳在这个文件系统上不可信。

---

## 参考实现：`handoff.mjs`

零依赖，单个文件，Node ≥ 22（只用 `node:sqlite` / `node:crypto` / `node:fs`）。把它拷到任何地方就能跑，不需要 npm install。

```bash
node handoff.mjs open    <共享目录> --owner windows   # 开机后、开程序前
node handoff.mjs close   <共享目录> --owner windows   # 关程序后、关机前
node handoff.mjs status  <共享目录>                   # 只读：这个库现在能不能信
node handoff.mjs recover <共享目录>                   # 上次没收尾：体检 + 必要时回滚
```

元数据都在 `<共享目录>/.handoff/` 里，和你的数据放一起 —— 这样它跟着卷走，不会出现"收据在 A 盘、数据在 B 盘"的分裂。

| 退出码 | 含义 | 该做什么 |
|---|---|---|
| 0 | ok | 继续 |
| 10 | 存在 `DIRTY`，上次没干净收尾 | 跑 `recover` |
| 11 | 库的 sha256 与收据不符 | 跑 `recover`（可能是崩溃、也可能有人手改了库） |
| 12 | `integrity_check` 失败 | 跑 `recover`；坏库已改名进 `abandoned/`，**没删** |
| 13 | 没有收据（首次使用） | 按 `docs/02` §8 做首次迁移 |
| 14 | 协议版本不认识 | 别用新版本的脚本碰旧目录 |
| 20 | 拿不到写锁，还有进程开着这个库 | 停掉程序（含托盘/menubar 进程）再试 |
| 21 | `wal_checkpoint` 之后 `-wal` 没归零 | 别关机，先查是谁还在写 |
| 22 | 没有可用快照 | 看 `docs/03` §5 |
| 30 | 用法错误 | 看 `--help` |

**`close` 不会"尽力而为"。** 任何一步不过，它就不写收据、不删 `DIRTY`，宁可让你多跑一遍。这是故意的：一个"看起来干净"的库比一个"明确报错"的库危险得多。

实现在真实 exFAT 卷上跑过 13 个端到端场景（正常交接、二次打开、脏标志、健康库恢复、坏页检测、回滚、快照轮转、手改镜像、手改库、另一进程持锁），全部符合预期。坏库永远是**改名保留**，不是删除；快照是**写完再读回来算哈希**，不是写完就算数。

想自己看一遍？把仓库拉到共享盘上，一条命令：

```bash
node lab/handoff-selftest.mjs E:/_hstest     # 18 个断言，几秒钟
```

它会在你**那块卷**上造一个库，然后把它推过九种情形（含页级损坏与回滚），逐条核对退出码。看 `lab/README.md` 里的期望值表。

---

## 这个项目从哪来：mneme

这套东西不是凭空设计的，是为了解决一个具体问题：**我的 AI 记忆库（[`@modusensus/dsh-mneme`](https://github.com/slow-stack/mneme)，MIT）要在一台双系统笔记本的两个系统里读同一份 `memory.db`。**

所以最有说服力的证据是：它现在真的在跑。

```yaml
# 两端的 profile 配置里，指同一个物理目录
memoryDir: E:/mneme                      # Windows
memoryDir: /Volumes/Shared/mneme          # macOS，同一个目录
```

```bash
node handoff.mjs open  E:/mneme --owner windows   # 开机后
#   ... 用 DSH，记忆随便写 ...
node handoff.mjs close E:/mneme --owner windows   # 关 DSH + 停 daemon 后
```

mneme 自己保证了**进程内**的单写者（记忆巩固只装配在宿主进程里），管不到"上一次开机是另一个操作系统" —— 那个空洞正好是本协议补的那块。具体的接法、daemon（`dsh-mneme-serve`，默认 `127.0.0.1:8790`）为什么必须在 `close` 之前停掉、以及交接单元为什么是**整个目录**而不只是 `memory.db`，都在 [`docs/05-mneme-setup.md`](docs/05-mneme-setup.md)。

> 不用 mneme？那就只需要 `docs/01`–`04`。协议不认识 mneme，`handoff.mjs` 也不认识。

---

## 适用范围

**适合**

- 双系统 / 双启动的同一台机器，两个系统轮流开机（互斥）
- 数据在**单个文件**里（SQLite、KeePass、某些笔记库、git 仓库）
- 共享卷是 exFAT / FAT32 / NTFS（macOS 侧只读）等"没有 POSIX 语义"的文件系统
- 你愿意为每次开关机付 1~2 秒

**不适合**

- ❌ 两台机器**可能同时开机** —— 那是真正的并发写，需要真的冲突解决，不是这个协议
- ❌ 多个应用同时写同一个库
- ❌ 文件系统不支持原子 `rename`（那就没有安全落地的方式了）
- ❌ 你希望"零成本、无感" —— 这个方案的每一步都是有意的摩擦，摩擦就是保险

---

## 这个仓库里没什么

诚实说明我验证不了的部分，见 [`docs/01-failure-modes.md`](docs/01-failure-modes.md) 末尾的「未验证清单」。简短版：

- **macOS 侧全部未实测**（我只在 Windows 侧跑过）：exFAT 驱动的卸载行为、`.Spotlight-V100` / `.fseventsd` 的干扰、`lsof` 判活、真断电后的表现。
- **断电 / 拔盘未做破坏性实验**（不做，是因为它会真的毁掉我自己的库）。所以本文所有"崩溃"结论都来自 `SIGKILL` 强杀进程，不是断电 —— 两者的差别在于**文件系统自身的一致性**，而 exFAT 恰恰在这里没有日志。这一点是本文最大的已知盲区，请按"最坏情况比本文更糟"来读。
- **没有开机自动化。** 没写 systemd / launchd / 计划任务，也没法替你保证"`open` 一定先于程序启动"。两个系统各要一套，写错了比不写更糟，所以留给你。
- **没有卷身份校验。** 协议里（I7）要求认卷序列号而不是盘符，参考实现还没做 —— 把整个目录拷到另一块盘上它发现不了。
- **没有 GUI、没有守护进程、没有安装包。** 它是四个命令，就这样。

---

## 目录

| 文件 | 内容 |
|---|---|
| [`handoff.mjs`](handoff.mjs) | **参考实现**：`open` / `close` / `status` / `recover`，零依赖 |
| [`docs/01-failure-modes.md`](docs/01-failure-modes.md) | 失败模式清单：文件系统层 / SQLite 层 / 时序层 / 人为层 |
| [`docs/02-handoff-protocol.md`](docs/02-handoff-protocol.md) | **交接协议规范 v0**：收据、脏标志、状态机、回滚 |
| [`docs/03-recovery-runbook.md`](docs/03-recovery-runbook.md) | 出事那天照着做的手册（含"什么情况下不要救、直接回滚"） |
| [`docs/04-why-not-sync.md`](docs/04-why-not-sync.md) | 为什么**不做**同步：被否决的几种方案与理由 |
| [`docs/05-mneme-setup.md`](docs/05-mneme-setup.md) | 接到 mneme 上的具体做法（含 daemon 与目录级交接） |
| [`lab/`](lab/) | 可复现的探针脚本：上面那张表的每一行都能跑出来 |

---

## 许可

MIT。这些数字和这份协议，本来就是踩坑换来的，希望别人少踩一次。
如果你在自己的机器上测出不一样的数（尤其是 macOS 侧），请开 issue —— 那正是这份文档最缺的东西。
