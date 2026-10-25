import { useEffect, useMemo, useState } from 'react'
import { Activity, Clock, Coins, Cpu, Server, Zap } from 'lucide-react'
import Modal from './ui/Modal'
import { useChatStore } from '../store/chat'
import { fetchServerUsage } from '../api/client'
import type { ServerUsageSummary } from '../types'

interface UsageModalProps {
  open: boolean
  onClose: () => void
}

export default function UsageModal({ open, onClose }: UsageModalProps) {
  const conversations = useChatStore((s) => s.conversations)
  const [serverStats, setServerStats] = useState<ServerUsageSummary | null>(null)
  const [viewSource, setViewSource] = useState<'local' | 'server'>('local')

  useEffect(() => {
    if (open) {
      fetchServerUsage().then((res) => {
        if (res && res.available && res.totals) {
          setServerStats(res)
        }
      })
    }
  }, [open])

  // 本地 IndexedDB 统计
  const localStats = useMemo(() => {
    let promptTokens = 0
    let completionTokens = 0
    let totalMessages = 0
    const modelUsageMap: Record<string, { count: number; tokens: number }> = {}

    conversations.forEach((conv) => {
      conv.messages.forEach((msg) => {
        totalMessages++
        if (msg.usage) {
          promptTokens += msg.usage.prompt || 0
          completionTokens += msg.usage.completion || 0
          const modelKey = msg.model || '通用模型'
          if (!modelUsageMap[modelKey]) {
            modelUsageMap[modelKey] = { count: 0, tokens: 0 }
          }
          modelUsageMap[modelKey].count++
          modelUsageMap[modelKey].tokens += msg.usage.total || 0
        }
      })
    })

    const totalTokens = promptTokens + completionTokens
    const estimatedCostUsd =
      (promptTokens / 1_000_000) * 3.0 + (completionTokens / 1_000_000) * 12.0

    return {
      totalTokens,
      promptTokens,
      completionTokens,
      totalMessages,
      estimatedCostUsd,
      modelUsage: Object.entries(modelUsageMap).sort((a, b) => b[1].tokens - a[1].tokens),
    }
  }, [conversations])

  const isServer = viewSource === 'server' && serverStats?.totals
  const totalTokens = isServer ? serverStats.totals!.totalTokens : localStats.totalTokens
  const promptTokens = isServer ? serverStats.totals!.promptTokens : localStats.promptTokens
  const completionTokens = isServer ? serverStats.totals!.completionTokens : localStats.completionTokens
  const estimatedCost = isServer ? serverStats.totals!.costUsd : localStats.estimatedCostUsd
  const requestCount = isServer ? serverStats.totals!.requests : localStats.totalMessages

  return (
    <Modal open={open} onClose={onClose} title="用量与消费分析">
      <div className="flex flex-col gap-6">
        {/* 数据源切换 */}
        {serverStats?.available && (
          <div className="flex items-center justify-between border-b border-rule pb-3">
            <span className="text-xs text-ink-3">统计数据来源</span>
            <div className="flex items-center rounded-lg bg-hover p-0.5 text-xs">
              <button
                type="button"
                onClick={() => setViewSource('local')}
                className={`rounded-md px-2.5 py-1 font-medium transition-all ${
                  viewSource === 'local' ? 'bg-panel text-ink-1 shadow-sm' : 'text-ink-3 hover:text-ink-1'
                }`}
              >
                本机 IndexedDB
              </button>
              <button
                type="button"
                onClick={() => setViewSource('server')}
                className={`flex items-center gap-1 rounded-md px-2.5 py-1 font-medium transition-all ${
                  viewSource === 'server' ? 'bg-panel text-ink-1 shadow-sm' : 'text-ink-3 hover:text-ink-1'
                }`}
              >
                <Server size={12} />
                <span>服务端云汇聚</span>
              </button>
            </div>
          </div>
        )}

        {/* KPI 核心指标卡片矩阵 */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="rounded-xl border border-rule bg-panel p-3.5 flex flex-col gap-1">
            <div className="flex items-center gap-1.5 text-xs text-ink-3">
              <Zap size={14} className="text-accent" />
              <span>总 Token 消耗</span>
            </div>
            <div className="text-xl font-bold tracking-tight text-ink-1">
              {totalTokens.toLocaleString()}
            </div>
            <div className="text-[10px] text-ink-3">
              {isServer ? '服务端实录计费' : '所有会话累计'}
            </div>
          </div>

          <div className="rounded-xl border border-rule bg-panel p-3.5 flex flex-col gap-1">
            <div className="flex items-center gap-1.5 text-xs text-ink-3">
              <Coins size={14} className="text-amber-500" />
              <span>预估费用</span>
            </div>
            <div className="text-xl font-bold tracking-tight text-ink-1">
              ${estimatedCost.toFixed(4)}
            </div>
            <div className="text-[10px] text-ink-3">
              ≈ ¥{(estimatedCost * 7.25).toFixed(3)}
            </div>
          </div>

          <div className="rounded-xl border border-rule bg-panel p-3.5 flex flex-col gap-1">
            <div className="flex items-center gap-1.5 text-xs text-ink-3">
              <Activity size={14} className="text-success" />
              <span>输入 / 输出</span>
            </div>
            <div className="text-base font-semibold text-ink-1 truncate">
              {(promptTokens / 1000).toFixed(1)}k / {(completionTokens / 1000).toFixed(1)}k
            </div>
            <div className="text-[10px] text-ink-3">Prompt / Completion</div>
          </div>

          <div className="rounded-xl border border-rule bg-panel p-3.5 flex flex-col gap-1">
            <div className="flex items-center gap-1.5 text-xs text-ink-3">
              {isServer ? <Clock size={14} className="text-purple-500" /> : <Cpu size={14} className="text-purple-500" />}
              <span>{isServer ? '平均延迟 / 请求' : '消息总轮次'}</span>
            </div>
            <div className="text-xl font-bold tracking-tight text-ink-1">
              {isServer ? `${serverStats.totals?.avgLatencyMs || 0}ms` : requestCount}
            </div>
            <div className="text-[10px] text-ink-3">
              {isServer ? `共 ${requestCount} 次调用` : `覆盖 ${conversations.length} 个对话`}
            </div>
          </div>
        </div>

        {/* 模型用量分布 */}
        <div className="flex flex-col gap-3">
          <div className="text-sm font-semibold text-ink-1">模型用量分布</div>
          {localStats.modelUsage.length === 0 && (!serverStats?.byModel || serverStats.byModel.length === 0) ? (
            <div className="rounded-xl border border-dashed border-rule py-8 text-center text-xs text-ink-3">
              暂无已记录的 Token 消耗数据，开始对话后将自动统计
            </div>
          ) : (
            <div className="flex flex-col gap-2 max-h-56 overflow-auto pr-1">
              {(isServer && serverStats?.byModel
                ? serverStats.byModel.map((m) => [m.model, { count: m.requests, tokens: m.tokens }] as const)
                : localStats.modelUsage
              ).map(([model, data]) => {
                const percent = totalTokens > 0 ? (data.tokens / totalTokens) * 100 : 0
                return (
                  <div
                    key={model}
                    className="flex flex-col gap-1 rounded-xl border border-rule/70 bg-panel/60 p-3"
                  >
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-medium text-ink-1">{model}</span>
                      <span className="text-ink-2 font-mono">
                        {data.tokens.toLocaleString()} tokens ({percent.toFixed(1)}%)
                      </span>
                    </div>
                    {/* 进度条 */}
                    <div className="h-1.5 w-full rounded-full bg-hover overflow-hidden">
                      <div
                        className="h-full rounded-full bg-accent transition-all duration-500"
                        style={{ width: `${percent}%` }}
                      />
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between pt-2 border-t border-rule text-xs text-ink-3">
          <span>{isServer ? '已连接后端 SQLite 实时记账引擎' : '数据存储于本机浏览器 IndexedDB 中'}</span>
          <button
            type="button"
            onClick={onClose}
            className="press rounded-lg bg-accent px-4 py-1.5 text-xs font-medium text-on-accent hover:bg-accent-hover shadow-1"
          >
            完成
          </button>
        </div>
      </div>
    </Modal>
  )
}
