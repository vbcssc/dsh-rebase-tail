# CHANGELOG

## 0.3.1

- 修：分切出来的会话**用一次之后就打不开**（冷启动报 `stored log is corrupt: SessionFormatError: system/message requires a protected first surface head`）。根因是种子的 surface 从摘要那条 user/message 开始：agent-loop 在第一轮会往 surface 追加一条 system/message（`SystemPromptProjection.project` 找不到任何 system 节点时就是追加），而服务端校验要求"日志里一旦有 system/message，surface 的 0 号节点必须是它"。创建和继续用都不校验这条，只有重新打开日志时才校验，所以症状是"重启后历史加载失败"。
- 现在种子自带一段自成一轮的头部：`turn/start → step/start → system/message → step/end → turn/end`，摘要归这一轮，搬来的事件从第 2 轮起。那条 system/message 是过渡性的——agent-loop 每个 step 都会把 0 号节点替换成真正的系统提示，第一次请求之后它就没了。
- 新增 `tools/repair-head.mjs`：给 0.3.0 及更早分切出来的会话补头部。重排 seq、turn 号与全部引用（surfaceOp / sourceEventSeqs / headerSeq / messageSeqs / shadowedRange…），对话内容不动，写回前备份 `.bak`，并保持"首帧恰好是头部行"的多帧 zstd 格式。
- 测试补 1 条（surface 头必须是 system/message，覆盖四种参数组合）。真机验证：4 组真实日志的种子在"追加一条 live system/message"之后通过 v4 关系校验，去掉头部那条就复现同一个报错；两个线上坏会话修好后经真持久化层冷读通过（793 / 98 条事件）。

## 0.3.0

- 新增：弹窗里可以给新会话起名。输入框在「保留轮次」上面（打开弹窗时自动聚焦），留空＝旧标题 +「 · 尾部会话」，最多 80 字（输入框 `maxlength` + 宿主再校验一次）。
- 名称整条照用，不再拼后缀；旧日志没有可继承标题时合成一条 `session/title`，避免新会话在列表里显示「未命名」。回执里加 `名称「…」`。
- 命令行同样支持：`/rebase-tail --title 我的尾部会话`（`--title` 把后面整行当名字，所以放最后；也可写 `--title=一个词`）。
- 测试补 3 条（名称照用 / 无标题时合成 / 收敛规则与两种命令行写法）；真机验证：弹窗输入名称 → 侧边栏显示该名称。

## 0.2.1

- 修：新会话里看不到压缩摘要。检查点消息一直带着 `source.kind = 'compact-checkpoint'`；客户端的 `isCompactionCheckpoint` 只认「替换事件 + compact-checkpoint」，而种子里的它是 append，于是掉进 `start()` 里 `source.kind !== 'user'` 的分支，被渲染成一条上下文注入——前台没有正文。
- 现在把 `source.kind` 改成 `'user'`，并在正文前加一块 `【压缩摘要】以下是旧会话压缩点之前那段对话的自动回顾。`：摘要就是新会话最前面那条普通用户消息，模型可见文本只多了这一行说明。
- 测试补 1 条（摘要消息是可见用户消息、前置块存在、正文原样）；合成 fixture 的检查点改用真实日志形状（`data.content/source/id`），`--drop-summary` 的断言从看 source kind 改成看摘要正文。

## 0.2.0

- 新增浏览器半边：输入框工具栏按钮「分切尾部」（权限控件右边，与「结构化」「周期提示」并排）。点开是一个弹窗——保留轮次 / 带上压缩摘要 / 接上没跑完的那一轮，三个控件对应原来的三个命令行开关，结果就地显示。
- 宿主新增 `POST /plugins/dsh-rebase-tail/run`（同源校验 + 8KB 请求体上限）。按钮与斜杠命令共用同一个 `runRebase()`，不必两边各写一份。
- `package.json` 声明 `dsh.client = { platform: 'web' }` 且 `exports["./client"] → src/client.js`，由宿主的 client-modules 发给浏览器。
- 斜杠命令保留给脚本与键盘用户，行为不变。
- 测试补 1 条：请求体校验（缺 `sessionId`、轮次 0 / 2.5 / 字符串都要拒绝，`turns: null` 等于不填）。

## 0.1.4

- 修：新会话打不开，报 `failed to project session …: invalid persisted inbox splice at session seq N`。原因是一直在搬宿主簿记事件——`agent/inbox/spliced` 的 `start`/`removedCount` 指的是**当时队列里的下标**，砍掉前半截后再折叠就越界（`job/*`、`llm/retry*`、`assistant/attempt`、`command/*` 同理，都是按位置或按成对关系折叠的）。
- 改成白名单：只搬对话（`system/developer/user/assistant/message`、`tool/call`、`tool/result`、`request/header`、`request/context`）、结构（`turn/*`、`step/*`）与运行态（`permission/preset`、`sandbox/mode`、`approval/policy`、`model/selection`、`session/title`），其余一律不搬，`stats.droppedBookkeeping` 记账。
- 副作用是好事：种子明显变小（一个 5862 条 / 3 轮的 PTC 会话，`--turns 3 --drop-summary` 从 142 条降到 93 条；默认从 492 降到 330），派生消息数不变，对话内容一条没少。
- 测试补 1 条：簿记事件（队列拼接 / 任务注册结算 / 重试 / 尝试 / 命令卡 / 分叉标记）不搬且记账。

## 0.1.3

- 修：命令没声明 `input`，客户端不把 `/rebase-tail --turns 3` 当命令，而是当普通提问发给模型。现在声明了 `input.hint`，参数（`--turns N` / `--drop-summary` / `--drop-open-turn`）在输入框里直接可用，一行写全回车即执行。代价是不带参数的裸命令要按两次回车（第一次变成命令块，第二次执行），这是客户端 leadingInput 机制的固有流程。

## 0.1.2

- 新增 `--turns N`：只保留压缩点之后最后 N 个完整轮次（默认全部保留）。
- 新增 `--drop-summary`：不搬压缩摘要那条 user 消息，新会话从第一个完整轮次开始。
- 不再搬 `session/end-seed`：那是父会话（或祖先）的分叉/播种标记，带进新会话会让它看起来继承了一段历史。
- 运行态（preset / sandbox / approval / 模型选择 / 标题）改取"第一个保留事件之前"的最后一次，配合 `--turns` 不再沿用更早的设置。
- 测试补 4 条：轮次窗口、摘要开关、轮次不够的报错、分叉标记丢弃。

## 0.1.1

- 修：`developer/message` 的 `headerSeq` 没有跟着重排，`agents.create` 报 `invalid seed event at index …: developer/message headerSeq must reference an earlier request/header`。
- 被引用却落在压缩区里的 `request/header` 现在会补进种子（排在引用它的消息之前）；补不回来时丢掉那条工具增量消息，而不是拼出一条非法日志。
- 测试补两条：`headerSeq` 重映射 + 请求头补不回来时的丢弃路径。

## 0.1.0

- 首个版本：斜杠命令 `/rebase-tail`，把最后一次压缩之后的对话重建为新会话。
- 默认保留压缩点所在 turn 的后半截（合成 `turn/start`、剔除孤儿 `tool/result`）；`--drop-open-turn` 丢掉这半截。
- `seq` / `turn` / `step` 重新编号，surface 替换元数据随新编号重写，跨切点的替换降级为 `append`。
- 继承 `permission/preset`、`sandbox/mode`、`approval/policy`、`model/selection`、`session/title` 五项运行态。
- 新会话自动挂到父会话所在工作区；会话记录的 preset 不可用时退回默认 preset。
