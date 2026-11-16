# dsh-rebase-tail

斜杠命令 **`/rebase-tail`**：把「最近一次压缩之后」的对话重建为一个**新会话**，甩掉被压缩掉的历史包袱。

## 它解决什么

压缩（compaction）只把旧历史从**模型可见面**遮住，会话日志本身仍保留全部事件；分叉（`session/fork`）复制的也是**整条前缀**。于是一个跑过几十轮上千步的会话，无论分叉多少次都背着最初那份几百 MB 的日志。

本插件两者都不用：它把尾部真正搬进一个干净的新会话——被压缩掉的事件不再出现在新会话的任何位置。

| | 全量 | 最后一次压缩之后（本插件的结果） |
|---|---|---|
| 实测大会话 | 74,920 条事件 / 232.9 MB | **196 条 / 0.55 MB**（约 0.2%） |
| 分叉 | 子会话 = 父会话 + 1 条 end-seed，尺寸不变 | — |

## 安装

插件不 import 任何 `@deepseek-ai/*` 包——所有服务走 `ctx`，所以它自己没有 `node_modules`，dsh 升级也不会打断它。

1. 让 profile 能按名字解析到它（以 `web` 为例，`desktop` 同理）：

```sh
cd ~/.dsh/profiles/web
pnpm add link:D:/docker_and_big_models/开源仓库-分析区/dsh-rebase-tail
```

2. 在该 profile 的 `cordis.patch.yml` 末尾加一行：

```yaml
- id: dsh-rebase-tail
  name: dsh-rebase-tail
```

3. 重启该 profile 的宿主进程（desktop 要重启 app）。宿主的日志里若出现 `N entry did not activate`，说明这一行没解析成功。

> 本仓库同时是一份 bundle（`dsh.bundle.patch` 指向 `cordis.patch.yml`）：也可以把本目录当 bundle 加进 `dsh.profile.bundles`，由 bundle 层插入这一行。

## 用法

在要甩包袱的会话里执行：

```
/rebase-tail                  # 默认：保留压缩点所在 turn 的后半截
/rebase-tail --drop-open-turn # 丢掉那半截，只留之后完整结束的轮次
```

- 不触发模型调用，不花 token，不改动原会话。
- 成功后返回新会话 id，并（尽力）把它挂到父会话所在工作区；在会话列表里打开它继续即可。
- 新会话的 `permission/preset`、`sandbox/mode`、`approval/policy`、`model/selection`、`session/title` 各取旧日志里的最后一次；标题加 ` · 尾部会话` 后缀。
- 会话记录的 agent preset 已被删除或改名时，退回默认 preset，而不是让命令失败。

## 切点规则

```
… turn N 的前半截（已被压缩，留在旧日志）
[压缩点] compaction/summary + 摘要 user 消息     ← 新会话从这里开始
  turn N 的后半截（steps 6…15）                  ← 合成一条 turn/start 后接续
  turn N+1 …                                     ← 完整轮次
```

- **起点**：最后一次 `compaction/summary` 的替换消息（紧凑检查点 `user/message`）。它的 `surfaceOp: replace` 降级为 `append`——被它遮住的历史正好是要丢掉的部分，降级后它自然变成「带摘要的普通 user 消息」。`source: compact-checkpoint` 保留，界面上仍是压缩卡片。
- **终点**：最后一个 `turn/end`。之后的重排、队列快照等簿记事件丢弃。
- **压缩点所在 turn 的后半截**：它没有 `turn/start`（前半截被压缩了），插件补一条合成的 `turn/start`，只从第一个完整的 `step/start` 开始接续；**孤儿 `tool/result`**（其 `tool/call` 落在压缩区）被剔除，否则会拼出「只有结果没有调用」的请求。`--drop-open-turn` 时这半截整体丢弃，检查点也不再带 `turn`/`step`（那一轮既没有开头也没有结尾）。
- **重排**：`seq` 从 0 连续；`turn` 从 1、每轮 `step` 从 1 重排；`surfaceOp` / `sourceEventSeqs` 按新编号重写，指向已丢弃事件的替换降级为 `append`、悬空引用删除。
- **工具增量消息**：`developer/message` 的 `headerSeq` 按新编号重写；它引用的 `request/header` 若落在压缩区，会被补进种子并排在引用者之前（校验要求 `headerSeq` 恰好当存在工具增量时出现，且必须指向更早的 `request/header`）。请求头补不回来时，这条消息整条丢弃。
- **拒绝执行**：没有压缩点；最后一次压缩没留下检查点；压缩点之后没有完整结束的轮次；当前这一轮还没结束（`turn-open`，等它跑完再执行）。
- 不搬的东西：子代理派生关系、goal/plan/todo 等会话级状态、`turn/end` 之后的队列快照。

## 实测

在真实 Web 客户端（真宿主、真命令注册表、真持久化）里跑通：

- 输入框敲 `/rebase` 时补全菜单出现 `rebase-tail`（宿主端注册，客户端自动发现，无客户端代码）。
- 执行后会话里出现 `已建好尾部会话 session-…：246 条事件 -> 18 条（压缩点之后，含未完成轮次 11 条）`。
- 侧边栏随即多出一行 `… · 尾部会话`，点开渲染正常：内容正是压缩点之后那一截，统计从父会话的 `1 轮 35 步 · 1.9M tok` 变成 `1 轮 2 步 · 48.8K tok`。

离线不变量检查（`node --test` 覆盖合成日志；真实日志另做一次性核对）：`seq` 连续、surface 替换引用全部指向更早的 `seq`、`turn` 从 1 且连续、每轮 `step` 从 1 且连续、每个 `step/end` 都有配对、无孤儿 `tool/result`、无 `compaction/*` 残留。

## 已知边界

- **新会话里的下一轮对话没有测过**：验证只到「模型可见请求构造正确 + 会话能渲染/恢复」。
- 压缩点所在 turn 的后半截里若出现 `/compact`、图片 offload、tool-result 裁剪等**跨切点替换**事件，当前策略一律降级为 `append`。
- preset 必须在该宿主里存在，否则会话本身就无法恢复（`Unknown agent preset`）——与插件无关，但会让命令无处可跑。

## 开发

```sh
node --test          # 或 npm test：合成日志的不变量测试
```

```
src/index.js      插件入口：注册 /rebase-tail，观察会话 → 造种子 → agents.create 建新会话
src/tail-seed.js  纯函数：buildTailSeed(events, options) → { seed, stats } | { error }
test/             node:test 不变量测试
```

## License

MIT
