import type { CSSProperties } from 'react'

interface Props {
  value: number
  min: number
  max: number
  step: number
  onChange: (v: number) => void
  /** 无障碍名称 */
  label: string
}

/**
 * 自绘滑块。
 *
 * 改动原因：设置里的 temperature / top_p 直接用原生 `<input type="range">`，
 * 在 Windows 上是系统灰轨道 + 方块滑块，悬停、按下、聚焦都毫无反馈，
 * 是弹窗里最「僵硬」的一处。这里把已填充比例通过 --val 交给 CSS 画渐变轨道，
 * 滑块由 CSS 伪元素绘制（hover 放大 / 按下回弹 / 聚焦描边），JS 不做逐帧计算。
 */
export default function Slider({ value, min, max, step, onChange, label }: Props) {
  const pct = max > min ? ((value - min) / (max - min)) * 100 : 0
  return (
    <input
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      aria-label={label}
      onChange={(e) => onChange(Number(e.target.value))}
      className="range"
      // CSS 自定义属性需要断言类型
      style={{ '--val': `${pct}%` } as CSSProperties}
    />
  )
}
