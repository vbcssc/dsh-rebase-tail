/**
 * dsh-rebase-tail —— 把"最近一次压缩之后"的对话重建为一个新会话。
 *
 * 动机：压缩只是把旧历史从模型可见面里遮住，日志本身仍然保留全部事件；
 * 分叉（session/fork）复制的也是整条前缀。于是一个跑过几十轮上千步的会话，
 * 无论分叉多少次都背着最初那份 200MB 级的日志。本插件把尾部真正搬进一个
 * 新会话：被压缩掉的事件不再出现在新会话的任何位置。
 *
 * 两个入口共用同一个执行体 {@link runRebase}：
 *  - 浏览器半边的工具栏按钮（src/client.js）走 {@link RUN_ROUTE}；
 *  - 斜杠命令 /rebase-tail 走 commands 席位，留给脚本与键盘用户。
 *
 * 依赖的宿主服务全部通过 ctx 取，不 import 任何 @deepseek-ai/* 包，
 * 因此插件目录不需要自己的 node_modules，也不会被 dsh 升级打断。
 * @module dsh-rebase-tail
 */

import { randomUUID } from 'node:crypto'
import { buildTailSeed } from './tail-seed.js'

export const name = 'dsh-rebase-tail'

/** 浏览器半边提交执行请求的路径。两条半边靠这个字面量对齐。 */
export const RUN_ROUTE = '/plugins/dsh-rebase-tail/run'

/** 一次执行请求的请求体上限：只有几个标量字段。 */
const MAX_BODY_BYTES = 8192

const USAGE = '用法：/rebase-tail [--turns N] [--drop-summary] [--drop-open-turn] [--title "新名字"]'
/** 标题长度上限：会话列表一行放得下，也拦住误粘一整段话。 */
const MAX_TITLE_LENGTH = 80
const ERROR_TEXT = {
  'no-compaction': '这个会话还没有压缩点（没有 compaction/summary），没有包袱可甩。',
  'no-checkpoint': '最后一次压缩没有留下检查点消息，无法定位尾部起点。',
  'no-closed-turn': '压缩点之后没有任何完整结束的轮次，无法重建会话。',
  'turn-open': '当前这一轮还没结束。等它跑完再分切。',
  'bad-turns': '保留轮次需要一个大于 0 的整数。',
  'bad-title': '新会话名称最长 ' + String(MAX_TITLE_LENGTH) + ' 个字符。',
}

/**
 * 解析命令行参数。
 * @param raw - 斜杠命令后面的原始文本。
 * @returns 选项，或 { error } 表示用法错误。
 */
export function parseArguments(raw) {
  const options = { includeInterruptedTurn: true, includeSummary: true, turns: undefined }
  const tokens = raw.split(/\s+/).filter(token => token.length > 0)
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === '--drop-open-turn') { options.includeInterruptedTurn = false; continue }
    if (token === '--drop-summary') { options.includeSummary = false; continue }
    const inline = token.startsWith('--turns=') ? token.slice('--turns='.length) : undefined
    if (token === '--turns' || inline !== undefined) {
      const value = inline ?? tokens[index + 1]
      const parsed = Number.parseInt(value ?? '', 10)
      if (!Number.isFinite(parsed) || parsed < 1) return { error: USAGE }
      options.turns = parsed
      if (inline === undefined) index += 1
      continue
    }
    const titleInline = token.startsWith('--title=') ? token.slice('--title='.length) : undefined
    if (token === '--title' || titleInline !== undefined) {
      // 竖线形式只能给一个词；空格分开的写法把**后面整行**都当名字，所以它必须放在最后。
      const value = titleInline ?? tokens.slice(index + 1).join(' ')
      if (titleInline === undefined && value.length === 0) return { error: USAGE }
      const normalized = normalizeTitle(value)
      if (normalized.error !== undefined) return { error: ERROR_TEXT['bad-title'] }
      if (normalized.title !== undefined) options.title = normalized.title
      if (titleInline === undefined) break
      continue
    }
    return { error: USAGE }
  }
  return { options }
}

