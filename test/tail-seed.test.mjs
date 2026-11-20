/**
 * buildTailSeed 的不变量测试：用合成日志覆盖"压缩发生在 turn 中间"的全部边界。
 * 不依赖 dsh 的任何包，node --test 直接跑。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { buildTailSeed } from '../src/tail-seed.js'
import { parseArguments, parseRunBody, normalizeTitle, normalizePreset } from '../src/index.js'

const turnStart = (seq, turn) => ({ type: 'turn/start', seq, time: seq, data: { turn } })
const stepStart = (seq, turn, step) => ({ type: 'step/start', seq, time: seq, data: { turn, step } })
const stepEnd = (seq, turn, step) => ({ type: 'step/end', seq, time: seq, data: { turn, step } })
const turnEnd = (seq, turn) => ({ type: 'turn/end', seq, time: seq, data: { turn } })
const userMessage = (seq, turn, step, text, surfaceOp = 'append') => ({
  type: 'user/message', seq, time: seq,
  data: { turn, step, message: { role: 'user', content: text } },
  surfaceOp,
})
const assistantMessage = (seq, turn, step, text, extra = {}) => ({
  type: 'assistant/message', seq, time: seq,
  data: { turn, step, message: { role: 'assistant', content: text } },
  surfaceOp: 'append',
  ...extra,
})
const toolCall = (seq, turn, step, callId) => ({ type: 'tool/call', seq, time: seq, data: { turn, step, callId, name: 'bash' } })
const toolResult = (seq, turn, step, callId) => ({
  type: 'tool/result', seq, time: seq,
  data: { turn, step, message: { role: 'tool', source: { callId }, content: 'ok' } },
  surfaceOp: 'append',
})
const compaction = (seq, type) => ({ type, seq, time: seq, data: {} })
/** 压缩检查点用真实日志的形状：content / source / id 都在 data 上，surfaceOp 是替换。 */
const checkpointMessage = (seq, turn, step, text, startSeq, endSeq) => ({
  type: 'user/message', seq, time: seq,
  data: {
    turn, step, id: 'checkpoint-1', role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'compact-checkpoint', compactionId: 'compaction-1' },
  },
  surfaceOp: { op: 'replace', startSeq, endSeq },
})

/**
 * 一轮完整对话 → 第二次压缩发生在 turn 2 中间（step 1 被压缩，step 2 留在尾部，
 * 尾部的 tool/result 其 tool/call 在压缩区里）→ turn 3 完整 → 末尾簿记事件。
 */
function fixture() {
  return [
    { type: 'permission/preset', seq: 0, time: 0, data: { preset: 'standard' } },
    { type: 'session/title', seq: 1, time: 1, data: { title: '压缩点之后的尾巴', source: { kind: 'llm' }, messageSeqs: [4] } },
    { type: 'model/selection', seq: 2, time: 2, data: { provider: 'p', model: 'm', reasoningEffort: 'high' } },
    turnStart(3, 1),
    userMessage(4, 1, 1, '第一轮的问题'),
    stepStart(5, 1, 1),
    assistantMessage(6, 1, 1, '第一轮的回答'),
    stepEnd(7, 1, 1),
    turnEnd(8, 1),
    turnStart(9, 2),
    userMessage(10, 2, 1, '第二轮的问题（会被压缩掉）'),
    stepStart(11, 2, 1),
    toolCall(12, 2, 1, 'A'),
    stepEnd(13, 2, 1),
    compaction(14, 'compaction/start'),
    compaction(15, 'compaction/summary'),
    checkpointMessage(16, 2, 1, '模型写的摘要', 10, 13),
    compaction(17, 'compaction/end'),
    stepStart(18, 2, 2),
    toolResult(19, 2, 2, 'Z'),
    assistantMessage(20, 2, 2, '接着干', { sourceEventSeqs: [12] }),
    stepEnd(21, 2, 2),
    turnStart(22, 3),
    stepStart(23, 3, 1),
    userMessage(24, 3, 1, '第三轮的问题'),
    toolCall(25, 3, 1, 'B'),
    toolResult(26, 3, 1, 'B'),
    stepEnd(27, 3, 1),
    turnEnd(28, 3),
    { type: 'workspace/changes', seq: 29, time: 29, data: { files: ['a.txt'] } },
  ]
}

