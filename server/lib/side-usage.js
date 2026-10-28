import { config } from '../config.js'
import { recordUsage } from '../store/usage.js'

/**
 * 记录一次「按次计费」的调用（图片 / 语音 / 搜索）。
 *
 * 这三类没有 token 数，只按次收费。价格来自环境变量（IMAGE_COST_USD 等），
 * 没配置就记 0：至少用量报表里能看到调用次数，配了价格之后预算上限才真正管得住。
 */
export function recordSideCall(
  kind,
  { provider = null, model = null, units = 1, latencyMs = null, status = 'ok' } = {}
) {
  const unit =
    kind === 'image'
      ? config.pricing.imagePerCall
      : kind === 'audio'
        ? config.pricing.audioPerCall
        : kind === 'search'
          ? config.pricing.searchPerCall
          : 0
  const count = Math.max(1, Math.round(Number(units) || 1))
  recordUsage({
    provider,
    model,
    costUsd: unit * count,
    latencyMs,
    status,
    kind,
  })
}
