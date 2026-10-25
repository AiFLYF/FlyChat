import { useEffect, useState } from 'react'
import { prefersReducedMotion } from './motion'

type Phase = 'closed' | 'open' | 'closing'

/**
 * 让「关闭」也能播放退场动画。
 *
 * 原先弹窗/下拉都是 `{open && <X/>}`，open 变 false 就立刻卸载，
 * 只有进场动画、退场是「啪」地消失——这正是「僵硬不丝滑」的主因。
 *
 * 用法：始终渲染组件，用返回的 closing 切换进场/退场动画类。
 * 动画结束后（exitMs）才真正卸载。
 */
export function usePresence(open: boolean, exitMs = 200) {
  const [phase, setPhase] = useState<Phase>(open ? 'open' : 'closed')

  useEffect(() => {
    if (open) {
      setPhase('open')
      return
    }
    // 只有原本处于 open 才需要走退场；closed 保持不动
    setPhase((p) => (p === 'open' ? 'closing' : p))
  }, [open])

  useEffect(() => {
    if (phase !== 'closing') return
    // 系统要求减少动效时立刻卸载，不留无谓等待
    const ms = prefersReducedMotion() ? 0 : exitMs
    const timer = setTimeout(() => setPhase('closed'), ms)
    return () => clearTimeout(timer)
  }, [phase, exitMs])

  return {
    /** 是否需要挂载（含退场中） */
    mounted: phase !== 'closed',
    /** 是否正在退场（用于切换成退场动画类） */
    closing: phase === 'closing',
  }
}
