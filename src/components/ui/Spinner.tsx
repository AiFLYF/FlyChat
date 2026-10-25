import { Loader2 } from 'lucide-react'

/**
 * 统一加载指示器。
 *
 * 改动原因：Composer 上传态、SettingsModal 加载态各自内联了
 * `<Loader2 className="animate-spin" />` 且尺寸不一（15/16），
 * MarkdownRenderer 的「正在渲染图表」更是只有文字没有转动反馈。
 * 统一后加载态在全局是同一观感。
 */
export default function Spinner({ size = 15, className = '' }: { size?: number; className?: string }) {
  return (
    <Loader2
      size={size}
      // deslop-ignore-next-line 16 — 加载指示器是功能性元素，必须持续转动
      className={`animate-spin ${className}`}
      aria-hidden
    />
  )
}
