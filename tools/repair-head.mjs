#!/usr/bin/env node
/**
 * 修复 0.3.0 及更早版本分切出来的会话：给日志补一个占住 surface 0 号节点的 system/message。
 *
 * 症状：重启后打开会话报
 *   stored session "…" is corrupt: SessionFormatError: system/message requires a protected first surface head
 * 原因：那条日志的 surface 从一条 user/message（压缩摘要）开始，之后 agent-loop 又追加了一条
 * system/message；服务端校验要求 system/message 必须是 surface 的 0 号节点，于是整条日志判损坏。
 *
 * 做法：在第一条 surface 事件之前插入自成一轮的头部
 *   turn/start → step/start → system/message → step/end → turn/end
 * 并把原有事件的 seq 整体后移、turn 号 +1、所有引用（surfaceOp / sourceEventSeqs /
 * headerSeq / messageSeqs / shadowedRange …）同步重映射。对话内容一个字都不动。
 *
 * 用法：
 *   node tools/repair-head.mjs <session.v4.jsonl.zstd> [--write] [--zstd <zstd 可执行文件>]
 * 不加 --write 只检查并打印将要做什么（dry run）。
 */
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'

const SURFACE_TYPES = new Set(['system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result'])
const HEAD_NOTE = '这一轮的上下文来自旧会话压缩点之后的部分，压缩点之前的对话不在本会话里。'
const GROUP = 5

const ZSTD_MAGIC = 0xfd2fb528
/** 与 session-persistence-jsonl 的 CHECKSUM_OPTIONS 一致：每帧自带 xxhash 校验。 */
const CHECKSUM_OPTIONS = { params: { [constants.ZSTD_c_checksumFlag]: 1 } }

const args = process.argv.slice(2)
const file = args.find(arg => !arg.startsWith('--'))
const write = args.includes('--write')
if (file === undefined) {
  console.error('用法：node tools/repair-head.mjs <session.v4.jsonl.zstd> [--write]')
  process.exit(2)
}
if (typeof zstdCompressSync !== 'function') throw new Error('这个 Node 没有 zlib zstd（需要 Node >= 22.15），换一个解释器再跑')

/**
 * 定位连帧流里的完整帧（结构扫描，不解压）。
 * 日志格式是"多帧拼接"，第一帧必须恰好是头部那一行，所以不能整段重压成一个帧。
 * @param buffer - 文件字节。
 * @returns 完整帧的字节范围；还有没写完的尾帧时给出它的起点。
 */
function scanFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error('帧魔数不对，位置 ' + String(offset))
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      if (blockType === 0x03) throw new Error('保留了不该出现的块类型，位置 ' + String(offset - 3))
      const payloadBytes = blockType === 0x01 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return { frames }
}

/** 解出整条日志文本；尾帧没写完时拒绝动手，免得丢事件。 */
const decode = (target) => {
  const buffer = readFileSync(target)
  const { frames, tornStart } = scanFrames(buffer)
  if (tornStart !== undefined) throw new Error('文件尾部有一帧没写完（torn frame），不动它')
  return frames.map(frame => zstdDecompressSync(buffer.subarray(frame.start, frame.end)).toString('utf8')).join('')
}

/** 写回：第一帧只放头部那一行，第二帧放全部事件——持久化层就是这么校验的。 */
const encode = (target, headerLine, eventLines) => {
  const frame = (text) => zstdCompressSync(Buffer.from(text, 'utf8'), CHECKSUM_OPTIONS)
  const frames = [frame(headerLine + '\n')]
  if (eventLines.length > 0) frames.push(frame(eventLines.join('\n') + '\n'))
  writeFileSync(target, Buffer.concat(frames))
}

let lines
try {
  lines = decode(file).split('\n').filter(line => line.length > 0)
} catch (error) {
  console.error('跳过：' + String(error instanceof Error ? error.message : error))
  process.exit(1)
}
const header = JSON.parse(lines[0])
const events = lines.slice(1).map(line => JSON.parse(line))
events.forEach((event, index) => {
  if (event.seq !== index) throw new Error('日志的 seq 与行号不一致（第 ' + String(index) + ' 行是 ' + String(event.seq) + '），不做修复')
})

const firstSurfaceIndex = events.findIndex(event => SURFACE_TYPES.has(event.type))
if (firstSurfaceIndex < 0) throw new Error('日志里没有任何 surface 事件，不像分切出来的会话')
const firstSurface = events[firstSurfaceIndex]
const systemSeqs = events.filter(event => event.type === 'system/message').map(event => event.seq)

