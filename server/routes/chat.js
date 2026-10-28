import { Router } from 'express'
import { config, getFallbacks, getContextFlags } from '../config.js'
import { AppError, badRequest } from '../lib/errors.js'
import { createLogger } from '../lib/logger.js'
import { createSseStream } from '../lib/sse-response.js'
import { planContext, estimateMessagesTokens, estimateTokens } from '../lib/tokens.js'
import { inc, observe } from '../lib/metrics.js'
import { getModelInfo, estimateCost } from '../catalog/models.js'
import { resolveProvider, asciiProblem, configuredProviders } from '../providers/registry.js'
import { resolveTaskModel } from '../lib/task-model.js'
import { streamChat } from '../providers/stream.js'
import { runAgentLoop } from '../agent/loop.js'
import { resolveTools } from '../tools/index.js'
import { loadMcpTools, callMcpTool } from '../mcp/manager.js'
import { retrieve, toSources } from '../rag/index.js'
import { messageChain } from '../store/conversations.js'
import { storageStatus } from '../store/db.js'
import { checkBudget } from '../store/budget.js'
import { summarizeDropped, wrapSummary } from '../lib/compact.js'
import { describeUpstreamError } from '../lib/resilience.js'
import { webSearch, buildSearchContext, isSearchConfigured } from '../search/index.js'
import { recordUsage } from '../store/usage.js'
import { getPreset } from '../store/presets.js'
import { applyPreset } from '../lib/preset.js'
import { runTask } from '../lib/tasks.js'
import { currentUserId } from '../lib/auth.js'

const router = Router()

const ALLOWED_ROLES = new Set(['user', 'assistant', 'system'])

function clampNum(value, min, max, fallback) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback
}

/** 请求体校验：宁可返回一条清楚的 400，也不要让上游报看不懂的错 */
function validateChatBody(body) {
  const { provider, model, messages } = body || {}
  if (!provider || typeof provider !== 'string') throw badRequest('缺少 provider 参数', 'missing_provider')
  if (!model || typeof model !== 'string' || model.length > 200) {
    throw badRequest('model 参数无效', 'invalid_model')
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    throw badRequest('messages 不能为空', 'missing_messages')
  }
  if (messages.length > config.limits.messages) {
    throw badRequest(`messages 条数过多（上限 ${config.limits.messages}）`, 'too_many_messages')
  }
  for (const m of messages) {
    if (!m || typeof m !== 'object' || !ALLOWED_ROLES.has(m.role) || typeof m.content !== 'string') {
      throw badRequest('messages 中存在非法消息（角色或内容不合法）', 'invalid_message')
    }
    if (m.content.length > config.limits.messageChars) {
      throw badRequest(`单条消息内容过长（上限 ${config.limits.messageChars} 字符）`, 'message_too_long')
    }
  }
}

/** 取出最后一个用户提问，作为联网搜索的查询词 */
function lastUserQuery(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'user') return String(messages[i].content || '').trim()
  }
  return ''
}

/** 给前端的一行工具结果摘要（完整结果留在服务端，不往前端灌数据） */
function summarizeToolOutcome(outcome) {
  if (!outcome?.ok) return outcome?.error || '工具执行失败'
  const result = outcome.result
  if (Array.isArray(result?.results)) return `找到 ${result.results.length} 条结果`
  if (typeof result?.text === 'string') return `读取 ${result.text.length.toLocaleString()} 字`
  if (result?.local) return String(result.local)
  return '完成'
}

/**
 * 统一流式聊天代理。
 *
 * 前端收到的 SSE 事件（新增事件都是向后兼容的追加）：
 *   meta      → 本次请求的模型、上下文预算、是否裁剪过历史
 *   citations → 联网搜索来源
 *   notice    → 非致命提示（搜索失败、历史被裁剪等）
 *   reasoning → 思考过程增量
 *   delta     → 正文增量
 *   usage     → token 用量与估算花费
 *   error     → 致命错误
 *   done      → 结束
 */
