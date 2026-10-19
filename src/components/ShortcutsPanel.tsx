import { Keyboard } from 'lucide-react'
import { useShortcutsOpen } from './openPanels'
import Modal from './ui/Modal'

interface Shortcut {
  keys: string[]
  desc: string
}

/** 只列实际已实现的快捷键，避免文档与行为不一致 */
const GROUPS: { title: string; items: Shortcut[] }[] = [
  {
    title: '消息与全局',
    items: [
      { keys: ['Enter'], desc: '发送消息' },
      { keys: ['Shift', 'Enter'], desc: '换行（不发送）' },
      { keys: ['Ctrl', 'K'], desc: '打开全局快捷指令面板' },
      { keys: ['/'], desc: '聚焦输入框' },
      { keys: ['Ctrl', 'Enter'], desc: '编辑消息时：保存并重新发送' },
    ],
  },
  {
    title: '界面',
    items: [
      { keys: ['Ctrl', 'B'], desc: '显示 / 隐藏侧边栏' },
      { keys: ['Ctrl', 'Shift', 'O'], desc: '新建对话' },
      { keys: ['Esc'], desc: '关闭弹窗与浮层' },
      { keys: ['?'], desc: '打开本说明' },
    ],
  },
]

/**
 * 快捷键说明面板。
 *
 * 改动原因：产品里已经有一批快捷键（发送/换行/聚焦/侧栏/新对话/Esc），
 * 但界面上没有任何地方说明，键盘用户很难发现。
 */
export default function ShortcutsPanel() {
  // Esc 关闭已由 App 的全局快捷键统一处理，这里只管内容
  const open = useShortcutsOpen((s) => s.open)
  const setOpen = useShortcutsOpen((s) => s.setOpen)

  return (
    <Modal
      open={open}
      onClose={() => setOpen(false)}
      title="快捷键"
      className="max-w-md"
      headerExtra={<Keyboard size={16} className="text-ink-3" aria-hidden />}
    >
      <div className="space-y-6">
        {GROUPS.map((g) => (
          <section key={g.title}>
            <h3 className="mb-3 text-[13px] font-medium text-ink-1">{g.title}</h3>
            <div className="space-y-2.5">
              {g.items.map((s) => (
                <div
                  key={s.desc}
                  className="flex items-center justify-between gap-3 rounded-lg px-2 py-1.5 transition-colors hover:bg-hover/60"
                >
                  <span className="min-w-0 text-[13px] leading-5 text-ink-2">{s.desc}</span>
                  <span className="flex shrink-0 items-center gap-1">
                    {s.keys.map((k, i) => (
                      <span key={k} className="flex items-center gap-1">
                        {i > 0 && <span className="text-[11px] text-ink-4">+</span>}
                        <kbd
                          className="r-sm min-w-6 border border-rule bg-panel px-1.5 py-0.5 
                                     text-center text-[11px] font-medium text-ink-2 tabular-nums shadow-xs transition-transform hover:scale-105"
                        >
                          {k}
                        </kbd>
                      </span>
                    ))}
                  </span>
                </div>
              ))}
            </div>
          </section>
        ))}
        <p className="tnum hairline pt-5 text-[11px] leading-5 text-ink-3">
          Mac 上 Ctrl 对应 ⌘ Command
        </p>
      </div>
    </Modal>
  )
}
