import { useRef, useState } from 'react'
import { BookMarked, Plus, Search } from 'lucide-react'
import { useChatStore } from '../store/chat'
import { useDismiss } from '../lib/useDismiss'
import { FIELD, EMPTY_HINT } from '../lib/ui'
import { MenuPanel } from './ui/Menu'

interface Props {
  onPick: (content: string) => void
  /** 输入框内联：渲染为功能胶囊样式 */
  pill?: boolean
}

/** 提示词库选择器：点选后插入到输入框 */
export default function PromptPicker({ onPick, pill }: Props) {
  const prompts = useChatStore((s) => s.prompts)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const ref = useRef<HTMLDivElement>(null)

  useDismiss(ref, () => setOpen(false), open)

  const filtered = prompts.filter(
    (p) =>
      !query.trim() ||
      p.title.toLowerCase().includes(query.toLowerCase()) ||
      p.content.toLowerCase().includes(query.toLowerCase())
  )

  const buttonClass = pill
    ? // 窄屏只留图标：输入行在 360px 宽度下会挤到溢出
      `press flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-xs transition-ui ${
        open
          ? 'border-transparent bg-accent-soft font-medium text-accent'
          : 'border-rule text-ink-2 hover:bg-hover hover:text-ink-1'
      }`
    : 'r-sm press flex h-9 w-8 items-center justify-center text-ink-3 transition-ui hover:bg-hover hover:text-ink-1'

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={buttonClass}
        aria-label="提示词库"
        aria-haspopup="menu"
        aria-expanded={open}
        title="提示词库"
      >
        <BookMarked size={15} />
        {pill && <span className="hidden sm:inline">提示词</span>}
      </button>

      <MenuPanel
        open={open}
        position="absolute bottom-10 left-0 z-30 w-[min(18rem,calc(100vw-2rem))]"
        origin="bottom-left"
        label="提示词库"
      >
        <div className="border-b border-rule p-2">
          <div className="relative">
            <Search
              size={13}
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3"
            />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索提示词…"
              aria-label="搜索提示词"
              className={`${FIELD} pl-8`}
            />
          </div>
        </div>

        <div className="max-h-64 overflow-y-auto p-1">
          {filtered.length === 0 ? (
            <div className={EMPTY_HINT}>
              <BookMarked size={18} className="mx-auto mb-1.5 text-ink-3" aria-hidden />
              {prompts.length === 0 ? (
                <>
                  还没有提示词
                  <br />
                  可在「设置 → 提示词库」中添加
                </>
              ) : (
                '没有匹配的提示词'
              )}
            </div>
          ) : (
            filtered.map((p) => (
              <button
                key={p.id}
                type="button"
                role="menuitem"
                onClick={() => {
                  onPick(p.content)
                  setOpen(false)
                  setQuery('')
                }}
                className="r-sm block w-full px-2.5 py-2 text-left transition-ui hover:bg-hover"
              >
                <p className="truncate text-[13px] text-ink-1">{p.title}</p>
                <p className="mt-0.5 line-clamp-2 text-[11px] leading-4 text-ink-3">{p.content}</p>
              </button>
            ))
          )}
        </div>

        <div className="border-t border-rule px-3 py-2 text-[11px] text-ink-3">
          <Plus size={11} className="mr-1 inline" />
          在设置中添加与管理
        </div>
      </MenuPanel>
    </div>
  )
}
