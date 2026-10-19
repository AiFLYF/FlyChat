import { useState } from 'react'
import { Check, ChevronDown, ChevronRight, Loader2, Wrench, XCircle } from 'lucide-react'
import type { ToolCall, ToolResult } from '../types'

export default function ToolCallsBlock({
  toolCalls,
  toolResults = [],
}: {
  toolCalls: ToolCall[]
  toolResults?: ToolResult[]
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null)

  if (!toolCalls || toolCalls.length === 0) return null

  return (
    <div className="mb-2.5 space-y-1.5">
      {toolCalls.map((tc) => {
        const result = toolResults.find((r) => r.id === tc.id)
        const isExpanded = expandedId === tc.id
        const isRunning = tc.status === 'running' && !result
        const isError = tc.status === 'error' || !!result?.error

        let formattedArgs = ''
        try {
          formattedArgs =
            typeof tc.arguments === 'string'
              ? JSON.stringify(JSON.parse(tc.arguments), null, 2)
              : JSON.stringify(tc.arguments, null, 2)
        } catch {
          formattedArgs = String(tc.arguments)
        }

        let formattedResult = ''
        if (result) {
          try {
            formattedResult =
              typeof result.result === 'string'
                ? result.result
                : JSON.stringify(result.result, null, 2)
          } catch {
            formattedResult = String(result.result)
          }
        }

        return (
          <div
            key={tc.id}
            className="rounded-xl border border-rule/70 bg-panel/70 overflow-hidden text-xs transition-ui shadow-sm"
          >
            <button
              type="button"
              onClick={() => setExpandedId(isExpanded ? null : tc.id)}
              className="flex w-full items-center justify-between px-3 py-2 text-left hover:bg-hover transition-colors"
            >
              <div className="flex items-center gap-2 min-w-0">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-accent-soft text-accent">
                  <Wrench size={12} />
                </span>
                <span className="font-mono font-medium text-ink-1 truncate">{tc.name}</span>
                <span className="text-[10px] text-ink-4">调用工具</span>
              </div>

              <div className="flex items-center gap-1.5 shrink-0">
                {isRunning ? (
                  <span className="flex items-center gap-1 text-[11px] text-accent">
                    <Loader2 size={12} className="animate-spin" />
                    <span>执行中…</span>
                  </span>
                ) : isError ? (
                  <span className="flex items-center gap-1 text-[11px] text-danger">
                    <XCircle size={12} />
                    <span>调用失败</span>
                  </span>
                ) : (
                  <span className="flex items-center gap-1 text-[11px] text-emerald-500">
                    <Check size={12} />
                    <span>完成</span>
                  </span>
                )}
                {isExpanded ? (
                  <ChevronDown size={13} className="text-ink-4" />
                ) : (
                  <ChevronRight size={13} className="text-ink-4" />
                )}
              </div>
            </button>

            {isExpanded && (
              <div className="border-t border-rule/50 bg-canvas/60 p-3 space-y-2.5 font-mono text-[11px]">
                <div>
                  <div className="text-[10px] uppercase font-semibold tracking-wider text-ink-4 mb-1">
                    入参 (Arguments)
                  </div>
                  <pre className="overflow-x-auto rounded-lg bg-panel p-2.5 border border-rule/40 text-ink-2 leading-relaxed whitespace-pre-wrap">
                    {formattedArgs || '（无入参）'}
                  </pre>
                </div>

                {result && (
                  <div>
                    <div className="text-[10px] uppercase font-semibold tracking-wider text-ink-4 mb-1">
                      执行结果 (Result)
                    </div>
                    {result.error ? (
                      <pre className="overflow-x-auto rounded-lg bg-danger/10 p-2.5 border border-danger/20 text-danger leading-relaxed whitespace-pre-wrap">
                        {result.error}
                      </pre>
                    ) : (
                      <pre className="overflow-x-auto rounded-lg bg-panel p-2.5 border border-rule/40 text-ink-2 leading-relaxed whitespace-pre-wrap max-h-48">
                        {formattedResult || '（无返回值）'}
                      </pre>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
