import { Router } from 'express'
import { asyncHandler, badRequest, AppError } from '../lib/errors.js'
import { checkBudget } from '../store/budget.js'
import { describeTones, runTask, TASK_KINDS } from '../lib/tasks.js'
import { inc } from '../lib/metrics.js'

const router = Router()

/**
 * 小任务统一入口。
 *
 *   POST /api/tasks/:kind
 *   kind: title | summary | suggest | rewrite
 *
 * 这些请求都很短（几十到几百 token），但如果前端在每轮对话后都调一次，
 * 累积成本并不小——所以统一走预算检查与用量记账，和主对话一致。
 */
router.post(
  '/tasks/:kind',
  asyncHandler(async (req, res) => {
    const kind = String(req.params.kind || '')
    if (!TASK_KINDS.includes(kind)) {
      throw badRequest(`不支持的任务类型：${kind}（可选：${TASK_KINDS.join(' / ')}）`, 'unknown_task')
    }

    const budget = checkBudget()
    if (!budget.allowed) {
      throw new AppError(budget.message, { status: 429, code: budget.code })
    }

    const body = req.body || {}
    const { provider, model } = body

    // 前端断开就中断上游，别让「用户已经关掉面板」的请求继续烧 token
    const abort = new AbortController()
    res.on('close', () => {
      if (!res.writableEnded) abort.abort()
    })

    const outcome = await runTask(kind, body, {
      provider: typeof provider === 'string' ? provider : undefined,
      model: typeof model === 'string' ? model : undefined,
      signal: abort.signal,
    })

    inc('task_calls_total', { kind })
    res.json({
      ok: true,
      kind,
      ...outcome.result,
      model: outcome.model,
      provider: outcome.provider,
      // true 表示这次用的是「子任务专用模型」而不是调用方指定的模型
      dedicatedModel: outcome.dedicated,
      usage: outcome.usage,
      costUsd: outcome.costUsd,
    })
  })
)

/** 有哪些任务类型、改写支持哪些风格（前端渲染下拉用） */
router.get('/tasks', (_req, res) => {
  res.json({
    kinds: TASK_KINDS,
    tones: describeTones(),
  })
})

export default router
