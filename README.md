# dsh-rebase-tail

输入框工具栏按钮 **「分切尾部」**（在权限控件右边，与「结构化」「周期提示」并排）：把「最近一次压缩之后」的对话重建为一个**新会话**，甩掉被压缩掉的历史包袱。同一个执行体也注册成斜杠命令 `/rebase-tail`，留给脚本与键盘用户。

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

**两半是怎么挂上的**：`package.json` 里的 `dsh.client = { platform: 'web' }` ＋ `exports["./client"]` 指向 `src/client.js`，宿主的 client-modules 扫描到这个声明就把浏览器半边发给前端；`src/index.js` 是 host 半边。只装 host 半边（headless / TUI 装配）时按钮不出现，但命令照旧可用。

## 用法

在要甩包袱的会话里点工具栏的 **分切尾部**，弹窗里三个选项：

| 控件 | 默认 | 说明 |
|---|---|---|
| 名称 | 空 | 新会话的名字，最多 80 字。留空＝旧标题 +「 · 尾部会话」 |
| 保留轮次 | 空（全部） | 只留压缩点之后最后 N 个完整轮次。留空＝全部完整轮次 |
| 带上压缩摘要 | 勾 | 不勾则新会话第一条 user 消息不再是那段回顾（也就不含压缩点之前的结论） |
| 接上没跑完的那一轮 | 勾 | 不勾则只保留完整结束的轮次 |

点「开始分切」→ 结果显示在弹窗里：新会话 id、事件数变化、保留了几个完整轮次、是否带上摘要、是否挂到了当前工作区。侧边栏随即多出一行 `… · 尾部会话`，点开继续即可。

等价的命令行形式（同一个执行体）：

```
/rebase-tail                             # 默认：压缩点之后的全部，含压缩摘要 + 被打断那轮的后半截
/rebase-tail --drop-open-turn           # 不接那半截，只留之后完整结束的轮次
/rebase-tail --turns 3                  # 只留最后 3 个完整轮次（摘要仍然带着）
/rebase-tail --turns 3 --drop-summary   # 再连压缩摘要那条消息也不带
/rebase-tail --title 我的尾部会话        # 给新会话起名（`--title` 把后面整行都当名字，所以放最后）
```

命令声明了 `input`（否则宿主端命令不接受参数：带参数的一行会被客户端当成普通提问发给模型）。这条声明的副作用是**不带参数时要多按一次回车**——第一次回车把 `/rebase-tail` 变成命令块，第二次回车才执行；从补全菜单选也一样（选中后再回车）。一行写全则一次回车就行。

**默认输出可能比你以为的大**：压缩只遮住它自己那次的范围，所以"压缩点之后的尾巴"往往就是日志的大半。实测一个 2195 条 / 13 轮的会话，唯一一次压缩发生在第 1 轮末尾（替换 seq 13–928），默认结果仍有 1110 条 / 11 轮 —— 那不是漏搬，它们本来就都在压缩点之后。要更小就把「保留轮次」填上，要连摘要那段回顾也不看就取消「带上压缩摘要」。

- 不触发模型调用，不花 token，不改动原会话。
- 成功后返回新会话 id，并（尽力）把它挂到父会话所在工作区；在会话列表里打开它继续即可。
- 给了名称就整条照用（不再拼后缀）；旧日志里没有可继承的标题时，会为新会话合成一条 `session/title`——否则它在列表里只能显示「未命名」。
- 标题是会话自己的元数据：写在种子的第一条 `session/title` 里，之后手动改标题照旧生效。
- 新会话的 `permission/preset`、`sandbox/mode`、`approval/policy`、`model/selection`、`session/title` 各取旧日志里的最后一次；标题加 ` · 尾部会话` 后缀。
- 会话记录的 agent preset 已被删除或改名时，退回默认 preset，而不是让整次分切失败。

## 切点规则

```
… turn N 的前半截（已被压缩，留在旧日志）
[压缩点] compaction/summary + 摘要 user 消息     ← 新会话从这里开始
  turn N 的后半截（steps 6…15）                  ← 合成一条 turn/start 后接续
  turn N+1 …                                     ← 完整轮次
```