/**
 * 收敛一个用户给出的会话名。
 * @param value - 原始输入。
 * @returns { title } 或 { error: 'bad-title' }（超过长度上限）。
 */
export function normalizeTitle(value) {
  if (typeof value !== 'string') return { title: undefined }
  const title = value.replace(/\s+/g, ' ').trim()
  if (title.length === 0) return { title: undefined }
  if (title.length > MAX_TITLE_LENGTH) return { error: 'bad-title' }
  return { title }
}

/**
 * 校验浏览器半边提交的请求体，并换成内部的选项字面量。
 * @param body - 已解析的 JSON 请求体。
 * @returns 会话 id 与选项，或 { error } 表示请求不合法。
 */
export function parseRunBody(body) {
  if (body === null || typeof body !== 'object') return { error: '请求体必须是一个 JSON 对象。' }
  const sessionId = body.sessionId
  if (typeof sessionId !== 'string' || sessionId.length === 0) return { error: '缺少 sessionId。' }
  const options = { includeInterruptedTurn: body.includeInterruptedTurn !== false, includeSummary: body.includeSummary !== false, turns: undefined }
  const normalizedTitle = normalizeTitle(body.title)
  if (normalizedTitle.error !== undefined) return { error: ERROR_TEXT['bad-title'] }
  if (normalizedTitle.title !== undefined) options.title = normalizedTitle.title
  if (body.turns !== undefined && body.turns !== null) {
    const turns = body.turns
    if (!Number.isSafeInteger(turns) || turns < 1) return { error: ERROR_TEXT['bad-turns'] }
    options.turns = turns
  }
  return { sessionId, options }
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
      // 会话记录的 preset 可能已经被删除或改名：退回默认 preset，而不是让整次分切失败。
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
 * 把一个会话的压缩点之后的对话重建为新会话。
 * @param ctx - 已注入 agents/sessions/sessionQuery 的上下文。
 * @param parent - 源会话。
 * @param options - buildTailSeed 的选项。
 * @param signal - 可选的中止信号（斜杠命令带过来的）。
 * @returns {Promise<{ ok: boolean, text: string, childSessionId?: string, stats?: object }>}
 */
export async function runRebase(ctx, parent, options, signal) {
  const observation = await ctx.sessionQuery.observeSession(parent.id, { signal })
  try {
    const built = buildTailSeed(observation.events, options)
    if (built.error === 'not-enough-turns') {
      return {
        ok: false,
        text: '压缩点之后只有 ' + String(built.detail?.available ?? 0) + ' 个完整轮次，保留不了 '
          + String(built.detail?.requested ?? 0) + ' 个。',
      }
    }
    if (built.error !== undefined) return { ok: false, text: ERROR_TEXT[built.error] ?? built.error }

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
      ok: true,
      childSessionId,
      stats,
      text: '已建好尾部会话 ' + childSessionId
        + '：' + String(stats.sourceEvents) + ' 条事件 -> ' + String(stats.seedEvents) + ' 条'
        + '（压缩点之后 ' + String(stats.keptTurns) + ' 个完整轮次'
        + (stats.interruptedTurnEvents > 0 ? '＋未完成轮次 ' + String(stats.interruptedTurnEvents) + ' 条' : '')
        + (stats.summaryKept ? '，含压缩摘要' : '，不含压缩摘要')
        + '）'
        + (stats.droppedOrphans > 0 ? '，剔除孤儿工具结果 ' + String(stats.droppedOrphans) + ' 条' : '')
        + (stats.title === undefined ? '' : '，名称「' + stats.title + '」')
        + (attached ? '，已挂到当前工作区' : '')
        + '。在会话列表里打开它继续。',
    }
  } finally {
    observation[Symbol.dispose]?.()
  }
}