router.post('/chat', async (req, res, next) => {
  const startedAt = Date.now()
  let body = req.body || {}

  // —— 预设：先把「模型 + 参数 + 系统提示 + 知识库 + MCP 组合」摊平成请求参数 ——
  // 放在校验之前，因为预设本身可以提供 provider/model（前端只需要发 presetId）。
  // 显式传的字段一律覆盖预设值——预设是默认值，不是枷锁。
  let preset = null
  if (body.presetId) {
    if (!storageStatus().available) {
      return next(new AppError('服务端持久化不可用，预设功能不可用', { status: 503, code: 'storage_unavailable' }))
    }
    preset = getPreset(body.presetId)
    if (!preset) {
      return next(new AppError(`预设 "${body.presetId}" 不存在`, { status: 404, code: 'preset_not_found' }))
    }
    body = applyPreset(body, preset)
  }

  // —— 所有会返回 JSON 错误的校验必须在写响应头之前完成 ——
  try {
    validateChatBody(body)
  } catch (err) {
    return next(err)
  }

  const { provider: providerId, model, messages, temperature, topP, maxTokens, system, webSearch: wantSearch, think, conversationId, parentId } = body
  const provider = resolveProvider(providerId)
  if (!provider) {
    return next(
      new AppError(`提供商 "${providerId}" 未配置或不可用，请在「设置 → 模型服务」或 server/.env 中配置`, {
        status: 400,
        code: 'provider_unavailable',
      })
    )
  }
  const ascii = asciiProblem(provider)
  if (ascii) return next(badRequest(ascii, 'non_ascii_config'))

  const log = createLogger({ requestId: req.id, route: 'chat', provider: provider.id, model })

  // —— 消息树：传了 parentId 就用「根 → 该消息」这一链作为上下文 ——
  // 分叉/编辑重生成时，前端只需要 parentId，服务端自己把祖先链取出来，
  // 而不是把整条扁平历史都发一遍——否则分叉后还是会带上旧分支的内容。
  let contextMessages = messages
  if (parentId && conversationId && storageStatus().available) {
    try {
      const chain = messageChain(conversationId, parentId, { userId: currentUserId(req) })
      const chainIds = new Set(chain.map((m) => m.id))
      const fresh = messages.filter((m) => !chainIds.has(m.id))
      if (chain.length > 0 && fresh.length > 0) {
        contextMessages = [...chain, ...fresh]
        log.info('按消息树分叉取上下文', { parentId, chain: chain.length, fresh: fresh.length })
      } else if (chain.length > 0) {
        contextMessages = chain
      }
    } catch (err) {
      log.warn('消息树取上下文失败，退回扁平历史', { message: err?.message })
    }
  }

  // —— 上下文预算：超窗口就裁历史，而不是让上游 400 ——
  const info = getModelInfo(providerId, model)
  const safeMaxTokens = clampNum(maxTokens, 1, info.maxOutput, Math.min(4096, info.maxOutput))
  const safeTemperature = clampNum(temperature, 0, 2, 0.7)
  const safeTopP = clampNum(topP, 0, 1, 1)

  const plan = config.context.budgetEnabled
    ? planContext({
        system: system || '',
        messages: contextMessages,
        contextWindow: info.contextWindow,
        maxOutput: safeMaxTokens,
        minKeepMessages: config.context.minKeepMessages,
        middleOutKeep: config.context.middleOutKeep,
      })
    : {
        messages,
        system: system || '',
        trimmed: false,
        dropped: 0,
        truncated: 0,
        estimatedInputTokens: estimateMessagesTokens(messages),
        budget: info.contextWindow - safeMaxTokens,
      }

  // —— 成本硬上限：超支前直接拒绝，而不是事后统计 ——
  const budgetCheck = checkBudget()
  if (!budgetCheck.allowed) {
    return next(
      new AppError(budgetCheck.message, { status: 429, code: budgetCheck.code })
    )
  }


  const fallbacks = getFallbacks()
    .map((f) => {
      const p = resolveProvider(f.provider)
      return p ? { provider: p, model: f.model } : null
    })
    .filter(Boolean)
    .filter((f) => !(f.provider.id === provider.id && f.model === model))

  // 实际生效的模型：发生降级后要跟着变，否则成本会算到错的模型头上
  let usedProviderId = provider.id
  let usedModel = model

  const stream = createSseStream(res)
  const abort = new AbortController()
  // Node 里 req 的 close 在请求体读完后就会触发，必须用 res 的 close 判断客户端断开
  res.on('close', () => {
    if (!res.writableEnded) abort.abort()
  })

  let fullText = ''
  let reasoningText = ''
  let usage = null
  let aborted = false

  const finish = (status, err) => {
    const latencyMs = Date.now() - startedAt
    // 上游没给 usage 时用估算值兜底，保证账本上永远有数
    const finalUsage =
      usage || {
        prompt: plan.estimatedInputTokens,
        completion: estimateTokens(fullText) + estimateTokens(reasoningText),
        total: plan.estimatedInputTokens + estimateTokens(fullText) + estimateTokens(reasoningText),
        estimated: true,
      }
    const cost = estimateCost(getModelInfo(usedProviderId, usedModel), finalUsage)

    // 顺序很重要：usage 必须在 done 之前，前端收到 done 才会把消息标记为完成
    stream.send({ type: 'usage', usage: finalUsage, costUsd: cost, estimated: !!finalUsage.estimated })
    if (status === 'ok') stream.send({ type: 'done' })
    recordUsage({
      conversationId,
      provider: usedProviderId,
      model: usedModel,
      prompt: finalUsage.prompt,
      completion: finalUsage.completion,
      total: finalUsage.total,
      costUsd: cost,
      latencyMs,
      status,
    })
    inc('chat_requests_total', { provider: provider.id, status })
    observe('chat_latency_ms', latencyMs, { provider: provider.id })
    if (err) log.warn('对话结束（异常）', { status, latencyMs, message: err?.message })
    else log.info('对话结束', { status, latencyMs, tokens: finalUsage.total, costUsd: cost, aborted })
    stream.close()
  }

  stream.send({
    type: 'meta',
    requestId: req.id,
    provider: provider.id,
    model,
    modelKnown: info.known,
    contextWindow: info.contextWindow,
    maxOutput: safeMaxTokens,
    // 前端约定的扁平字段（与 context 里的同义，保留两种写法便于渐进接入）
    contextTokens: plan.estimatedInputTokens,
    compressed: plan.trimmed,
    latencyMs: Date.now() - startedAt,
    // 这次请求实际生效的预设（前端据此显示「当前用的是 XX 预设」）
    preset: preset ? { id: preset.id, name: preset.name, icon: preset.icon } : undefined,
    context: {
      estimatedInputTokens: plan.estimatedInputTokens,
      budget: plan.budget,
      trimmed: plan.trimmed,
      dropped: plan.dropped,
      truncated: plan.truncated,
    },
  })

  if (budgetCheck.warn) {
    stream.send({ type: 'notice', message: budgetCheck.warn })
  }

  if (plan.trimmed) {
    stream.send({
      type: 'notice',
      message: `对话历史较长，已自动省略最早的 ${plan.dropped} 条消息以适配 ${info.contextWindow.toLocaleString()} token 上下文`,
    })
  }

  try {
    let finalSystem = plan.system

    if (think) {
      finalSystem = [
        finalSystem,
        '请先进行深入、结构化的思考，明确指出推理过程，然后再给出最终结论。',
      ]
        .filter(Boolean)
        .join('\n\n')
    }

    // —— 知识库检索：命中则注入上下文并回传来源 ——
    // 契约：只要请求带了 workspaceId（或 knowledge:true），就视为「用户要用知识库」，
    // 空库时回一条提示而不是静默编造。前端据此只在确有可用文档时才带 workspaceId。
    if (body.workspaceId || body.knowledge === true) {
      const workspaceId = String(body.workspaceId || 'default')
      try {
        const query = lastUserQuery(plan.messages)
        const result = await retrieve({
          workspaceId,
          query,
          topK: Math.min(12, Math.max(1, Number(body.topK) || 6)),
          // 限定范围提问：「只在这几份文档里找答案」
          documentIds: Array.isArray(body.documentIds) ? body.documentIds.slice(0, 50) : null,
          signal: abort.signal,
        })
        if (result.chunks.length) {
          finalSystem = [finalSystem, result.context].filter(Boolean).join('\n\n')
          stream.send({ type: 'sources', sources: toSources(result.chunks) })
          inc('rag_retrievals_total', { hit: 'true' })
        } else {
          inc('rag_retrievals_total', { hit: 'false' })
          stream.send({ type: 'notice', message: '知识库中没有检索到相关内容，将基于模型自身知识回答' })
        }
      } catch (err) {
        if (!abort.signal.aborted) {
          stream.send({ type: 'notice', message: `知识库检索失败：${err?.message || err}` })
        }
      }
    }

    // —— 摘要式压缩：裁剪掉的历史先用小模型总结，别让助手失忆 ——
    if (plan.trimmed && plan.dropped > 0 && getContextFlags().compaction && storageStatus().available) {
      const dropped = contextMessages.slice(0, contextMessages.length - plan.messages.length)
      if (dropped.length > 0) {
        const result = await summarizeDropped({ dropped, provider, signal: abort.signal })
        if (result?.summary) {
          finalSystem = [finalSystem, wrapSummary(result.summary)].filter(Boolean).join('\n\n')
          stream.send({
            type: 'meta',
            requestId: req.id,
            compaction: { applied: true, cached: result.cached, summarizedMessages: dropped.length, model: result.model },
          })
          stream.send({
            type: 'notice',
            message: result.cached
              ? `已沿用此前生成的摘要（覆盖较早的 ${dropped.length} 条消息）`
              : `已把较早的 ${dropped.length} 条消息总结为摘要，以适配模型上下文`,
          })
        } else if (result?.failed) {
          const safeErr = String(result.error || '').replace(/sk-[a-zA-Z0-9_\-]{6,}/g, 'sk-***').slice(0, 120)
          stream.send({ type: 'notice', message: `历史摘要生成失败，已改为直接裁剪${safeErr ? `：${safeErr}` : ''}` })
        }
      }
    }

    // —— 工具调用：模型自己决定何时搜/读网页，服务端执行 ——
    const wantsTools = body.agent === true || body.tools === true || Array.isArray(body.tools)
    let toolDefs = []
    if (wantsTools) {
      if (!info.capabilities.tools) {
        stream.send({ type: 'notice', message: `${model} 不支持工具调用，本次按普通对话处理` })
      } else {
        const explicitTools = Array.isArray(body.tools) ? body.tools : null
        toolDefs = resolveTools(explicitTools)
        /**
         * 图像生成单独一个开关（`imageGeneration`），不进默认工具集：
         * 一次出图比一次对话贵得多，不能因为「开了工具」就默默开始花钱。
         * 显式列在 `tools` 里同样生效，方便预设绑定。
         */
        const wantsImage =
          body.imageGeneration === true ||
          (explicitTools ? explicitTools.includes('generate_image') : false)
        if (wantsImage && !toolDefs.some((t) => t.name === 'generate_image')) {
          toolDefs = [...toolDefs, ...resolveTools(['generate_image'])]
        }
        if (toolDefs.length === 0) {
          stream.send({ type: 'notice', message: '没有可用的工具，本次按普通对话处理' })
        }
      }
    }

    const onFallback = ({ from, to, error }) => {
      usedProviderId = to.provider.id
      usedModel = to.model
      inc('chat_fallbacks_total', { from: from.provider.id, to: to.provider.id })
      log.warn('主模型不可用，已降级', { from: `${from.provider.id}/${from.model}`, to: `${to.provider.id}/${to.model}`, message: error?.message })
      stream.send({
        type: 'notice',
        message: `${from.provider.name} 暂时不可用，已自动切换到 ${to.provider.name} / ${to.model}`,
      })
      stream.send({
        type: 'model_switch',
        from: { provider: from.provider.id, model: from.model },
        to: { provider: to.provider.id, model: to.model },
        reason: error?.message,
      })
    }

    if (toolDefs.length > 0) {
      // 合并 MCP 工具：server 里配了并启用的会一起进 agent 的工具箱。
      // 预设可以用 `mcpMode: 'selected'` 锁定一组 server（对应 LibreChat #7387 的诉求）。
      let mcpIndex = new Map()
      try {
        const only = Array.isArray(body.mcpServers) ? body.mcpServers : undefined
        const mcp = await loadMcpTools({ only })
        mcpIndex = mcp.index
        toolDefs = [...toolDefs, ...mcp.definitions]
        if (mcp.definitions.length > 0) {
          log.info('已挂载 MCP 工具', { count: mcp.definitions.length, limited: !!only })
        }
      } catch (err) {
        log.warn('MCP 工具装载失败，本次忽略', { message: err?.message })
      }

      // 多个工具可能各搜一次，按 URL 去重后统一回传给前端
      const citationMap = new Map()
      const pushCitations = (list) => {
        for (const c of list || []) {
          if (!citationMap.has(c.url)) citationMap.set(c.url, { ...c, index: citationMap.size + 1 })
        }
        stream.send({ type: 'citations', citations: [...citationMap.values()] })
      }

      await runAgentLoop({
        provider,
        model,
        messages: plan.messages,
        system: finalSystem,
        toolDefs,
        signal: abort.signal,
        fallbacks,
        onFallback,
        onDelta: (text) => {
          fullText += text
          stream.send({ type: 'delta', content: text })
        },
        onReasoning: (text) => {
          reasoningText += text
          stream.send({ type: 'reasoning', content: text })
        },
        onUsage: (u) => {
          // 多轮工具调用会上报多次，累加才是这次请求的真实成本
          usage = {
            prompt: (usage?.prompt || 0) + (u.prompt || 0),
            completion: (usage?.completion || 0) + (u.completion || 0),
            total: (usage?.total || 0) + (u.total || 0),
          }
        },
        onToolCall: (call) => {
          inc('tool_calls_total', { tool: call.name })
          stream.send({ type: 'tool_call', id: call.id, name: call.name, arguments: call.arguments })
        },
        onToolResult: (call, outcome) => {
          stream.send({
            type: 'tool_result',
            id: call.id,
            name: call.name,
            ok: !!outcome.ok,
            preview: summarizeToolOutcome(outcome),
          })
        },
        onCitations: pushCitations,
        onNotice: (message) => stream.send({ type: 'notice', message }),
        // 工具生成的图片直接推给前端，不进模型上下文
        onImages: (images, meta) => {
          inc('image_generated_total', { source: 'tool' })
          stream.send({ type: 'image', images, prompt: meta?.prompt, model: meta?.model })
        },
        mcpIndex,
        onExecuteMcp: async ({ serverId, toolName, call, arguments: toolArgs }) => {
          const outcome = await callMcpTool(serverId, toolName, toolArgs, { signal: abort.signal })
          // MCP 的返回可能很长，压成一行摘要给前端（完整结果已进模型上下文）
          if (outcome?.ok && outcome.text && call) {
            stream.send({
              type: 'tool_result',
              id: call.id,
              name: toolName,
              ok: true,
              preview: outcome.text.slice(0, 120),
            })
          }
          return outcome
        },
      })

      finish('ok')
      return
    }

    if (wantSearch) {
      if (!isSearchConfigured()) {
        stream.send({ type: 'notice', message: '未配置联网搜索服务，本次回答未联网' })
      } else {
        const query = lastUserQuery(plan.messages)
        if (query) {
          try {
            const result = await webSearch(query, { signal: abort.signal })
            stream.send({ type: 'citations', citations: result.citations })
            const ctx = buildSearchContext(result.citations)
            if (ctx) finalSystem = [finalSystem, ctx].filter(Boolean).join('\n\n')
          } catch (err) {
            // 非致命：搜索失败不该让整轮对话失败
            if (!abort.signal.aborted) {
              stream.send({ type: 'notice', message: `联网搜索失败：${err?.message || err}` })
              log.warn('联网搜索失败', { message: err?.message })
            }
          }
        }
      }
    }

    await streamChat(provider, {
      model,
      messages: plan.messages,
      system: finalSystem,
      temperature: safeTemperature,
      topP: safeTopP,
      maxTokens: safeMaxTokens,
      abortSignal: abort.signal,
      fallbacks,
      onFallback,
      onDelta: (text) => {
        fullText += text
        stream.send({ type: 'delta', content: text })
      },
      onReasoning: (text) => {
        reasoningText += text
        stream.send({ type: 'reasoning', content: text })
      },
      onUsage: (u) => {
        usage = { prompt: u.prompt || 0, completion: u.completion || 0, total: u.total || 0 }
      },
    })

    finish('ok')
  } catch (err) {
    if (abort.signal.aborted) {
      aborted = true
      finish('aborted')
      return
    }
    log.error('对话失败', { message: err?.message, code: err?.code, status: err?.status })
    inc('chat_errors_total', { provider: provider.id, code: err?.code || 'unknown' })
    // 给用户看翻译过的中文提示；原始 message 已经在日志里
    stream.send({
      type: 'error',
      message: describeUpstreamError(err, { providerName: provider.name || provider.id }),
      code: err?.code || 'upstream_error',
    })
    finish('error', err)
  }
})