/** 种子必须是一条自洽的日志：seq 连续、turn/step 从 1 起连续、每个 step/end 有配对。 */
function assertSelfConsistent(seed) {
  seed.forEach((event, index) => assert.equal(event.seq, index, 'seq 必须从 0 连续'))
  const turns = new Set()
  const stepsByTurn = new Map()
  for (const event of seed) {
    const turn = event.data?.turn
    const step = event.data?.step
    if (typeof turn === 'number') turns.add(turn)
    if (typeof turn === 'number' && typeof step === 'number') {
      const steps = stepsByTurn.get(turn) ?? new Set()
      steps.add(step)
      stepsByTurn.set(turn, steps)
    }
    if (event.type === 'step/end') {
      assert.ok(seed.some(other => other.type === 'step/start' && other.data.turn === turn && other.data.step === step),
        'step/end 必须有同 turn/step 的 step/start')
    }
  }
  const turnList = [...turns].sort((left, right) => left - right)
  assert.deepEqual(turnList, turnList.map((_, index) => index + 1), 'turn 必须从 1 起连续')
  for (const [turn, steps] of stepsByTurn) {
    const list = [...steps].sort((left, right) => left - right)
    assert.deepEqual(list, list.map((_, index) => index + 1), 'turn ' + String(turn) + ' 的 step 必须从 1 起连续')
  }
  for (const event of seed) {
    if (event.type === 'assistant/message' && event.sourceEventSeqs !== undefined) {
      assert.ok(Array.isArray(event.sourceEventSeqs) && event.sourceEventSeqs.length > 0,
        'assistant/message 不携带空的 sourceEventSeqs')
    }
  }
  // 非模型可见事件不得携带 surface 元数据
  const surfaceTypes = new Set(['system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result'])
  for (const event of seed) {
    if (surfaceTypes.has(event.type)) {
      assert.ok(event.surfaceOp === 'append' || event.surfaceOp?.op === 'replace', event.type + ' 必须有 surfaceOp')
    } else {
      assert.equal(event.surfaceOp, undefined, event.type + ' 不得携带 surfaceOp')
      assert.equal(event.sourceEventSeqs, undefined, event.type + ' 不得携带 sourceEventSeqs')
    }
  }
  // 替换引用只能指向更早的事件
  for (const event of seed) {
    if (event.surfaceOp?.op !== 'replace') continue
    assert.ok(event.surfaceOp.startSeq < event.seq && event.surfaceOp.endSeq < event.seq, 'replace 必须指向更早的 seq')
  }
}

test('压缩点之后重建尾部：起点是摘要、继承运行态、丢掉压缩事务', () => {
  const built = buildTailSeed(fixture())
  assert.equal(built.error, undefined)
  const { seed, stats } = built
  assertSelfConsistent(seed)

  assert.deepEqual(seed.slice(0, 3).map(event => event.type),
    ['permission/preset', 'session/title', 'model/selection'], '运行态取旧日志里的最后一次，放在头部')
  assert.deepEqual(seed.slice(3, 6).map(event => event.type), ['turn/start', 'step/start', 'system/message'],
    '头部自成一轮，system/message 占住 surface 的 0 号节点')
  assert.equal(seed[5].data.message.role, 'system')
  assert.deepEqual(seed.slice(7, 9).map(event => event.type), ['step/end', 'turn/end'], '头部这一轮自己收口')
  assert.equal(seed[6].type, 'user/message')
  assert.equal(seed[6].surfaceOp, 'append', '被遮住的历史正好是要丢的部分，替换降级为追加')
  assert.equal(seed[6].data.turn, 1, '摘要归头部那一轮')
  assert.equal(seed[6].data.content[1].text, '模型写的摘要')
  assert.match(seed[6].data.content[0].text, /【压缩摘要】/, '摘要前置一段说明，前台才看得见它是什么')

  assert.equal(seed.some(event => event.type.startsWith('compaction/')), false, '不保留 compression 事务事件')
  assert.equal(seed.some(event => event.type === 'workspace/changes'), false, 'turn/end 之后的簿记事件丢弃')

  assert.equal(stats.checkpointSeq, 16)
  assert.equal(stats.interruptedTurnEvents, 3, '压缩点所在 turn 的后半截保留 3 条')
  assert.equal(stats.droppedOrphans, 1, 'tool/call 落在压缩区的 tool/result 被剔除')
  assert.equal(seed.some(event => event.type === 'tool/result' && event.data.message.source.callId === 'Z'), false)
})