/** 回一个 JSON 响应。 */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('content-length', String(Buffer.byteLength(body)))
  res.end(body)
}

/** 读 JSON 请求体；超限时停止累积并报错。 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    let overflowed = false
    const chunks = []
    req.on('data', (chunk) => {
      if (overflowed) return
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        overflowed = true
        chunks.length = 0
        reject(new Error('请求体过大'))
        return
      }
      chunks.push(chunk)
    })
    req.on('error', reject)
    req.on('end', () => {
      if (overflowed) return
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (raw.length === 0) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(raw))
      } catch (error) {
        reject(new Error('请求体不是合法 JSON：' + String(error?.message ?? error)))
      }
    })
  })
}

/** 只接受同源写请求：别的站点不能借浏览器把你的会话切开。 */
function isTrustedWrite(req) {
  const headers = req.headers ?? {}
  if (String(headers['sec-fetch-site'] ?? '').toLowerCase() === 'cross-site') return false
  const origin = String(headers.origin ?? '')
  if (origin.length === 0) return true
  try {
    return new URL(origin).host === String(headers.host ?? '')
  } catch {
    return false
  }
}

/**
 * 注册 /rebase-tail 与浏览器半边的执行路由。
 * @param ctx - 宿主上下文。
 */
export function apply(ctx) {
  ctx.inject(['commands', 'agents', 'sessions', 'sessionQuery'], (scoped) => {
    scoped.effect(
      () => scoped.commands.register({
        name: 'rebase-tail',
        description: '把最近一次压缩之后的对话作为新会话（甩掉已压缩的历史包袱）',
        // 声明 input 才能让客户端把 /rebase-tail 后面的文字当成参数（leadingInput claim）；
        // 不声明时，带参数的一行会被当成普通提问发给模型。
        input: { hint: '--turns N ｜ --drop-summary ｜ --drop-open-turn ｜ --title "新名字"' },
        handler: async (invocation) => {
          const parsed = parseArguments(invocation.rawInput.trim())
          if (parsed.error !== undefined) return { kind: 'error', text: parsed.error }
          const result = await runRebase(scoped, invocation.agent.session, parsed.options, invocation.signal)
          return { kind: result.ok ? 'success' : 'error', text: result.text }
        },
      }),
      'rebase-tail command',
    )

    // 冷启动时 webServer 通常晚于本插件就绪，且 headless/TUI 装配里根本没有它：
    // 用 ctx.inject 等它就绪，拿不到就只是没有按钮那条路，命令照旧可用。
    scoped.inject(['webServer'], (served) => served.effect(
      () => served.webServer.register({
        kind: 'exact',
        path: RUN_ROUTE,
        handler: async (req, res) => {
          if (!isTrustedWrite(req)) {
            sendJson(res, 403, { ok: false, text: '跨站请求已拒绝。' })
            return
          }
          if (String(req.method ?? 'GET').toUpperCase() !== 'POST') {
            sendJson(res, 405, { ok: false, text: '只接受 POST。' })
            return
          }
          const parsed = parseRunBody(await readJsonBody(req).catch(error => ({ error: String(error?.message ?? error) })))
          if (parsed.error !== undefined) {
            sendJson(res, 400, { ok: false, text: parsed.error })
            return
          }
          const session = served.sessions.get(parsed.sessionId)
          if (session === undefined) {
            sendJson(res, 409, { ok: false, text: '这个会话当前没有在运行，先发一条消息让它活起来再分切。' })
            return
          }
          try {
            sendJson(res, 200, await runRebase(served, session, parsed.options))
          } catch (error) {
            served.logger?.warn?.('rebase-tail: 分切失败：' + String(error))
            sendJson(res, 500, { ok: false, text: '分切失败：' + String(error?.message ?? error) })
          }
        },
      }),
      'rebase-tail run route',
    ))
  })
}
