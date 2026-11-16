/**
 * buildTailSeed 的不变量测试：用合成日志覆盖"压缩发生在 turn 中间"的全部边界。
 * 不依赖 dsh 的任何包，node --test 直接跑。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { buildTailSeed } from '../src/tail-seed.js'

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
    userMessage(16, 2, 1, '模型写的摘要', { op: 'replace', startSeq: 10, endSeq: 13 }),
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
  assert.equal(seed[3].type, 'user/message')
  assert.equal(seed[3].surfaceOp, 'append', '被遮住的历史正好是要丢的部分，替换降级为追加')
  assert.equal(seed[3].data.message.content, '模型写的摘要')

  assert.equal(seed.some(event => event.type.startsWith('compaction/')), false, '不保留 compression 事务事件')
  assert.equal(seed.some(event => event.type === 'workspace/changes'), false, 'turn/end 之后的簿记事件丢弃')

  assert.equal(stats.checkpointSeq, 16)
  assert.equal(stats.interruptedTurnEvents, 3, '压缩点所在 turn 的后半截保留 3 条')
  assert.equal(stats.droppedOrphans, 1, 'tool/call 落在压缩区的 tool/result 被剔除')
  assert.equal(seed.some(event => event.type === 'tool/result' && event.data.message.source.callId === 'Z'), false)
})

test('压缩点所在 turn 的后半截：合成 turn/start，turn/step 从 1 重排', () => {
  const { seed } = buildTailSeed(fixture())
  const synthetic = seed[4]
  assert.equal(synthetic.type, 'turn/start')
  assert.equal(synthetic.data.turn, 1)
  const afterCheckpoint = seed.slice(4).filter(event => typeof event.data?.turn === 'number')
  assert.deepEqual([...new Set(afterCheckpoint.map(event => event.data.turn))], [1, 2], '只剩后半截 turn 与之后的完整轮次')
  // turn 2 只剩 step 2，重排后必须变成 step 1
  // 检查点自己占住 turn 1 / step 1，后半截的 step 2 重排后仍是 2（顺序不乱）
  assert.equal(seed[3].data.step, 1)
  const keptStep = afterCheckpoint.find(event => event.type === 'step/start' && event.data.turn === 1)
  assert.equal(keptStep.data.step, 2)
})

test('--drop-open-turn：只保留压缩点之后完整结束的轮次', () => {
  const built = buildTailSeed(fixture(), { includeInterruptedTurn: false })
  assert.equal(built.error, undefined)
  assertSelfConsistent(built.seed)
  assert.equal(built.stats.interruptedTurnEvents, 0)
  assert.equal(built.seed.some(event => event.type === 'tool/result' && event.data.message.source.callId === 'Z'), false)
  const turns = [...new Set(built.seed.map(event => event.data?.turn).filter(turn => typeof turn === 'number'))]
  assert.deepEqual(turns.sort((left, right) => left - right), [1], '只剩一个完整轮次，重排为 turn 1')
  assert.equal(built.seed[3].type, 'user/message')
  assert.equal(built.seed[3].data.turn, undefined, '检查点不再属于任何轮次')
  assert.equal(built.seed[4].type, 'turn/start')
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