test('压缩点所在 turn 的后半截：合成 turn/start，turn/step 从 1 重排', () => {
  const { seed } = buildTailSeed(fixture())
  const synthetic = seed[9]
  assert.equal(synthetic.type, 'turn/start')
  assert.equal(synthetic.data.turn, 2, '头部占了 turn 1，后半截接着排 turn 2')
  const copied = seed.slice(9).filter(event => typeof event.data?.turn === 'number')
  assert.deepEqual([...new Set(copied.map(event => event.data.turn))], [2, 3], '后半截 turn 与之后的完整轮次')
  // 后半截原本只剩 step 2：它自己那一轮的 step 从 1 重排
  const keptStep = copied.find(event => event.type === 'step/start' && event.data.turn === 2)
  assert.equal(keptStep.data.step, 1)
})

test('--drop-open-turn：只保留压缩点之后完整结束的轮次', () => {
  const built = buildTailSeed(fixture(), { includeInterruptedTurn: false })
  assert.equal(built.error, undefined)
  assertSelfConsistent(built.seed)
  assert.equal(built.stats.interruptedTurnEvents, 0)
  assert.equal(built.seed.some(event => event.type === 'tool/result' && event.data.message.source.callId === 'Z'), false)
  const turns = [...new Set(built.seed.map(event => event.data?.turn).filter(turn => typeof turn === 'number'))]
  assert.deepEqual(turns.sort((left, right) => left - right), [1, 2], '头部一轮 + 最后一个完整轮次')
  assert.equal(built.seed[6].type, 'user/message')
  assert.equal(built.seed[6].data.turn, 1, '检查点归头部那一轮')
  assert.equal(built.seed[9].type, 'turn/start')
  assert.equal(built.seed[9].data.turn, 2)
})

test('标题加上尾部会话后缀，并清空指向旧消息的引用', () => {
  const { seed } = buildTailSeed(fixture())
  const title = seed.find(event => event.type === 'session/title')
  assert.equal(title.data.title, '压缩点之后的尾巴 · 尾部会话')
  assert.deepEqual(title.data.messageSeqs, [])
})

test('拒绝执行的情形', () => {
  assert.equal(buildTailSeed([turnStart(0, 1), turnEnd(1, 1)]).error, 'no-compaction')
  const noClosed = fixture().filter(event => event.seq <= 18)
  assert.equal(buildTailSeed(noClosed).error, 'no-closed-turn')
  const openTurn = [...fixture(), turnStart(30, 4)]
  assert.equal(buildTailSeed(openTurn).error, 'turn-open')
})

/** 工具增量消息：它引用的 request/header 落在压缩区里（必须被补进种子）。 */
function fixtureWithToolAddition(headerSeqForMessage = 7) {
  return [
    { type: 'permission/preset', seq: 0, time: 0, data: { preset: 'standard' } },
    turnStart(1, 1),
    userMessage(2, 1, 1, '第一轮'),
    stepStart(3, 1, 1),
    assistantMessage(4, 1, 1, '回答'),
    stepEnd(5, 1, 1),
    turnEnd(6, 1),
    { type: 'request/header', seq: 7, time: 7, data: { header: { config: {}, adapterDefaults: {}, tools: [{ name: 'x', description: 'tool x', inputSchema: { type: 'object' } }] }, reason: 'initial' } },
    turnStart(8, 2),
    userMessage(9, 2, 1, '第二轮（会被压缩）'),
    stepStart(10, 2, 1),
    stepEnd(11, 2, 1),
    compaction(12, 'compaction/start'),
    compaction(13, 'compaction/summary'),
    userMessage(14, 2, 1, '模型写的摘要', { op: 'replace', startSeq: 9, endSeq: 11 }),
    compaction(15, 'compaction/end'),
    stepStart(16, 2, 2),
    {
      type: 'developer/message', seq: 17, time: 17,
      data: { headerSeq: headerSeqForMessage, message: { role: 'developer', content: [{ type: 'tool-addition', toolName: 'x' }] } },
      surfaceOp: 'append',
    },
    assistantMessage(18, 2, 2, '带上新工具接着干'),
    stepEnd(19, 2, 2),
    turnEnd(20, 2),
  ]
}

test('developer/message 的 headerSeq 重映射，被切掉的 request/header 补进种子', () => {
  const { seed, stats } = buildTailSeed(fixtureWithToolAddition())
  assertSelfConsistent(seed)
  assert.equal(stats.droppedDevMessages, 0)
  const headerIndex = seed.findIndex(event => event.type === 'request/header')
  const devIndex = seed.findIndex(event => event.type === 'developer/message')
  assert.ok(headerIndex >= 0, '请求头必须补进种子')
  assert.ok(headerIndex < devIndex, '请求头必须排在引用它的消息之前')
  assert.equal(seed[devIndex].data.headerSeq, headerIndex, 'headerSeq 必须指向重排后的请求头')
  const toolNames = (seed[headerIndex].data.header.tools ?? []).map(tool => tool.name)
  assert.deepEqual(toolNames, ['x'], '请求头必须仍带有该工具的完整定义')
})