/**
 * 一次性补全（非流式）。
 * 给「生成标题 / 摘要 / 翻译选中段落」这类短任务用：
 * 前端不用自己拼 SSE 再收集，服务端一次返回文本和用量。
 */
router.post('/complete', async (req, res, next) => {
  const { provider: providerId, model, system, messages, maxTokens, temperature } = req.body || {}
  try {
    validateChatBody({ provider: providerId, model, messages })
  } catch (err) {
    return next(err)
  }
  // 预算硬检查与 /api/chat 对齐：这里不拦的话，预算启用时仍能从这个口子把钱花超
  const budgetCheck = checkBudget()
  if (!budgetCheck.allowed) {
    return next(new AppError(budgetCheck.message, { status: 429, code: budgetCheck.code }))
  }
  const provider = resolveProvider(providerId)
  if (!provider) return next(new AppError(`提供商 "${providerId}" 未配置或不可用`, { status: 400, code: 'provider_unavailable' }))

  const info = getModelInfo(providerId, model)
  let text = ''
  let usage = null
  try {
    await streamChat(provider, {
      model,
      messages,
      system: system || '',
      temperature: clampNum(temperature, 0, 2, 0.3),
      topP: 1,
      maxTokens: clampNum(maxTokens, 1, info.maxOutput, 512),
      onDelta: (t) => {
        text += t
      },
      onUsage: (u) => {
        usage = { prompt: u.prompt || 0, completion: u.completion || 0, total: u.total || 0 }
      },
    })
  } catch (err) {
    return next(err)
  }
  const finalUsage =
    usage || { prompt: estimateMessagesTokens(messages), completion: estimateTokens(text), total: 0, estimated: true }
  if (!finalUsage.total) finalUsage.total = finalUsage.prompt + finalUsage.completion
  const costUsd = estimateCost(info, finalUsage)
  recordUsage({ provider: provider.id, model, ...finalUsage, costUsd, status: 'ok' })
  res.json({ text, usage: finalUsage, costUsd })
})

/**
 * 自动生成会话标题。
 * 独立成一个接口的原因：标题要短、要便宜，用主对话模型全量上下文去生成纯属浪费。
 *
 * 兼容两种入参：
 *   { provider, model, text }                  —— 最简单
 *   { provider?, model?, messages: [{role,content}] } —— 前端首轮对话后直接丢消息数组
 * provider/model 省略时自动选第一个已配置服务商及其首个模型。
 */
router.post('/title', async (req, res, next) => {
  const { provider, model, ...input } = req.body || {}
  // /api/tasks/:kind 有预算检查，/api/title 是它的兼容别名，检查必须对齐
  const budgetCheck = checkBudget()
  if (!budgetCheck.allowed) {
    return next(new AppError(budgetCheck.message, { status: 429, code: budgetCheck.code }))
  }
  try {
    // 统一走 lib/tasks.js：标题只是「小任务」的一种，
    // 单独再写一份实现迟早会和 /api/tasks/title 漂移。
    const outcome = await runTask('title', input, { provider, model })
    res.json({
      title: outcome.result.title,
      model: outcome.model,
      dedicatedModel: outcome.dedicated,
    })
  } catch (err) {
    next(err)
  }
})

export default router
