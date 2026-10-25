import { Router } from 'express'
import { badRequest, notFound, AppError, asyncHandler } from '../lib/errors.js'
import { resolveProvider } from '../providers/registry.js'
import { parseDataUrl } from '../providers/format.js'
import { inc, observe } from '../lib/metrics.js'
import { config } from '../config.js'

const router = Router()

/**
 * 语音能力代理（STT / TTS）。
 *
 * 走 OpenAI 兼容协议：/audio/transcriptions 与 /audio/speech。
 * 前端用 JSON 传 base64，服务端转成 multipart 转发——
 * 这样前端不用引 multipart 库，也能复用同一套鉴权与错误处理。
 */

const MAX_AUDIO_BYTES = 25 * 1024 * 1024

function requireCompatibleProvider(providerId) {
  const provider = resolveProvider(providerId)
  if (!provider) throw notFound('服务商不存在或未配置')
  if (provider.type !== 'openai-compat') {
    throw badRequest(`${provider.name} 不支持 OpenAI 兼容的语音接口`, 'audio_unsupported')
  }
  return provider
}

/** 语音转文字 */
router.post(
  '/audio/transcriptions',
  asyncHandler(async (req, res) => {
    const { provider: providerId, model = 'whisper-1', audio, name, language, prompt } = req.body || {}
    if (!audio) throw badRequest('缺少 audio（data URL 或 base64）', 'missing_audio')
    if (!providerId) throw badRequest('缺少 provider', 'missing_provider')

    const provider = requireCompatibleProvider(providerId)

    const parsed = audio.startsWith('data:')
      ? parseDataUrl(audio)
      : { mime: 'audio/webm', data: audio, isBase64: true }
    if (!parsed) throw badRequest('audio 格式无法解析', 'invalid_audio')

    const buffer = Buffer.from(parsed.data, parsed.isBase64 ? 'base64' : 'utf8')
    if (buffer.length === 0) throw badRequest('音频内容为空', 'empty_audio')
    if (buffer.length > MAX_AUDIO_BYTES) {
      throw new AppError(`音频过大（上限 ${MAX_AUDIO_BYTES / 1024 / 1024}MB）`, {
        status: 413,
        code: 'payload_too_large',
      })
    }

    const form = new FormData()
    form.append('file', new Blob([buffer], { type: parsed.mime || 'audio/webm' }), name || 'audio.webm')
    form.append('model', String(model))
    if (language) form.append('language', String(language))
    if (prompt) form.append('prompt', String(prompt).slice(0, 1000))

    const startedAt = Date.now()
    const upstream = await fetch(`${provider.baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${provider.apiKey}` },
      body: form,
      signal: AbortSignal.timeout(120_000),
    })
    observe('audio_transcribe_ms', Date.now() - startedAt)

    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => '')
      throw new AppError(`转写失败 (${upstream.status})${detail ? `：${detail.slice(0, 200)}` : ''}`, {
        status: 502,
        code: 'upstream_error',
      })
    }
    const json = await upstream.json().catch(() => ({}))
    inc('audio_transcribe_total')
    res.json({ text: json.text || '', language: json.language || null, duration: json.duration ?? null })
  })
)

/** 文字转语音：直接把上游音频流回传给前端 */
router.post(
  '/audio/speech',
  asyncHandler(async (req, res) => {
    const {
      provider: providerId,
      model = 'tts-1',
      input,
      voice = 'alloy',
      format: responseFormat = 'mp3',
      speed,
    } = req.body || {}
    if (!input || !String(input).trim()) throw badRequest('缺少 input 文本', 'missing_input')
    if (!providerId) throw badRequest('缺少 provider', 'missing_provider')
    if (String(input).length > 4096) throw badRequest('文本过长（上限 4096 字符）', 'input_too_long')

    const provider = requireCompatibleProvider(providerId)
    const upstream = await fetch(`${provider.baseUrl}/audio/speech`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${provider.apiKey}`,
      },
      body: JSON.stringify({
        model: String(model),
        input: String(input),
        voice: String(voice),
        response_format: String(responseFormat),
        ...(Number.isFinite(Number(speed)) ? { speed: Number(speed) } : {}),
      }),
      signal: AbortSignal.timeout(config.chat.timeoutMs),
    })

    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => '')
      throw new AppError(`语音合成失败 (${upstream.status})${detail ? `：${detail.slice(0, 200)}` : ''}`, {
        status: 502,
        code: 'upstream_error',
      })
    }

    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'audio/mpeg')
    res.setHeader('Cache-Control', 'no-store')
    const buffer = Buffer.from(await upstream.arrayBuffer())
    inc('audio_speech_total')
    res.send(buffer)
  })
)

export default router
