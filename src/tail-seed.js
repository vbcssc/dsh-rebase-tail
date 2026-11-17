/**
 * 把一条会话日志裁剪成"最近一次压缩之后"的尾部种子。
 *
 * 纯函数：不依赖 dsh 的任何包，输入输出都是 JSON 值，便于离线验证。
 *
 * 语义：
 * - 起点 = 最后一次 compaction/summary 的替换消息（紧凑检查点 user/message）。
 * - 终点 = 最后一个 turn/end（之后的重排、队列快照等簿记事件丢弃）。
 * - 压缩发生在 turn 中间时，该 turn 的后半截没有 turn/start（它的前半截已被压缩），
 *   需要合成一条 turn/start 才能自成一条合法日志；其中的孤儿 tool/result
 *   （tool/call 落在被压缩区域）必须剔除，否则会拼出"只有结果没有调用"的请求。
 * - land 到新会话时 seq 从 0 连续重排，turn 从 1、step 从 1 重排；
 *   surface 替换元数据按重排后的 seq 重写，指向已丢弃事件的替换降级为 append。
 */

/** 能进入模型可见面的事件类型。 */
const SURFACE_TYPES = new Set(['system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result'])
/** 压缩事务自身的日志事件：新会话不保留（摘要已经作为检查点消息存在）。 */
/**
 * 压缩摘要搬到新会话时前置的一块说明。
 *
 * 客户端把 `source.kind === 'compact-checkpoint'` 的 user/message 当上下文注入渲染
 * （前台只留一个不起眼的上下文条目，看不到摘要正文），而且它的替换语义在子会话里没有
 * 可遮的范围。所以检查点落进种子时改成一条普通用户消息：摘要就成了新会话最前面
 * 那条看得见的对话。
 */
const SUMMARY_HEADER = '【压缩摘要】以下是旧会话压缩点之前那段对话的自动回顾。'
/**
 * 新会话里那块"分切说明"系统消息。
 *
 * 服务端校验要求：日志里一旦出现 system/message，surface 的 0 号节点必须就是它
 * （session-format-v3-to-v4 的 "system/message requires a protected first surface head"）。
 * 而 agent-loop 在 surface 里找不到任何 system/message 时，会在新会话第一轮**追加**一条，
 * 那条追加必然落在 summary 之后，于是整条日志在冷启动时被判定为损坏——分切出来的会话用一次
 * 就再也打不开。所以种子自己带一个 0 号 system 节点占住位置。
 *
 * 这段文字是过渡性的：agent-loop 的 SystemPromptProjection 在每个 step 都会把 0 号节点
 * 替换成真正的系统提示，第一次请求之后它就消失了。 */
const HEAD_NOTE = '这一轮的上下文来自旧会话压缩点之后的部分，压缩点之前的对话不在本会话里。'
/** 那条系统消息的消息 id：日志里唯一即可，取值固定便于比对。 */
const HEAD_MESSAGE_ID = 'rebase-tail-head'

const COMPACTION_TYPES = new Set(['compaction/start', 'compaction/summary', 'compaction/end'])
/** 从旧日志头部继承的运行态设置（各自取最后一次）。 */
const STATE_TYPES = ['permission/preset', 'sandbox/mode', 'approval/policy', 'model/selection', 'session/title']
/**
 * 能搬进新会话的事件类型（白名单）。
 *
 * 只搬"对话 + 轮次/步骤结构"：其余都是宿主簿记，跟着搬会出事——它们要么按位置折叠
 * （agent/inbox/spliced 的 start/removedCount 指的是当时队列里的下标，切掉前半截后再折叠
 * 就越界：invalid persisted inbox splice），要么按成对关系折叠（job 注册/结算、llm 重试、
 * 审批/提问问答）。新会话从零重建，把这些丢掉既是安全的也是正确的。
 */
const KEEP_TYPES = new Set([
  ...SURFACE_TYPES,
  'tool/call', 'request/header', 'request/context',
  'turn/start', 'turn/end', 'step/start', 'step/end',
  ...STATE_TYPES,
])

/** 事件携带的 turn 号，或 undefined。 */
function turnOf(event) {
  const turn = event?.data?.turn
  return typeof turn === 'number' ? turn : undefined
}

/** 事件携带的 step 号，或 undefined。 */
function stepOf(event) {
  const step = event?.data?.step
  return typeof step === 'number' ? step : undefined
}

/** tool/call 与 tool/result 的调用身份。 */
function callIdOf(event) {
  if (event.type === 'tool/call') return event.data?.callId
  if (event.type === 'tool/result') return event.data?.message?.source?.callId
  return undefined
}