if (firstSurface.type === 'system/message') {
  console.log('不需要修复：surface 头已经是 system/message（seq ' + String(firstSurface.seq) + '）')
  process.exit(0)
}
if (systemSeqs.length === 0) {
  console.log('不需要修复：日志里没有 system/message，不会触发受保护头校验')
  process.exit(0)
}

// 旧 turn 号必须是从 1 起的连续整数，整体 +1 才不会留空号
const turns = [...new Set(events.map(event => event.data?.turn).filter(turn => typeof turn === 'number'))].sort((left, right) => left - right)
if (turns.length === 0 || turns.some((turn, index) => turn !== index + 1)) {
  throw new Error('turn 号不是从 1 起的连续整数（' + turns.join(',') + '），不做修复')
}

const shifted = (seq) => (seq >= firstSurfaceIndex ? seq + GROUP : seq)
const remapNumber = (value) => (typeof value === 'number' ? shifted(value) : value)
const remapList = (list) => (Array.isArray(list) ? list.map(value => remapNumber(value)) : list)
const remapEvent = (event, seq) => {
  const clone = JSON.parse(JSON.stringify(event))
  clone.seq = seq
  if (typeof clone.data?.turn === 'number') clone.data.turn = clone.data.turn + 1
  if (typeof clone.data?.headerSeq === 'number') clone.data.headerSeq = remapNumber(clone.data.headerSeq)
  if (typeof clone.data?.sourceEventSeq === 'number') clone.data.sourceEventSeq = remapNumber(clone.data.sourceEventSeq)
  if (Array.isArray(clone.data?.messageSeqs)) clone.data.messageSeqs = remapList(clone.data.messageSeqs)
  if (Array.isArray(clone.data?.shadowedSeqs)) clone.data.shadowedSeqs = remapList(clone.data.shadowedSeqs)
  if (clone.data?.shadowedRange !== undefined) {
    clone.data.shadowedRange = {
      ...clone.data.shadowedRange,
      start: remapNumber(clone.data.shadowedRange.start),
      end: remapNumber(clone.data.shadowedRange.end),
    }
  }
  if (Array.isArray(clone.sourceEventSeqs)) clone.sourceEventSeqs = remapList(clone.sourceEventSeqs)
  if (clone.surfaceOp !== undefined && typeof clone.surfaceOp === 'object') {
    clone.surfaceOp = { ...clone.surfaceOp, startSeq: remapNumber(clone.surfaceOp.startSeq), endSeq: remapNumber(clone.surfaceOp.endSeq) }
  }
  return clone
}

const time = firstSurface.time
const head = [
  { type: 'turn/start', seq: firstSurfaceIndex, time, data: { turn: 1 } },
  { type: 'step/start', seq: firstSurfaceIndex + 1, time, data: { turn: 1, step: 1 } },
  {
    type: 'system/message',
    seq: firstSurfaceIndex + 2,
    time,
    data: {
      turn: 1,
      step: 1,
      message: {
        role: 'system',
        content: [{ type: 'text', text: HEAD_NOTE }],
        source: { kind: 'system-prompt' },
        id: 'rebase-tail-head',
      },
    },
    surfaceOp: 'append',
  },
  { type: 'step/end', seq: firstSurfaceIndex + 3, time, data: { turn: 1, step: 1 } },
  { type: 'turn/end', seq: firstSurfaceIndex + 4, time, data: { turn: 1, reason: { kind: 'completed' } } },
]

const repaired = [
  ...events.slice(0, firstSurfaceIndex).map(event => remapEvent(event, event.seq)),
  ...head,
  ...events.slice(firstSurfaceIndex).map(event => remapEvent(event, event.seq + GROUP)),
]

const headerLine = JSON.stringify(header)
const eventLines = repaired.map(event => JSON.stringify(event))
console.log('文件：' + file)
console.log('事件：' + String(events.length) + ' -> ' + String(repaired.length))
console.log('插入点：第一条 surface 事件（' + firstSurface.type + '）之前，原 seq ' + String(firstSurface.seq))
console.log('整体后移：seq >= ' + String(firstSurfaceIndex) + ' 的全部 +' + String(GROUP) + '，turn 号全部 +1')
console.log('原有 system/message：' + systemSeqs.join(',') + '（保持原样，现在排在受保护头之后）')
if (!write) {
  console.log('dry run：没有写盘。加 --write 才会改文件（会先备份 <file>.bak）。')
  process.exit(0)
}
copyFileSync(file, file + '.bak')
encode(file, headerLine, eventLines)
console.log('已修复并写回（原文件备份为 ' + file.split(/[\\/]/).pop() + '.bak）')
