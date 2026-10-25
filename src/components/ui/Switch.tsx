import { useId } from 'react'

interface Props {
  checked: boolean
  onChange: (v: boolean) => void
  /** 无障碍名称；视觉上不可见但会被读屏播报 */
  label: string
  disabled?: boolean
  /** sm = 顶栏紧凑开关，md = 设置项标准开关 */
  size?: 'sm' | 'md'
  className?: string
}

const SIZES = {
  sm: { track: 'h-4 w-8', knob: 'h-3 w-3', on: 'left-4', off: 'left-0.5', top: 'top-0.5' },
  md: { track: 'h-5 w-9', knob: 'h-4 w-4', on: 'left-[18px]', off: 'left-0.5', top: 'top-0.5' },
} as const

/**
 * 统一开关组件。
 *
 * 改动原因：ModelSelector（sm）与 SettingsModal（md）各写了一份结构相同、
 * 尺寸不同的开关，且都没有 `aria-labelledby` 关联文字、禁用态也没有
 * `cursor-not-allowed`。合并后尺寸由 size 决定，无障碍属性统一补齐。
 */
export default function Switch({
  checked,
  onChange,
  label,
  disabled,
  size = 'md',
  className = '',
}: Props) {
  const id = useId()
  const s = SIZES[size]
  return (
    <>
      <span id={id} className="sr-only">
        {label}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={id}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative shrink-0 rounded-full transition-colors duration-200 ease-out disabled-x ${
          s.track
        } ${checked ? 'bg-accent' : 'bg-rule-strong'} ${className}`}
      >
        <span
          className={`absolute rounded-full bg-white shadow-1 transition-all duration-200 ease-[var(--ease-spring)] ${s.knob} ${s.top} ${
            checked ? s.on : s.off
          }`}
        />
      </button>
    </>
  )
}