/**
 * 从尾部片段里剔除孤儿 tool/result（其 tool/call 不在同一片段内）。
 * @param fragment - 压缩点所在 turn 的后半截（原样事件）。
 * @returns 保留的调用身份与被剔除的事件数。
 */
function dropOrphanResults(fragment) {
  const keptCalls = new Set()
  for (const event of fragment) {
    const callId = callIdOf(event)
    if (event.type === 'tool/call' && callId !== undefined) keptCalls.add(callId)
  }
  let dropped = 0
  const kept = fragment.filter((event) => {
    if (event.type !== 'tool/result') return true
    const callId = callIdOf(event)
    if (callId !== undefined && keptCalls.has(callId)) return true
    dropped += 1
    return false
  })
  return { kept, dropped }
}

/**
 * 构造种子事件。
 * @param events - 源会话事件（seq 连续，从 0 开始）。
 * @param options - includeInterruptedTurn:false 丢掉压缩点所在 turn 的后半截；
 *   includeSummary:false 连压缩摘要那条消息也不带（此时同样丢掉那半截）；
 *   turns:N 只保留压缩点之后最后 N 个完整轮次。
 * @returns { seed, stats } 或 { error, detail }。
 */
export function buildTailSeed(events, options = {}) {
  const includeInterruptedTurn = options.includeInterruptedTurn !== false
  const includeSummary = options.includeSummary !== false
  const keepTurns = typeof options.turns === 'number' && Number.isFinite(options.turns) ? Math.floor(options.turns) : undefined
  if (keepTurns !== undefined && keepTurns < 1) return { error: 'bad-turns' }
  // 用户给新会话起的名字：给了就整条照用（不再拼" · 尾部会话"），没给才用旧标题加后缀。
  const customTitle = typeof options.title === 'string' && options.title.trim().length > 0 ? options.title.trim() : undefined

  let lastSummary = -1
  for (let index = 0; index < events.length; index += 1) {
    if (events[index].type === 'compaction/summary') lastSummary = index
  }
  if (lastSummary < 0) return { error: 'no-compaction' }

  let checkpointIndex = lastSummary + 1
  while (checkpointIndex < events.length && !SURFACE_TYPES.has(events[checkpointIndex].type)) checkpointIndex += 1
  if (checkpointIndex >= events.length) return { error: 'no-checkpoint' }
  const checkpoint = events[checkpointIndex]

  let lastTurnEnd = -1
  for (let index = events.length - 1; index > checkpointIndex; index -= 1) {
    if (events[index].type === 'turn/end') { lastTurnEnd = index; break }
  }
  if (lastTurnEnd < 0) return { error: 'no-closed-turn' }
  for (let index = lastTurnEnd + 1; index < events.length; index += 1) {
    if (events[index].type === 'turn/start') return { error: 'turn-open' }
  }

  // 压缩点所在 turn 的前半截已被压缩，尾部从这里切开：前半截（没有 turn/start）是"被打断的那一轮的后半截"。
  const tail = events.slice(checkpointIndex, lastTurnEnd + 1)
  const firstTurnStart = tail.findIndex(event => event.type === 'turn/start')
  const splitAt = firstTurnStart < 0 ? tail.length : firstTurnStart
  const interruptedRaw = tail.slice(0, splitAt)
  const closed = tail.slice(splitAt)

  const turnStarts = []
  closed.forEach((event, index) => { if (event.type === 'turn/start') turnStarts.push(index) })
  let closedFrom = 0
  if (keepTurns !== undefined) {
    if (turnStarts.length < keepTurns) {
      return {
        error: turnStarts.length === 0 ? 'no-closed-turn' : 'not-enough-turns',
        detail: { available: turnStarts.length, requested: keepTurns },
      }
    }
    closedFrom = turnStarts[turnStarts.length - keepTurns]
  }

  const window = closed.slice(closedFrom)
  const closedKept = window.filter(event => KEEP_TYPES.has(event.type))
  const droppedBookkeeping = window.length - closedKept.length
  // 不带摘要时也不接那半截：没有摘要打底，孤立的后半截读不出上下文。
  const keepFragment = includeInterruptedTurn && includeSummary && keepTurns === undefined
  const keptTurns = closedKept.filter(event => event.type === 'turn/start').length
  if (!includeSummary && keptTurns === 0) return { error: 'no-closed-turn' }

  // 运行态取"第一个保留事件"之前的最后一次出现，避免沿用更早的 preset / 模型选择。
  const firstKeptSeq = includeSummary ? checkpoint.seq : (closedKept[0]?.seq ?? checkpoint.seq)
  const stateRecords = []
  for (const type of STATE_TYPES) {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      if (events[index].seq >= firstKeptSeq) continue
      if (events[index].type === type) { stateRecords.push(events[index]); break }
    }
  }
  stateRecords.sort((left, right) => left.seq - right.seq)
  // 旧日志没有可继承的标题（或它在切点之后）时，用户给的名字需要一条自己的 session/title：
  // 否则新会话在列表里只能显示"未命名"。合成的事件不进 seqMap，它不是旧日志里的事件。
  const synthetic = new Set()
  if (customTitle !== undefined && !stateRecords.some(event => event.type === 'session/title')) {
    const titleEvent = {
      type: 'session/title',
      seq: firstKeptSeq,
      time: checkpoint.time,
      data: { title: customTitle, messageSeqs: [], source: { kind: 'user' } },
    }
    synthetic.add(titleEvent)
    stateRecords.push(titleEvent)
    stateRecords.sort((left, right) => left.seq - right.seq)
  }

  /** @type {{ event: object, originalSeq?: number }[]} */
  let records = []
  for (const event of stateRecords) records.push({ event, ...(synthetic.has(event) ? {} : { originalSeq: event.seq }) })
  // 自成一轮的头部：system 占住 surface 的 0 号节点（见 HEAD_NOTE），摘要归它这一轮。
  const headEvent = (type, data, surfaceOp) => {
    const event = { type, seq: -1, time: checkpoint.time, data }
    if (surfaceOp !== undefined) event.surfaceOp = surfaceOp
    return event
  }
  const head = [
    { event: headEvent('turn/start', { turn: 1 }), synthetic: true },
    { event: headEvent('step/start', { turn: 1, step: 1 }), synthetic: true },
    {
      event: headEvent('system/message', {
        turn: 1,
        step: 1,
        message: {
          role: 'system',
          content: [{ type: 'text', text: HEAD_NOTE }],
          source: { kind: 'system-prompt' },
          id: HEAD_MESSAGE_ID,
        },
      }, 'append'),
      synthetic: true,
    },
  ]
  if (includeSummary) head.push({ event: checkpoint, originalSeq: checkpoint.seq, isCheckpoint: true, inHead: true })
  head.push({ event: headEvent('step/end', { turn: 1, step: 1 }), synthetic: true })
  head.push({ event: headEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }), synthetic: true })
  records.push(...head)

  let keptInterrupted = []
  let droppedOrphans = 0
  if (keepFragment) {
    // 片段开头可能落在被压缩掉的那个 step 的尾巴上（step/start 在压缩区内）：
    // 只从第一个完整的 step/start 开始接续，之前的半截 step 事件全部丢弃。
    const filtered = interruptedRaw.filter(event => KEEP_TYPES.has(event.type))
    const firstStepIndex = filtered.findIndex(event => event.type === 'step/start')
    const trimmed = firstStepIndex < 0 ? [] : filtered.slice(firstStepIndex)
    const repaired = dropOrphanResults(trimmed)
    keptInterrupted = repaired.kept
    droppedOrphans = repaired.dropped
    if (keptInterrupted.length > 0) {
      const firstTurn = keptInterrupted.map(turnOf).find(turn => turn !== undefined)
      records.push({ event: { type: 'turn/start', seq: -1, time: keptInterrupted[0].time, data: { turn: firstTurn ?? 1 } } })
      for (const event of keptInterrupted) records.push({ event, originalSeq: event.seq })
    }
  }
  for (const event of closedKept) records.push({ event, originalSeq: event.seq })

  // developer/message 的 tool-addition 必须指回一条更早的 request/header（数据校验要求
  // headerSeq "恰好当" 存在工具增量时出现）。被引用头可能落在压缩区里、或在片段裁剪时
  // 被丢掉，这里按需补进来，位置放在检查点之前——它本来就比尾部消息更早。
  const includedSeqs = new Set(records.map(record => record.originalSeq).filter(seq => seq !== undefined))
  const neededHeaders = new Set()
  for (const record of records) {
    if (record.event.type !== 'developer/message') continue
    const headerSeq = record.event.data?.headerSeq
    if (typeof headerSeq !== 'number' || includedSeqs.has(headerSeq)) continue
    neededHeaders.add(headerSeq)
  }
  for (const headerSeq of [...neededHeaders].sort((left, right) => left - right)) {
    const header = events[headerSeq]
    if (header?.type !== 'request/header') continue
    records.splice(stateRecords.length + [...neededHeaders].filter(seq => seq < headerSeq).length, 0, { event: header, originalSeq: header.seq })
  }

  // 头补不回来时，这条消息无法自证工具增量的来源，整条丢掉好过拼出一条非法日志。
  const headerReadySeqs = new Set(records.map(record => record.originalSeq).filter(seq => seq !== undefined))
  let droppedDevMessages = 0
  records = records.filter((record) => {
    if (record.event.type !== 'developer/message') return true
    const headerSeq = record.event.data?.headerSeq
    if (typeof headerSeq !== 'number' || headerReadySeqs.has(headerSeq)) return true
    droppedDevMessages += 1
    return false
  })

  // seq 重排：原 seq -> 新 seq
  const seqMap = new Map()
  records.forEach((record, index) => {
    if (record.originalSeq !== undefined) seqMap.set(record.originalSeq, index)
  })

  // turn / step 重排：合成头部与检查点不参与取值（否则会留下空号或撞号），搬来的事件从第 2 轮起
  const numbered = records.filter(record => record.synthetic !== true && record.isCheckpoint !== true)
  const turns = numbered.map(record => turnOf(record.event)).filter(turn => turn !== undefined)
  const turnBase = turns.length > 0 ? Math.min(...turns) : 0
  const stepFloor = new Map()
  for (const record of numbered) {
    const turn = turnOf(record.event)
    const step = stepOf(record.event)
    if (turn === undefined || step === undefined) continue
    const known = stepFloor.get(turn)
    if (known === undefined || step < known) stepFloor.set(turn, step)
  }

  const seed = records.map((record, index) => {
    const clone = JSON.parse(JSON.stringify(record.event))
    clone.seq = index
    if (record.isCheckpoint === true) {
      // 摘要归头部那一轮：turn 1 / step 1 由头部占着。
      clone.data.turn = 1
      clone.data.step = 1
    } else if (record.synthetic !== true) {
      const turn = turnOf(clone)
      if (turn !== undefined) clone.data.turn = turn - turnBase + 2
      const remappedTurn = turnOf(clone)
      const step = stepOf(clone)
      if (step !== undefined && remappedTurn !== undefined) {
        const floor = stepFloor.get(turn)
        if (floor !== undefined) clone.data.step = step - floor + 1
      }
    }
    if (SURFACE_TYPES.has(clone.type)) {
      const op = clone.surfaceOp
      if (op !== undefined && typeof op === 'object' && op.op === 'replace') {
        const start = seqMap.get(op.startSeq)
        const end = seqMap.get(op.endSeq)
        // 被指向的节点已经丢弃时，这条替换就是"覆盖已丢历史"，降级为普通追加。
        clone.surfaceOp = start === undefined || end === undefined || start >= index || end >= index
          ? 'append'
          : { op: 'replace', startSeq: start, endSeq: end }
      } else {
        clone.surfaceOp = 'append'
      }
      if (Array.isArray(clone.sourceEventSeqs)) {
        const cited = clone.sourceEventSeqs
          .map(seq => seqMap.get(seq))
          .filter(seq => seq !== undefined && seq < index)
        if (cited.length > 0 && clone.type !== 'assistant/message') clone.sourceEventSeqs = cited
        else delete clone.sourceEventSeqs
      }
    } else {
      delete clone.surfaceOp
      delete clone.sourceEventSeqs
    }
    if (record.isCheckpoint === true) {
      clone.data.source = { kind: 'user' }
      const blocks = Array.isArray(clone.data.content) ? clone.data.content : []
      clone.data.content = [{ type: 'text', text: SUMMARY_HEADER }, ...blocks]
    }
    if (clone.type === 'developer/message' && typeof clone.data?.headerSeq === 'number') {
      const mapped = seqMap.get(clone.data.headerSeq)
      // 补头之后这里一定映射得上；万一映射到自身之后（不可能）就保留原值让校验去报错。
      if (mapped !== undefined && mapped < index) clone.data.headerSeq = mapped
    }
    if (clone.type === 'session/title') {
      clone.data.messageSeqs = []
      clone.data.source = { kind: 'user' }
      clone.data.title = customTitle
        ?? String(clone.data.title ?? 'untitled').replace(/\s*·\s*尾部会话$/, '') + ' · 尾部会话'
    }
    return clone
  })

  return {
    seed,
    stats: {
      sourceEvents: events.length,
      seedEvents: seed.length,
      droppedOrphans,
      interruptedTurnEvents: keptInterrupted.length,
      droppedDevMessages,
      keptTurns,
      summaryKept: includeSummary,
      droppedBookkeeping,
      ...(customTitle === undefined ? {} : { title: customTitle }),
      checkpointSeq: checkpoint.seq,
    },
  }
}
