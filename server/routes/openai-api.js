import { Router } from 'express'
import crypto from 'node:crypto'
import { badRequest, AppError, asyncHandler } from '../lib/errors.js'
import { configuredProviders, resolveProvider } from '../providers/registry.js'
import { streamChat } from '../providers/stream.js'
import { getModelInfo, estimateCost } from '../catalog/models.js'
import { recordUsage } from '../store/usage.js'
import { inc } from '../lib/metrics.js'
import { estimateMessagesTokens, estimateTokens } from '../lib/tokens.js'
import { checkBudget } from '../store/budget.js'
import { getPreset, listPresets } from '../store/presets.js'
import { parseModelRef } from '../lib/preset.js'

/**
 * OpenAI 兼容 API。
 *
 * 意义：任何支持「自定义 OpenAI 接口」的客户端（Cherry Studio、LobeChat、Cursor、
 * 手机 App、各种 SDK）都能直接把 FlyChat 当网关用——Key 留在服务端，
 * 客户端只拿到一个 base_url + token。这是自托管产品最容易被忽略、
 * 但商业价值最高的一块：它让产品从「一个网页」变成「一个可被集成的服务」。
 *
 * 只做转发与协议转换，不执行工具：调用方声明 tools，模型返回 tool_calls，
 * 由调用方自己执行——这才是标准 OpenAI 语义。
 */

const router = Router()

/**
 * 把请求里的 model 解析成「哪个服务商 + 哪个模型」。
 * 支持三种写法：
 *   - `provider:model`（精确指定）
 *   - `provider/model`（OpenRouter 风格）
 *   - 裸模型名（在已配置服务商里找第一个有这个模型的）
 */
function resolveTarget(model) {
  const raw = String(model || '').trim()
  if (!raw) throw badRequest('缺少 model', 'missing_model')

  const providers = configuredProviders()
  if (providers.length === 0) {
    throw new AppError('服务端还没有配置任何模型服务商', { status: 503, code: 'provider_unavailable' })
  }

  const colon = raw.indexOf(':')
  if (colon > 0) {
    const pid = raw.slice(0, colon)
    const mid = raw.slice(colon + 1)
    const provider = resolveProvider(pid)
    if (provider && mid) return { provider, model: mid }
  }

  const slash = raw.indexOf('/')
  if (slash > 0) {
    const pid = raw.slice(0, slash)
    const provider = resolveProvider(pid)
    if (provider) return { provider, model: raw.slice(slash + 1) }
  }

  for (const p of providers) {
    if (p.models?.includes(raw)) {
      const provider = resolveProvider(p.id)
      if (provider) return { provider, model: raw }
    }
  }

  // 只有一个服务商时，允许直接透传模型名（最常见：只配了 DeepSeek）
  if (providers.length === 1) {
    const provider = resolveProvider(providers[0].id)
    if (provider) return { provider, model: raw }
  }

  throw new AppError(`找不到模型 "${raw}"，请用 "服务商:模型" 的形式指定`, {
    status: 404,
    code: 'model_not_found',
  })
}

/** 内部消息 → 上游消息（只保留 OpenAI 认识的字段） */
function normalizeMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw badRequest('messages 不能为空', 'missing_messages')
  }
  return messages.map((m) => {
    if (!m || typeof m !== 'object') throw badRequest('messages 中存在非法项', 'invalid_message')
    const role = m.role === 'developer' ? 'system' : m.role
    if (!['system', 'user', 'assistant', 'tool'].includes(role)) {
      throw badRequest(`不支持的消息角色：${m.role}`, 'invalid_role')
    }
    const content = typeof m.content === 'string' ? m.content : m.content == null ? '' : JSON.stringify(m.content)
    const out = { role, content }
    if (m.name) out.name = String(m.name)
    if (m.tool_call_id) out.tool_call_id = String(m.tool_call_id)
    if (Array.isArray(m.tool_calls)) out.tool_calls = m.tool_calls
    return out
  })
}

function chunkId() {
  return `chatcmpl-${crypto.randomBytes(12).toString('hex')}`
}

/** 收集一次完整调用（非流式请求用它把流攒成完整结果） */
async function complete({ provider, model, messages, temperature, topP, maxTokens, tools, toolChoice, signal }) {
  let text = ''
  let reasoning = ''
  let usage = null
  const toolCalls = []

  const result = await streamChat(provider, {
    model,
    messages,
    temperature,
    topP,
    maxTokens,
    tools,
    toolChoice,
    abortSignal: signal,
    onDelta: (t) => {
      text += t
    },
    onReasoning: (t) => {
      reasoning += t
    },
    onUsage: (u) => {
      usage = u
    },
    onToolCallStart: (_i, call) => toolCalls.push(call),
  })

  return {
    text,
    reasoning,
    usage,
    toolCalls: result?.toolCalls || toolCalls,
    finishReason: result?.finishReason || 'stop',
    provider: result?.provider || provider,
    model: result?.model || model,
  }
}

/**
 * GET /v1/models：客户端靠它发现可用模型。
 *
 * 预设也作为「模型」暴露（`preset:<id>`）——这样第三方客户端里
 * 能直接选「我的代码助手」而不是某个裸模型名，预设里的系统提示与参数会一起生效。
 */
router.get('/models', (_req, res) => {
  const created = Math.floor(Date.now() / 1000)
  const data = []
  for (const p of configuredProviders()) {
    for (const m of p.models || []) {
      data.push({ id: `${p.id}:${m}`, object: 'model', created, owned_by: p.id })
      // 同时暴露裸模型名，方便只配了一个服务商的客户端直接用
      if (!data.some((x) => x.id === m)) data.push({ id: m, object: 'model', created, owned_by: p.id })
    }
  }
  try {
    for (const preset of listPresets()) {
      data.push({
        id: `preset:${preset.id}`,
        object: 'model',
        created,
        owned_by: 'preset',
        description: preset.description || preset.name,
      })
    }
  } catch {
    // 存储不可用时退化成「只有模型」，不让 /v1/models 整个挂掉
  }
  res.json({ object: 'list', data })
})

