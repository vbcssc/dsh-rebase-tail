/**
 * /rebase-tail —— 把"最近一次压缩之后"的对话重建为一个新会话。
 *
 * 动机：压缩只是把旧历史从模型可见面里遮住，日志本身仍然保留全部事件；
 * 分叉（session/fork）复制的也是整条前缀。于是一个跑过几十轮上千步的会话，
 * 无论分叉多少次都背着最初那份 200MB 级的日志。本插件把尾部真正搬进一个
 * 新会话：被压缩掉的事件不再出现在新会话的任何位置。
 *
 * 装配：host 平面插件（无客户端代码），注册一条斜杠命令。
 * 依赖的宿主服务全部通过 ctx 取，不 import 任何 @deepseek-ai/* 包，
 * 因此插件目录不需要自己的 node_modules，也不会被 dsh 升级打断。
 * @module dsh-rebase-tail
 */

import { randomUUID } from 'node:crypto'
import { buildTailSeed } from './tail-seed.js'

export const name = 'dsh-rebase-tail'

const USAGE = '用法：/rebase-tail [--drop-open-turn]'
const ERROR_TEXT = {
  'no-compaction': '这个会话还没有压缩点（没有 compaction/summary），没有包袱可甩。',
  'no-checkpoint': '最后一次压缩没有留下检查点消息，无法定位尾部起点。',
  'no-closed-turn': '压缩点之后没有任何完整结束的轮次，无法重建会话。',
  'turn-open': '当前这一轮还没结束。等它跑完再执行 /rebase-tail。',
}

/** 最后一个 model/selection 记录的路线，用作新会话的初始路线。 */
function lastSelection(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event.type !== 'model/selection') continue
    const data = event.data
    if (typeof data?.provider !== 'string' || typeof data?.model !== 'string') return undefined
    return {
      provider: data.provider,
      model: data.model,
      ...(typeof data.reasoningEffort === 'string' ? { reasoningEffort: data.reasoningEffort } : {}),
    }
  }
  return undefined
}

/** 组装新 Agent 的预先发布 setup：绑定父会话当前的 agent preset。 */
function compositionFor(ctx, session) {
  const presets = ctx.get('agentPresets')
  if (presets === undefined) return { presetId: undefined, setup: () => {} }
  const current = presets.presetForSession?.(session)
  return {
    presetId: current,
    setup: async (agentCtx) => {
      // 会话记录的 preset 可能已经被删除或改名：退回默认 preset，而不是让整条命令失败。
      let resolved
      try {
        resolved = await presets.resolve(current)
      } catch (error) {
        ctx.logger?.warn?.('rebase-tail: preset ' + String(current) + ' 不可用，改用默认 preset：' + String(error))
        resolved = await presets.resolve(undefined)
      }
      await presets.mount(agentCtx, resolved.id)
    },
  }
}

/** 把新会话挂到父会话所在的工作区，失败不致命。 */
async function attachWorkspace(ctx, parentSessionId, childSessionId) {
  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined) return false
  try {
    const workspace = registry.list().find(candidate => candidate.sessionIds.includes(parentSessionId))
    if (workspace === undefined) return false
    await workspace.attachSession(childSessionId)
    return true
  } catch (error) {
    ctx.logger?.warn?.('rebase-tail: 新会话已创建，但挂工作区失败：' + String(error))
    return false
  }
}

/**
 * 执行一次 /rebase-tail。
 * @param ctx - 命令所在上下文。
 * @param invocation - 命令调用。
 * @returns 命令结果。
 */
async function execute(ctx, invocation) {
  const raw = invocation.rawInput.trim()
  if (raw.length > 0 && raw !== '--drop-open-turn') return { kind: 'error', text: USAGE }

  const parent = invocation.agent.session
  const observation = await ctx.sessionQuery.observeSession(parent.id, { signal: invocation.signal })
  try {
    const built = buildTailSeed(observation.events, { includeInterruptedTurn: raw !== '--drop-open-turn' })
    if (built.error !== undefined) return { kind: 'error', text: ERROR_TEXT[built.error] ?? built.error }

    const header = observation.header
    const selection = lastSelection(observation.events) ?? ctx.get('agentDefaultModel')?.currentSelection()
    const composition = compositionFor(ctx, parent)
    const childSessionId = 'session-' + randomUUID()
    await ctx.agents.create({
      sessionId: childSessionId,
      seed: built.seed,
      meta: {
        ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
        ...(composition.presetId === undefined ? {} : { agentPreset: composition.presetId }),
      },
      ...(selection === undefined ? {} : { agentOptions: selection }),
      setup: composition.setup,
    })
    const attached = await attachWorkspace(ctx, parent.id, childSessionId)

    const stats = built.stats
    return {
      kind: 'success',
      text: '已建好尾部会话 ' + childSessionId
        + '：' + String(stats.sourceEvents) + ' 条事件 -> ' + String(stats.seedEvents) + ' 条'
        + '（压缩点之后，含未完成轮次 ' + String(stats.interruptedTurnEvents) + ' 条）'
        + (stats.droppedOrphans > 0 ? '，剔除孤儿工具结果 ' + String(stats.droppedOrphans) + ' 条' : '')
        + (attached ? '，已挂到当前工作区' : '')
        + '。在会话列表里打开它继续。',
    }
  } finally {
    observation[Symbol.dispose]?.()
  }
}

/**
 * 注册 /rebase-tail。
 * @param ctx - 宿主上下文。
 */
export function apply(ctx) {
  ctx.inject(['commands', 'agents', 'sessions', 'sessionQuery'], (scoped) => {
    scoped.effect(
      () => scoped.commands.register({
        name: 'rebase-tail',
        description: '把最近一次压缩之后的对话作为新会话（甩掉已压缩的历史包袱）',
        handler: invocation => execute(scoped, invocation),
      }),
      'rebase-tail command',
    )
  })
}