test('请求头补不回来时，丢弃这条工具增量消息', () => {
  const { seed, stats } = buildTailSeed(fixtureWithToolAddition(999))
  assert.equal(stats.droppedDevMessages, 1)
  assert.equal(seed.some(event => event.type === 'developer/message'), false)
  assert.equal(seed.some(event => event.type === 'request/header'), false)
  assertSelfConsistent(seed)
})

test('--turns N：只保留压缩点之后最后 N 个完整轮次', () => {
  const built = buildTailSeed(fixture(), { turns: 1 })
  assert.equal(built.error, undefined)
  assertSelfConsistent(built.seed)
  assert.equal(built.stats.keptTurns, 1)
  assert.equal(built.stats.interruptedTurnEvents, 0, '指定轮次时不接被打断的那半截')
  assert.equal(built.stats.summaryKept, true)
  const turnsSeen = [...new Set(built.seed.map(event => event.data?.turn).filter(turn => typeof turn === 'number'))]
  assert.deepEqual(turnsSeen.sort((left, right) => left - right), [1, 2], '头部一轮 + 最后一个完整轮次')
  assert.equal(built.seed.filter(event => event.type === 'turn/start').length, 2)
})

test('--drop-summary：不带压缩摘要，从第一个完整轮次开始', () => {
  const built = buildTailSeed(fixture(), { includeSummary: false })
  assert.equal(built.error, undefined)
  assertSelfConsistent(built.seed)
  assert.equal(built.stats.summaryKept, false)
  assert.equal(built.stats.interruptedTurnEvents, 0)
  assert.equal(JSON.stringify(built.seed).includes('模型写的摘要'), false, '摘要消息整条不带')
  assert.deepEqual(built.seed.slice(0, 3).map(event => event.type),
    ['permission/preset', 'session/title', 'model/selection'], '运行态仍从旧日志继承')
  assert.equal(built.seed[3].type, 'turn/start')
  assert.equal(built.stats.keptTurns, 1)
})

test('轮次不够时报 not-enough-turns', () => {
  const built = buildTailSeed(fixture(), { turns: 99 })
  assert.equal(built.error, 'not-enough-turns')
  assert.deepEqual(built.detail, { available: 1, requested: 99 })
})

test('别人的分叉标记不跟着搬：session/end-seed 丢弃', () => {
  const events = fixture()
  events.splice(29, 0, { type: 'session/end-seed', seq: 29, time: 29, data: { inherited: true } })
  events.forEach((event, index) => { event.seq = index })
  const built = buildTailSeed(events)
  assert.equal(built.error, undefined)
  assert.equal(built.seed.some(event => event.type === 'session/end-seed'), false)
  assertSelfConsistent(built.seed)
})

test('命令行参数：三个开关与 --turns 的两种写法', () => {
  assert.deepEqual(parseArguments(''), { options: { includeInterruptedTurn: true, includeSummary: true, turns: undefined } })
  assert.deepEqual(parseArguments('--drop-open-turn').options, { includeInterruptedTurn: false, includeSummary: true, turns: undefined })
  assert.deepEqual(parseArguments('--drop-summary').options, { includeInterruptedTurn: true, includeSummary: false, turns: undefined })
  assert.equal(parseArguments('--turns 3').options.turns, 3)
  assert.equal(parseArguments('--turns=7').options.turns, 7)
  assert.equal(parseArguments('--turns 3 --drop-summary').options.includeSummary, false)
  assert.equal(parseArguments('--turns 3 --drop-open-turn').options.includeInterruptedTurn, false)
  assert.equal(parseArguments('--turns').error !== undefined, true, '缺数字要报用法')
  assert.equal(parseArguments('--turns 0').error !== undefined, true)
  assert.equal(parseArguments('--turns abc').error !== undefined, true)
  assert.equal(parseArguments('--nope').error !== undefined, true)
  assert.equal(parseArguments('3').error !== undefined, true)
})