router.post(
  '/chat/completions',
  asyncHandler(async (req, res) => {
    const body = req.body || {}
    let { temperature, top_p: topP, max_tokens: maxTokens } = body
    const { stream = false, tools, tool_choice: toolChoice } = body
    let messages = normalizeMessages(body.messages)

    // —— 预设：`model: "preset:<id>"` 时，模型/参数/系统提示都按预设来 ——
    // 客户端显式传的 temperature 等仍然优先（预设是默认值）。
    const ref = parseModelRef(body.model)
    let preset = null
    if (ref.presetId) {
      preset = getPreset(ref.presetId)
      if (!preset) {
        throw new AppError(`预设 "${ref.presetId}" 不存在`, { status: 404, code: 'preset_not_found' })
      }
      if (!preset.provider || !preset.model) {
        throw new AppError(`预设「${preset.name}」没有绑定模型，无法在 /v1 使用`, {
          status: 400,
          code: 'preset_incomplete',
        })
      }
      const p = preset.params || {}
      if (temperature === undefined && p.temperature !== undefined) temperature = p.temperature
      if (topP === undefined && p.topP !== undefined) topP = p.topP
      if (maxTokens === undefined && p.maxTokens !== undefined) maxTokens = p.maxTokens
      if (preset.systemPrompt && !messages.some((m) => m.role === 'system')) {
        messages = [{ role: 'system', content: preset.systemPrompt }, ...messages]
      }
    }

    const { provider, model } = preset
      ? resolveTarget(`${preset.provider}:${preset.model}`)
      : resolveTarget(body.model)

    const budgetCheck = checkBudget()
    if (!budgetCheck.allowed) {
      throw new AppError(budgetCheck.message, { status: 429, code: budgetCheck.code })
    }

    const info = getModelInfo(provider.id, model)
    const id = chunkId()
    const created = Math.floor(Date.now() / 1000)
    const startedAt = Date.now()

    // 客户端断开就中断上游，别让请求继续烧 token
    const abort = new AbortController()
    res.on('close', () => {
      if (!res.writableEnded) abort.abort()
    })

    const usageOf = (u) =>
      u
        ? { prompt_tokens: u.prompt, completion_tokens: u.completion, total_tokens: u.total }
        : { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }

    if (!stream) {
      const result = await complete({
        provider,
        model,
        messages,
        temperature,
        topP,
        maxTokens,
        tools,
        toolChoice,
        signal: abort.signal,
      })

      const usage = result.usage || {
        prompt: estimateMessagesTokens(messages),
        completion: estimateTokens(result.text),
        total: estimateMessagesTokens(messages) + estimateTokens(result.text),
        estimated: true,
      }
      const cost = estimateCost(info, usage)
      recordUsage({
        provider: result.provider.id,
        model: result.model,
        prompt: usage.prompt,
        completion: usage.completion,
        total: usage.total,
        costUsd: cost,
        latencyMs: Date.now() - startedAt,
        status: 'ok',
      })
      inc('openai_api_requests_total', { stream: 'false' })

      const message = { role: 'assistant', content: result.text || null }
      if (result.toolCalls.length) {
        message.tool_calls = result.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: {
            name: tc.name,
            arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments || {}),
          },
        }))
        message.content = result.text || null
      }

      return res.json({
        id,
        object: 'chat.completion',
        created,
        model: result.model,
        choices: [
          {
            index: 0,
            message,
            finish_reason: result.toolCalls.length ? 'tool_calls' : 'stop',
          },
        ],
        usage: usageOf(usage),
      })
    }

    // —— 流式：转成 OpenAI 的 chunk 格式 ——
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })

    let closed = false
    const send = (obj) => {
      if (closed) return
      try {
        res.write(`data: ${JSON.stringify(obj)}\n\n`)
      } catch {
        closed = true
      }
    }
    const base = (delta, finish = null) => ({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    })

    // 首块按规范带 role
    send(base({ role: 'assistant', content: '' }))

    const toolBuffer = []
    let usage = null

    try {
      const result = await streamChat(provider, {
        model,
        messages,
        temperature,
        topP,
        maxTokens,
        tools,
        toolChoice,
        abortSignal: abort.signal,
        onDelta: (text) => send(base({ content: text })),
        onUsage: (u) => {
          usage = u
        },
        onToolCallStart: (index, call) => {
          toolBuffer[index] = call
        },
      })

      for (const [index, call] of (result?.toolCalls || toolBuffer).entries()) {
        send(
          base({
            tool_calls: [
              {
                index,
                id: call.id,
                type: 'function',
                function: {
                  name: call.name,
                  arguments: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments || {}),
                },
              },
            ],
          })
        )
      }

      const finish = result?.finishReason === 'tool_calls' ? 'tool_calls' : 'stop'
      send(base({}, finish))
      if (usage) {
        send({
          id,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [],
          usage: usageOf(usage),
        })
      }
      res.write('data: [DONE]\n\n')
      inc('openai_api_requests_total', { stream: 'true' })
    } catch (err) {
      if (!abort.signal.aborted) {
        send({ error: { message: err?.message || '上游请求失败', type: 'upstream_error', code: err?.code || 'upstream_error' } })
      }
      inc('openai_api_errors_total', { code: err?.code || 'unknown' })
    } finally {
      closed = true
      try {
        res.end()
      } catch {
        /* 客户端已断开 */
      }
    }
  })
)

export default router
