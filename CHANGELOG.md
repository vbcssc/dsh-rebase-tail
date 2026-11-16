# CHANGELOG

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