- **起点**：最后一次 `compaction/summary` 的替换消息（紧凑检查点 `user/message`）。`surfaceOp: replace` 降级为 `append`（被它遮住的历史正好是要丢掉的部分），`source.kind` 由 `compact-checkpoint` 改成 `user`，并在正文前加一块 `【压缩摘要】…`。后两件事是为了让它看得见：客户端对 `compact-checkpoint` 源的 user/message 走「上下文注入」渲染（`packages/client/ui-chat/src/client/conversation-nodes/message.ts` 的 `isCompactionCheckpoint` 只认替换事件，`start()` 里 `source.kind !== 'user'` 的分支把消息归成 context），前台就没有正文；而它的替换语义在子会话里本来也没有可遮的范围。改完它就是新会话最前面那条普通用户消息。
- **终点**：最后一个 `turn/end`。之后的重排、队列快照等簿记事件丢弃。
- **压缩点所在 turn 的后半截**：它没有 `turn/start`（前半截被压缩了），插件补一条合成的 `turn/start`，只从第一个完整的 `step/start` 开始接续；**孤儿 `tool/result`**（其 `tool/call` 落在压缩区）被剔除，否则会拼出「只有结果没有调用」的请求。`--drop-open-turn` 时这半截整体丢弃，检查点也不再带 `turn`/`step`（那一轮既没有开头也没有结尾）。
- **重排**：`seq` 从 0 连续；`turn` 从 1、每轮 `step` 从 1 重排；`surfaceOp` / `sourceEventSeqs` 按新编号重写，指向已丢弃事件的替换降级为 `append`、悬空引用删除。
- **工具增量消息**：`developer/message` 的 `headerSeq` 按新编号重写；它引用的 `request/header` 若落在压缩区，会被补进种子并排在引用者之前（校验要求 `headerSeq` 恰好当存在工具增量时出现，且必须指向更早的 `request/header`）。请求头补不回来时，这条消息整条丢弃。
- **拒绝执行**：没有压缩点；最后一次压缩没留下检查点；压缩点之后没有完整结束的轮次；当前这一轮还没结束（`turn-open`，等它跑完再执行）。
- **`session/end-seed` 不搬**：那是父会话（或它的祖先）的分叉/播种标记，搬过去会让新会话看起来继承了一段历史。
- **运行态取"第一个保留事件之前"的最后一次**，用 `--turns` 砍掉前面几轮时不会沿用更早的 preset / 模型选择。
- **只搬对话与结构（白名单）**：`system/developer/user/assistant/message`、`tool/call`、`tool/result`、`request/header`、`request/context`、`turn/*`、`step/*`，加上五项运行态。其余宿主簿记一律不搬——它们有的按位置折叠（`agent/inbox/spliced` 的 `start`/`removedCount` 是当时队列的下标，砍掉前半截后再折叠就报 `invalid persisted inbox splice`），有的按成对关系折叠（`job/registered`/`job/settled`、`llm/retry*`、`assistant/attempt`、`command/run`/`command/done`）。
- 因此也不搬：子代理派生关系、goal/plan/todo 等会话级状态、`turn/end` 之后的队列快照。

## 实测

在真实 Web 客户端（真宿主、真 Loader 装配、真持久化、真客户端插件加载）里跑通：

- 工具栏出现 28px 高的药丸「分切尾部」，与权限控件、模型选择器同一行（实测盒模型 `84×28`，`y=833`）。
- 点开弹窗、点「开始分切」→ `已建好尾部会话 session-53d333af-…：245 条事件 -> 17 条（压缩点之后 0 个完整轮次＋未完成轮次 10 条，含压缩摘要）。在会话列表里打开它继续。`
- 把「保留轮次」填 1（该会话压缩点之后没有完整轮次）→ 弹窗红框回 `压缩点之后没有任何完整结束的轮次，无法重建会话。`
- 关掉弹窗后侧边栏立刻多出 `… · 尾部会话` 一行（不填名称时）；填了名称则显示该名称，回执里也带上 `名称「…」`。，点开渲染正常：统计从父会话的 `1 轮 35 步 · 1.9M tok` 变成 `1 轮 2 步 · 48.8K tok`。
- 斜杠命令那条路同样跑通（补全菜单出现 `rebase-tail`，带参数一行回车即执行）。

离线不变量检查（`node --test` 覆盖合成日志；真实日志另做一次性核对）：`seq` 连续、surface 替换引用全部指向更早的 `seq`、`turn` 从 1 且连续、每轮 `step` 从 1 且连续、每个 `step/end` 都有配对、无孤儿 `tool/result`、无 `compaction/*` 残留；投影物化（`sessionProjections.snapshot`，即打开会话时那一步）在 6 份真实日志 × 9 组参数上全部通过。

## 已知边界

- **压缩摘要就是新会话最前面那条 user 消息**：正文前多一行 `【压缩摘要】以下是旧会话压缩点之前那段对话的自动回顾。`，其余原样（`This is an automatically generated checkpoint …` 那段开场、9KB 级正文、`</compacted-summary>` 收尾）。它同时是模型可见上下文的一部分；取消勾选「带上压缩摘要」则整条不带。
- **新会话里的下一轮对话没有测过**：验证只到「模型可见请求构造正确 + 会话能渲染/恢复」。
- 压缩点所在 turn 的后半截里若出现 `/compact`、图片 offload、tool-result 裁剪等**跨切点替换**事件，当前策略一律降级为 `append`。
- preset 必须在该宿主里存在，否则会话本身就无法恢复（`Unknown agent preset`）——与插件无关，但会让按钮无处可点。
- 按钮只在 Web / Electron 客户端出现；headless、TUI、ACP 装配里没有这个槽位，用斜杠命令。

## 开发

```sh
node --test          # 或 npm test：合成日志的不变量测试 + 请求体校验
```

```
src/index.js      host 半边：runRebase() 执行体、/rebase-tail 命令、POST /plugins/dsh-rebase-tail/run
src/client.js     浏览器半边：工具栏药丸 + 弹窗（conversation.input.left / conversation.input.dock）
src/tail-seed.js  纯函数：buildTailSeed(events, options) → { seed, stats } | { error }
test/             node:test 不变量测试
```

## License

MIT
