import { useState } from 'react'
import { BookOpen, ChevronDown, ChevronRight, FileText } from 'lucide-react'
import type { KnowledgeSource } from '../types'

export default function KnowledgeSourcesBlock({ sources }: { sources?: KnowledgeSource[] }) {
  const [open, setOpen] = useState(false)
  const [activeSnippetIdx, setActiveSnippetIdx] = useState<number | null>(null)

  if (!sources || sources.length === 0) return null

  return (
    <div className="mt-3 rounded-xl border border-rule/70 bg-panel/60 p-2.5 text-xs">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between text-left font-medium text-ink-2 hover:text-ink-1 transition-colors"
      >
        <div className="flex items-center gap-1.5">
          <BookOpen size={14} className="text-accent" />
          <span>知识库检索参考来源</span>
          <span className="rounded-full bg-accent-soft px-1.5 py-0.2 text-[10px] font-semibold text-accent">
            {sources.length}
          </span>
        </div>
        <div className="flex items-center gap-1 text-[11px] text-ink-4">
          <span>{open ? '收起' : '展开查看'}</span>
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </div>
      </button>

      {open && (
        <div className="mt-2.5 space-y-2 border-t border-rule/50 pt-2 anim-fade-in">
          {sources.map((src, i) => {
            const isSnippetOpen = activeSnippetIdx === i
            const simPercent =
              typeof src.similarity === 'number'
                ? Math.round(src.similarity * 100)
                : null

            return (
              <div
                key={i}
                className="rounded-lg border border-rule/50 bg-canvas/80 p-2 text-xs transition-colors"
              >
                <div
                  className="flex cursor-pointer items-center justify-between gap-2"
                  onClick={() => setActiveSnippetIdx(isSnippetOpen ? null : i)}
                >
                  <div className="flex items-center gap-1.5 min-w-0 flex-1">
                    <FileText size={13} className="shrink-0 text-ink-3" />
                    <span className="font-medium text-ink-1 truncate">
                      {src.title || src.documentName || `参考片段 #${i + 1}`}
                    </span>
                    {typeof src.chunkIndex === 'number' && (
                      <span className="text-[10px] text-ink-4">分块 #{src.chunkIndex + 1}</span>
                    )}
                  </div>

                  <div className="flex items-center gap-1.5 shrink-0">
                    {simPercent !== null && (
                      <span className="rounded bg-accent-soft px-1.5 py-0.5 text-[10px] font-medium text-accent">
                        {simPercent}% 匹配
                      </span>
                    )}
                    {isSnippetOpen ? (
                      <ChevronDown size={12} className="text-ink-4" />
                    ) : (
                      <ChevronRight size={12} className="text-ink-4" />
                    )}
                  </div>
                </div>

                {isSnippetOpen && (
                  <div className="mt-2 rounded-md bg-panel p-2 text-[11px] leading-relaxed text-ink-2 whitespace-pre-wrap border border-rule/30 font-mono">
                    {src.content}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
