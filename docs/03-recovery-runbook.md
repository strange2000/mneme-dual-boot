# 03 · 出事那天照着做

[English](03-recovery-runbook.en.md) ｜ 中文（本文）

> 前提：你已经把库放在共享盘上，现在它可疑了。
> **第一原则：在动任何东西之前，先把现场原样复制一份。** 后面所有步骤都可逆，但"修"这个动作本身会毁掉证据。

---

## 0. 先做这个（30 秒，任何情况下都先做）

```bash
# 把整个 state/ 原样复制到**本地盘**（不要复制到共享盘，别覆盖任何东西）
cp -a /Volumes/Shared/state ~/state-backup-$(date +%Y%m%d-%H%M%S)
```

Windows（PowerShell）：

```powershell
$dst = "$env:USERPROFILE\state-backup-" + (Get-Date -f yyyyMMdd-HHmmss)
robocopy "X:\state" $dst /MIR /R:0 /W:0
```

**如果这一步因为"文件被占用"失败**，说明应用还在跑 —— 先退干净（含托盘），再重试。别用"复制出来一份能读的就行"糊弄过去：你要留下的是**原始不可读状态**，那才是证据，也是唯一可能恢复的东西。

---

## 1. 先判断是哪一类（不要跳步）

```
① 共享卷挂载了吗？盘符/挂载点对吗？卷序列号对吗？
   ├─ 没挂载 / 序列号不对 → 【不要创建任何新库】→ 修挂载，回到 ①
   └─ 已挂载 → ②

② state/DIRTY 存在吗？
   ├─ 存在 → 上一次没干净收尾 → 走 §2
   └─ 不存在 → ③

③ 库能打开吗？（只读打开，别写）
   ├─ 打不开（malformed / not a database） → 走 §3
   └─ 能打开 → ④

④  sha256 与 handoff.json 一致吗？
   ├─ 一致 → 一切正常，直接用（DIRTY 不存在 + 哈希一致 = 干净交接）
   └─ 不一致 → 走 §3
```

只读打开、绝不写入的方式：

```bash
sqlite3 "file:/Volumes/Shared/state/db/state.db?mode=ro&immutable=1" "PRAGMA integrity_check;"
```

> `immutable=1` 的意思是"我保证不会有人写它"。**只有在确认应用已退出、且你只是要看一眼时才用**。用了 `immutable` 而其实有别的进程在写，你会读到不一致的快照。

---

## 2. `DIRTY` 存在 —— 上次没干净关闭

这是**最常见**的情况，而且**大多数时候并不需要回滚**。

### 2.1 先体检，别急着回滚

```bash
sqlite3 -readonly "/Volumes/Shared/state/db/state.db" "PRAGMA integrity_check;"
```

| 结果 | 动作 |
|---|---|
| `ok` | **直接继续用**。把当前库复制成新快照（`snapshots/gen<g+1>.db`）作为锚点，写收据（`rollback:false`），删 `DIRTY`。日志写一条"上次未干净关闭，体检通过"。 |
| 不是 `ok`（一堆 `*** in database main ***` / `Page N is never used` 之类） | 走 §3 |
| 直接报 `malformed` / 打不开 | 走 §3 |

⚠️ **"看到 DIRTY 就回滚"是本协议最容易犯的错。** DIRTY 只说明"没人盖过章"，不说明"库坏了"。无脑回滚会把你上一整段工作扔掉。

### 2.2 顺便确认"内容没少"

