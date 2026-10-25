import { useEffect, type RefObject } from 'react'

/** 系统是否要求减少动效（JS 侧动效需主动尊重该设置） */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/**
 * 滚动视差：把容器的滚动距离映射为 0~1 的 CSS 变量 --scroll，
 * 具体位移/透明度由 CSS（.parallax-hero）决定，JS 不参与逐帧样式计算。
 *
 * - 只在 rAF 中读取一次 scrollTop，避免布局抖动与高频重排
 * - 系统要求减少动效时完全不挂监听
 */
export function useParallax(
  containerRef: RefObject<HTMLElement | null>,
  targetRef: RefObject<HTMLElement | null>,
  /** 滚动多少像素达到视差满值 */
  distance = 240,
  /** 目标是否处于挂载状态；切换空态/对话态时据此重新绑定 */
  enabled = true
) {
  useEffect(() => {
    const container = containerRef.current
    const target = targetRef.current
    if (!enabled || !container || !target || prefersReducedMotion()) return

    let frame = 0
    const update = () => {
      frame = 0
      const progress = Math.min(1, Math.max(0, container.scrollTop / distance))
      target.style.setProperty('--scroll', progress.toFixed(4))
    }
    const onScroll = () => {
      if (frame) return
      frame = requestAnimationFrame(update)
    }

    update()
    container.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      container.removeEventListener('scroll', onScroll)
      if (frame) cancelAnimationFrame(frame)
      // 卸载时清掉残留进度，避免下次挂载瞬间跳变
      target.style.removeProperty('--scroll')
    }
  }, [containerRef, targetRef, distance, enabled])
}

/** 错峰入场的延迟：超过 max 项后不再累加，避免长列表尾部等待过久 */
export function staggerDelay(index: number, step = 28, max = 10): string {
  return `${Math.min(index, max) * step}ms`
}
