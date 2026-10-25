import { Router } from 'express'
import { asyncHandler, AppError } from '../lib/errors.js'
import { checkBudget } from '../store/budget.js'
import { generateImage, imageStatus } from '../images/index.js'
import { inc } from '../lib/metrics.js'

const router = Router()

/**
 * 图像生成。
 *
 * 同一个路由同时挂在 `/api` 与 `/v1` 下，所以：
 * - 网页用 `/api/images/generations`
 * - Cherry Studio / Cursor 这类客户端用 `/v1/images/generations`（OpenAI 兼容形状）
 *
 * 响应就是 OpenAI 的 `{ created, data: [{ url | b64_json }] }`，
 * 额外多几个字段（provider / model / tookMs）——客户端会忽略，但排查时有用。
 */
router.post(
  '/images/generations',
  asyncHandler(async (req, res) => {
    const { prompt, n, size, provider, model, response_format: responseFormat } = req.body || {}

    // 图像比对话贵得多，超预算必须提前拦住
    const budget = checkBudget()
    if (!budget.allowed) {
      throw new AppError(budget.message, { status: 429, code: budget.code })
    }

    // 客户端断开就中断上游，别让「用户已经关掉页面」的请求继续计费
    const abort = new AbortController()
    res.on('close', () => {
      if (!res.writableEnded) abort.abort()
    })

    const result = await generateImage({
      prompt,
      n,
      size,
      provider: typeof provider === 'string' ? provider : undefined,
      model: typeof model === 'string' ? model : undefined,
      signal: abort.signal,
    })

    inc('image_generated_total', { provider: result.provider })

    // 有些客户端显式要 url（默认），也有要 b64_json 的；
    // 上游给什么就给什么，只在明确要 b64 而拿到 url 时提示一下，不硬转
    const payload = {
      created: result.created,
      data: result.data,
      provider: result.provider,
      model: result.model,
      tookMs: result.tookMs,
    }
    if (responseFormat === 'b64_json' && result.data.every((d) => !d.b64_json)) {
      payload.notice = '上游只返回了图片链接，未提供 base64；请直接使用 url'
    }
    res.json(payload)
  })
)

/** 有没有可用的图像能力（前端据此决定要不要显示「生成图片」开关） */
router.get('/images/status', (_req, res) => {
  res.json(imageStatus())
})

export default router
