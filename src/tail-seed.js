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
const COMPACTION_TYPES = new Set(['compaction/start', 'compaction/summary', 'compaction/end'])
/** 从旧日志头部继承的运行态设置（各自取最后一次）。 */
const STATE_TYPES = ['permission/preset', 'sandbox/mode', 'approval/policy', 'model/selection', 'session/title']

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

  // 压缩事务与 session/end-seed 都是簿记事件：新会话不该继承别人的分叉标记。
  const isBookkeeping = event => COMPACTION_TYPES.has(event.type) || event.type === 'session/end-seed'
  const closedKept = closed.slice(closedFrom).filter(event => !isBookkeeping(event))
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

  /** @type {{ event: object, originalSeq?: number }[]} */
  let records = []
  for (const event of stateRecords) records.push({ event, originalSeq: event.seq })
  if (includeSummary) records.push({ event: checkpoint, originalSeq: checkpoint.seq, isCheckpoint: true })

  let keptInterrupted = []
  let droppedOrphans = 0
  if (keepFragment) {
    // 片段开头可能落在被压缩掉的那个 step 的尾巴上（step/start 在压缩区内）：
    // 只从第一个完整的 step/start 开始接续，之前的半截 step 事件全部丢弃。
    const filtered = interruptedRaw.filter(event => !isBookkeeping(event))
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

  // 丢掉那半截时，压缩点所在 turn 既没有 turn/start 也没有 turn/end：
  // 保留它的 turn/step 会造出一个没有开头的轮次，索性让检查点成为一条无轮次归属的消息。
  const checkpointLosesTurn = keptInterrupted.length === 0

  // seq 重排：原 seq -> 新 seq
  const seqMap = new Map()
  records.forEach((record, index) => {
    if (record.originalSeq !== undefined) seqMap.set(record.originalSeq, index)
  })

  // turn / step 重排（丢掉轮次归属的检查点不参与取值，否则会留下空号）
  const numbered = records.filter(record => !(record.isCheckpoint === true && checkpointLosesTurn))
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
    if (record.isCheckpoint === true && checkpointLosesTurn) {
      delete clone.data?.turn
      delete clone.data?.step
    }
    const turn = turnOf(clone)
    if (turn !== undefined) clone.data.turn = turn - turnBase + 1
    const remappedTurn = turnOf(clone)
    const step = stepOf(clone)
    if (step !== undefined && remappedTurn !== undefined) {
      const floor = stepFloor.get(turn)
      if (floor !== undefined) clone.data.step = step - floor + 1
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
    if (clone.type === 'developer/message' && typeof clone.data?.headerSeq === 'number') {
      const mapped = seqMap.get(clone.data.headerSeq)
      // 补头之后这里一定映射得上；万一映射到自身之后（不可能）就保留原值让校验去报错。
      if (mapped !== undefined && mapped < index) clone.data.headerSeq = mapped
    }
    if (clone.type === 'session/title') {
      clone.data.messageSeqs = []
      clone.data.source = { kind: 'user' }
      clone.data.title = String(clone.data.title ?? 'untitled').replace(/\s*·\s*尾部会话$/, '') + ' · 尾部会话'
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
      checkpointSeq: checkpoint.seq,
    },
  }
}