结构 ok ≠ 数据没丢（见 [01·B4](01-failure-modes.md#b4-integrity_check-通过--数据完整-推理但很重要)）。跟上一份收据里的 `content_digest` 对一下：

```bash
sqlite3 -readonly "…/state.db" "SELECT COUNT(*) FROM sqlite_master WHERE type='table';"
# 行数按你自己的表来，例如：
sqlite3 -readonly "…/state.db" "SELECT COUNT(*) FROM <你的主表>;"
```

如果行数**明显比收据里少**，说明中间发生过一次回滚或替换 —— 别继续用，按 §4 找 `abandoned-*`。

---

## 3. 库坏了 / 哈希不符 —— 走回滚

### 3.1 保住现场

```bash
cd /Volumes/Shared/state/db
mv state.db "state.db.abandoned-$(date +%Y%m%d-%H%M%S)"      # 改名，不删！
rm -f state.db-wal state.db-shm state.db-journal             # 这些是瞬态，但先把上面那份挪走再动
```

> 瞬态文件（`-wal`/`-shm`/`-journal`）**不要**一起改名保留 —— 它们只对"原来的主库"有意义。如果你怀疑主库还能救，就把三个一起原样复制到别处再动手。

### 3.2 从新到旧找一份能用的快照

```bash
cd /Volumes/Shared/state/snapshots
for f in $(ls -r gen*.db); do
  echo "=== $f"
  echo "$(cat ${f%.db}.sha256 2>/dev/null)  $f" | sha256sum -c - 2>&1 | head -1
  sqlite3 -readonly "file:$PWD/$f?mode=ro&immutable=1" "PRAGMA integrity_check;" 2>&1 | head -3
done
```

选**最新的一份 sha256 与 integrity_check 都通过**的。

### 3.3 落地

```bash
cp -a gen0041.db ../db/state.db
# 立刻验证复制品（exFAT 上写成功不代表读得回来）
sqlite3 -readonly "../db/state.db" "PRAGMA integrity_check;"
```

然后写收据：`gen = 42`（**不倒退**），`rollback: true`，`db.sha256` 重算，`owner` 写当前端。删 `DIRTY`。

### 3.4 告诉用户（必须）

> 上一次（windows）没有正常关闭，库已损坏。
> 已回滚到 gen0041（macos，2026-10-25 23:35）。
> **被放弃的库没有删除**：`db/state.db.abandoned-20261026-021500`。
> 这中间一个多小时的数据需要人工从 abandoned 里捞。

**如果这一条不告知，"回滚"就等于"静默删除这段记忆"。**

---

## 4. 从 `abandoned-*` / 旧快照里捞数据

```bash
sqlite3 -readonly "abandoned.db" ".tables"
sqlite3 -readonly "abandoned.db" ".schema <表名>"
sqlite3 -readonly "abandoned.db" "SELECT * FROM <表名> ORDER BY rowid DESC LIMIT 20;"
```

捞的时候注意：

- **只读打开**（`-readonly`），且尽量在本地盘的副本上操作 —— 别在共享盘上对一个坏库跑写操作。
- 时间字段不可信（01·A3），排序用自增主键 / rowid / 你自己的序列表。
- 捞出来的东西**不要**直接 `INSERT` 回主库：先导出成文本，人工看过再合并。

---

## 5. 所有快照都不行 —— 停下来

这时候你能做的只有：

1. 把整个 `state/` 目录复制到本地盘留档（两处：一处只读备份，一处用来试）。
2. 报告：每一份快照的体检结果、文件大小、`handoff.json` 历史。
3. 用 `sqlite3 .recover` 在**副本**上试：

```bash
cp abandoned.db /tmp/try.db
sqlite3 /tmp/try.db ".recover" | sqlite3 /tmp/recovered.db
sqlite3 /tmp/recovered.db "PRAGMA integrity_check;"
```

`.recover` 能从不完整的库里尽可能多地捞出页面级数据，**它不是修复，是打捞**。捞出来的库结构可能是拼凑的，一定要在副本上做。

4. **不要**在这块 exFAT 盘上用任何"数据库修复工具"——它们通常就地重写文件，一次失败就是彻底没有。

---

## 6. 绝对不要做的 6 件事

| ❌ | 为什么 |
|---|---|
| 看到 `DIRTY` 就回滚 | 大多数情况体检是好的，回滚等于白扔数据 |
| 删除 `abandoned-*` | 那是唯一还能捞数据的东西 |
| 在共享盘上就地跑修复工具 | 就地重写，失败即彻底丢失；exFAT 无日志，没法回退 |
| 用"最近修改时间"选保留哪份 | 粒度 2 秒 + 跨系统时区偏移（01·A3），基本等于随机 |
| 另一台机器/另一个系统上"顺便看一下" | 你正在制造第二次并发访问 |
| 急着重装应用 / 重建库 | 重建会静默产生一个空库，然后"正常"覆盖一切 |

---

## 7. 事后：把这次的教训变成一次体检

恢复完，至少做一遍：

- [ ] `PRAGMA integrity_check` 全量跑一次，结果记进收据
- [ ] 确认 `snapshots/` 里有 2 代可用
- [ ] 确认关闭脚本**真的**被执行了（如果它是靠"注销时触发"，那它可能根本没跑过 —— 这是最常见的根因）
- [ ] 把 `content_digest` 补上（表数 + 总行数），下次就能发现"内容变少"
- [ ] 如果这次是断电/强关机导致的：确认你是否接受继续用 exFAT（见 [04](04-why-not-sync.md) §6）