test('宿主簿记事件不搬：队列拼接、任务注册、命令卡、分叉标记', () => {
  const events = fixture()
  const extra = [
    { type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] } },
    { type: 'job/registered', data: { jobId: 'j1' } },
    { type: 'job/settled', data: { jobId: 'j1' } },
    { type: 'llm/retry', data: { attempt: 2 } },
    { type: 'assistant/attempt', data: { stream: {} } },
    { type: 'command/run', data: { commandId: 'c1', name: 'compact' } },
    { type: 'command/done', data: { commandId: 'c1', kind: 'success' } },
    { type: 'session/end-seed', data: { inherited: true } },
  ]
  // 把它们塞进第二个完整轮次里
  events.splice(23, 0, ...extra)
  events.forEach((event, index) => { event.seq = index })
  const built = buildTailSeed(events)
  assert.equal(built.error, undefined)
  assertSelfConsistent(built.seed)
  for (const type of ['agent/inbox/spliced', 'job/registered', 'job/settled', 'llm/retry', 'assistant/attempt', 'command/run', 'command/done', 'session/end-seed']) {
    assert.equal(built.seed.some(event => event.type === type), false, type + ' 不该搬过去')
  }
  assert.ok(built.stats.droppedBookkeeping >= 8, '要记账丢了多少条')
  // 对话本身不能丢
  assert.equal(built.seed.filter(event => event.type === 'user/message').length, 2)
})


test('浏览器半边的请求体：缺 sessionId、轮次不合法都要拒绝', () => {
  assert.deepEqual(parseRunBody({ sessionId: 'session-x' }), {
    sessionId: 'session-x',
    options: { includeInterruptedTurn: true, includeSummary: true, turns: undefined },
  })
  assert.deepEqual(parseRunBody({ sessionId: 'session-x', turns: 3, includeSummary: false, includeInterruptedTurn: false }), {
    sessionId: 'session-x',
    options: { includeInterruptedTurn: false, includeSummary: false, turns: 3 },
  })
  // 空串轮次等于"不填"，走全部完整轮次
  assert.equal(parseRunBody({ sessionId: 'session-x', turns: null }).options.turns, undefined)
  assert.match(parseRunBody({}).error, /sessionId/)
  assert.match(parseRunBody(null).error, /JSON/)
  assert.match(parseRunBody({ sessionId: 'session-x', turns: 0 }).error, /整数/)
  assert.match(parseRunBody({ sessionId: 'session-x', turns: 2.5 }).error, /整数/)
  assert.match(parseRunBody({ sessionId: 'session-x', turns: '3' }).error, /整数/)
})


test('压缩摘要在新会话最前面作为普通用户消息出现', () => {
  const built = buildTailSeed(fixture())
  assert.equal(built.error, undefined)
  assertSelfConsistent(built.seed)
  const first = built.seed.find(event => event.type === 'user/message')
  assert.ok(first, '种子里必须有那条摘要消息')
  // 客户端把 compact-checkpoint 源的 user/message 当上下文注入渲染，前台看不到正文；
  // 搬过来必须换成普通用户消息，摘要才会出现在对话最前面。
  assert.equal(first.data.source.kind, 'user')
  assert.match(first.data.content[0].text, /【压缩摘要】/)
  assert.equal(first.data.content[1].text, '模型写的摘要')
  // 它前面只有搬过来的运行态记录和"分切说明"那一轮：摘要就是新会话的第一条对话内容。
  assert.deepEqual(built.seed.slice(0, first.seq).map(event => event.type),
    ['permission/preset', 'session/title', 'model/selection', 'turn/start', 'step/start', 'system/message'])
  // 摘要本身不能被改写
  assert.equal(built.seed.filter(event => event.type === 'user/message').length, 2)
})


test('新会话名称：给了就整条照用，没给才拼后缀', () => {
  const withName = buildTailSeed(fixture(), { title: '我的尾部会话' })
  assert.equal(withName.error, undefined)
  assertSelfConsistent(withName.seed)
  const titleEvent = withName.seed.find(event => event.type === 'session/title')
  assert.equal(titleEvent.data.title, '我的尾部会话')
  assert.equal(withName.stats.title, '我的尾部会话')
  // 名字要排在对话之前
  assert.ok(titleEvent.seq < withName.seed.findIndex(event => event.type === 'user/message'))

  const defaulted = buildTailSeed(fixture())
  assert.equal(defaulted.seed.find(event => event.type === 'session/title').data.title, '压缩点之后的尾巴 · 尾部会话')
  assert.equal(defaulted.stats.title, undefined)
})

