# ✨ 05 · 在 mneme 上落地

<p>
  <a href="05-mneme-setup.en.md"><img alt="Read in English" src="https://img.shields.io/badge/English-30363d?style=flat-square&amp;logo=googletranslate&amp;logoColor=white"></a>
  <a href="05-mneme-setup.md"><img alt="中文" src="https://img.shields.io/badge/%E4%B8%AD%E6%96%87-2f81f7?style=flat-square&amp;logo=googletranslate&amp;logoColor=white"></a>
</p>

这份文档把前面四份的通用协议接到一个具体的东西上：**`@modusensus/dsh-mneme`（DSH 的记忆插件，MIT，[slow-stack/mneme](https://github.com/slow-stack/mneme)）**。

这个仓库就是在这个插件上长出来的：一台机器两个系统轮流开机，两边读同一份 `memory.db`。所以下面这些是实测过的，不是猜的。

> 只想知道通用做法（任何"单个 SQLite 状态文件"都适用）的话，看 [02-handoff-protocol.md](02-handoff-protocol.md)，不需要读本篇。

---

## 0. 一句话的分工

| | 负责什么 | 靠什么保证 |
|---|---|---|
| **mneme 自己** | 单进程内不并发写；崩溃后靠 WAL 回放 | 巩固（autoDream/autoSummarize）只装配在 DSH 宿主进程里 |
| **本协议** | **跨系统、跨启动**不信上一端留下的文件 | receipt（sha256）+ DIRTY + 回滚 |

mneme 的单写者保证是**进程级**的，管不到"上一次开机是另一个操作系统"。这个空洞就是本协议要补的那块。

---

## 1. 交接单元是整个目录，不是 memory.db

实测一个 `memoryDir`（0.9.4，用了几个月的真实库）里有：

```
memory.db            151,846,912 B
memory.db-wal          4,144,752 B      ← 必须一起处理，见 01-B2
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

那 8 个 `.md` 是**人可读镜像，而且是双向的**——mneme 会渲染出去，也会读回来合并（`generation` / `applied_generation`）。也就是说人会直接手改它们。

结论：交接的单元是**整个目录**。`handoff.json` 里的 `files_digest` 覆盖除 `memory.db*` 和 `.handoff/` 以外的所有文件，正是为此。

**但是**：镜像不一致时 `open` 只 warn，不 block（退出码仍是 0）。理由——手改镜像是 mneme 允许的正常操作，拦下来就是在替用户否决他自己的工具；而且镜像可再生成，`recoverMirror` 会自愈。代价写在下面第 4 节。

---

## 2. 三步接上

### Step 1 — 让 mneme 用共享目录

在 DSH 的 profile 配置里（`~/.dsh/profiles/<profile>/cordis.patch.yml`）：

```yaml
- id: dsh-mneme
  config:
    memoryDir: E:/mneme          # Windows
    # memoryDir: /Volumes/Shared/mneme    # macOS，同一个目录
```

两端写**同一个物理目录**，各自写成自己系统的路径。不要用 `~/.dsh/memory` 的默认位置——两端默认位置指向两块不同的盘，那才是"两份库各改各的"。

> 已经用了默认位置的：先按 [03-runbook](03-recovery-runbook.md) §0 原样留档，再改配置，第一次启动时按 02 §8 的 F1–F4 迁移。

### Step 2 — 开机后、启动 DSH 之前：open

```bash
node handoff.mjs open E:/mneme --owner windows     # macOS: --owner macos
```

退出码 0 才去开 DSH。其他任何退出码，先看 [03-runbook](03-recovery-runbook.md)。

`open` 会：读 receipt → 校验 db 的 sha256 和目录清单 → `quick_check` → `recover` 遗留的 `-wal`（如果上一端没清干净）→ **写 DIRTY**。

### Step 3 — 退出 DSH（含 daemon）之后：close

```bash
node handoff.mjs close E:/mneme --owner windows
```

`close` 会：拿写锁证明没有别人在用 → `wal_checkpoint(TRUNCATE)` 并**强制校验 `-wal` 归零** → `integrity_check` → 打快照并**回读校验** → 写 receipt → **最后**删 DIRTY。

失败时（退出码 10/11/12/20/21/22）它不会假装成功。**宁可让你多跑一遍，也不留一个"看起来干净"的库。**

---

## 3. 最难的一步：确认真的没人开着了

这是整件事唯一无法完全自动化的地方，也是我在这台机器上踩得最实的一处。

`close` 用 `BEGIN IMMEDIATE` 证明独占（实测：另一个进程持锁时确实拿到 `database is locked`，退出码 20）。但这只证明**那一瞬间**没有写事务在跑，不证明没有进程**开着**这个库等下一次写。

而 mneme 恰好有一个东西会长期开着库：**`dsh-mneme-serve`（daemon，数据面，默认 `127.0.0.1:8790`）**。它能写——`saveWithDedupe`、镜像渲染、`/maintenance/reclaim` 都会写。

所以顺序必须是：

```
关 DSH  →  停 daemon  →  close  →  关机
```

确认没有残留进程：

```powershell
# Windows
Get-NetTCPConnection -LocalPort 8790 -ErrorAction SilentlyContinue
Get-Process node -ErrorAction SilentlyContinue | Select-Object Id,StartTime
```

```bash
# macOS
lsof /Volumes/Shared/mneme/memory.db
```

两条都得是空的。**别信任务栏/menubar 里没图标就算关了**——托盘进程是最常见的漏网者，这也是 `handoff.mjs` 在 20 号退出码里专门提它的原因。

如果 daemon 还在跑而你先跑 close 了：close 有机会成功（它空闲时没有事务），然后 daemon 在 close 之后再写一笔 → 那一笔没有进 receipt → 下次开机 `open` 报 sha256 不匹配（退出码 11）。**数据不会错，但你会被要求做一次 recover。** 这就是"安全失败"该有的样子，不是数据损坏。

### reclaim / VACUUM 的位置

`/maintenance/reclaim`（VACUUM + 分析）会拿排他锁、跑得久、并且**改写整个文件**。放在 close 之前、且打完就重新 close 一次；或者干脆放到"这次开机不打算再开 DSH"的时候做。别在两个动作中间跨交接。

---

## 4. 已知简化（这是我的实现没做的，不是协议的漏洞）

诚实清单：

1. **没实现 I7（卷识别）**。协议里说认卷要认序列号不认盘符，`handoff.mjs` 目前只在 receipt 里记了 owner 和路径，没记卷序列号。后果：把整个目录拷到另一块盘上，它不会发现。
2. **没做开机自动化**。systemd / launchd / 计划任务和"谁来保证 open 一定先于 DSH"没做，两头都要手写，而两个系统各一套；留给人，因为写错了比不写更糟。
3. **检测不到"DSH 没开但 daemon 开着"**。只能检测库锁，检测不到"某个进程开着库但此刻没事务"。见第 3 节，靠人工确认。
4. **镜像被手改只 warn**。见第 1 节的理由。如果你要求"镜像也必须逐字节对得上"，把 `open` 里那条 warn 改成 block 就行（一个 `process.exit`）。
5. **`-.shm` 不校验**。它本来就是跨进程共享内存，跨启动无意义；`close` 清掉、`open` 重建。

没有做破坏性实验：真拔电源、真在写事务中途断电，这台机器上只有一份在用库，不敢拿它做。所以 01-C 那一类（时序/断电）标的是 [推理]，不是 [实测]。

---

## 5. 一次完整的日常（复制粘贴用）

```bash
# 开机（Windows 为例）
node handoff.mjs open  E:/mneme --owner windows     # 0 = 可以开 DSH
# ... 用 DSH，中间随便写记忆 ...
# 收工
#   1) 退出 DSH（含托盘）
#   2) 确认 daemon 停了（第 3 节两条命令都是空的）
node handoff.mjs close E:/mneme --owner windows     # 0 = 干净封箱，可以关机
```

macOS 那头把 `E:/mneme` 换成 `/Volumes/<你的卷>/mneme`、`--owner` 换成 `macos`，其余一模一样。