test('旧日志没有标题时，用户给的名字会合成一条 session/title', () => {
  const events = fixture().filter(event => event.type !== 'session/title')
  events.forEach((event, index) => { event.seq = index })
  const built = buildTailSeed(events, { title: '无题也能起名' })
  assert.equal(built.error, undefined)
  assertSelfConsistent(built.seed)
  const titleEvent = built.seed.find(event => event.type === 'session/title')
  assert.equal(titleEvent?.data.title, '无题也能起名')
  // 合成的标题不进 seqMap：压缩点仍然是普通用户消息，没被换成别的
  assert.equal(built.seed.filter(event => event.type === 'user/message').length, 2)
})

test('名称的收敛规则：空白折叠、去首尾空白、超长拒绝、非文本忽略', () => {
  assert.deepEqual(normalizeTitle('  我的   尾部  '), { title: '我的 尾部' })
  assert.deepEqual(normalizeTitle('   '), { title: undefined })
  assert.deepEqual(normalizeTitle(undefined), { title: undefined })
  assert.deepEqual(normalizeTitle(42), { title: undefined })
  assert.equal(normalizeTitle('长'.repeat(81)).error, 'bad-title')
  assert.deepEqual(parseRunBody({ sessionId: 'session-x', title: ' 新名字 ' }).options, {
    includeInterruptedTurn: true, includeSummary: true, turns: undefined, title: '新名字',
  })
  assert.match(parseRunBody({ sessionId: 'session-x', title: '长'.repeat(81) }).error, /最长 80/)
  assert.deepEqual(parseArguments('--title=命令行起名').options.title, '命令行起名')
  assert.deepEqual(parseArguments('--title 空格 前 的名字').options.title, '空格 前 的名字')
  assert.match(parseArguments('--title').error, /用法/)
  // 名字吃掉后面整行，前面的开关照旧生效
  assert.deepEqual(parseArguments('--turns 3 --title 我的 尾部').options, {
    includeInterruptedTurn: true, includeSummary: true, turns: 3, title: '我的 尾部',
  })
})

test('头部的 system/message 必须占住 surface 的 0 号节点（否则冷启动判定日志损坏）', () => {
  for (const options of [{}, { includeInterruptedTurn: false }, { turns: 1 }, { includeSummary: false }]) {
    const built = buildTailSeed(fixture(), options)
    assert.equal(built.error, undefined)
    const surfaceTypes = new Set(['system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result'])
    const firstSurface = built.seed.find(event => surfaceTypes.has(event.type))
    assert.equal(firstSurface.type, 'system/message',
      'surface 头必须是 system/message：' + JSON.stringify(options))
  }
  // 没摘要时头部只剩 system/message，那一轮依然自洽
  const noSummary = buildTailSeed(fixture(), { includeSummary: false })
  assert.deepEqual(noSummary.seed.slice(3, 8).map(event => event.type),
    ['turn/start', 'step/start', 'system/message', 'step/end', 'turn/end'])
  assertSelfConsistent(noSummary.seed)
})


test('预设：默认跟随原会话，也能指定 id', () => {
  assert.deepEqual(normalizePreset(undefined), { preset: undefined })
  assert.deepEqual(normalizePreset(''), { preset: undefined })
  assert.deepEqual(normalizePreset('   '), { preset: undefined })
  assert.deepEqual(normalizePreset('  standard '), { preset: 'standard' })
  assert.equal(normalizePreset('x'.repeat(65)).error, 'bad-preset')

  // 不写 --preset 时没有该字段：宿主回落到"跟随原会话"
  assert.equal(parseArguments('').options.preset, undefined)
  assert.deepEqual(parseArguments('--preset standard').options.preset, 'standard')
  assert.deepEqual(parseArguments('--preset=minimal').options.preset, 'minimal')
  assert.deepEqual(parseArguments('--turns 2 --preset plan').options.preset, 'plan')
  assert.match(parseArguments('--preset').error, /用法/)
  assert.match(parseArguments('--preset=' + 'x'.repeat(65)).error, /预设/)

  // 请求体同样：缺省 = 跟随原会话
  assert.equal(parseRunBody({ sessionId: 'session-x' }).options.preset, undefined)
  assert.equal(parseRunBody({ sessionId: 'session-x', preset: '' }).options.preset, undefined)
  assert.deepEqual(parseRunBody({ sessionId: 'session-x', preset: 'minimal' }).options, {
    includeInterruptedTurn: true, includeSummary: true, turns: undefined, preset: 'minimal',
  })
})
