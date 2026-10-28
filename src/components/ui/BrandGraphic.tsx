import { useEffect, useRef } from 'react'

/**
 * 动态环境星系光斑画布
 * 用于 Hero 空态背景，赋予界面类似 Claude / OpenAI 官网的通透科技质感
 */
export function ConstellationHero({ className = '' }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let animationFrameId: number
    let width = (canvas.width = canvas.parentElement?.clientWidth || 800)
    let height = (canvas.height = canvas.parentElement?.clientHeight || 400)

    const handleResize = () => {
      if (!canvas || !canvas.parentElement) return
      width = canvas.width = canvas.parentElement.clientWidth
      height = canvas.height = canvas.parentElement.clientHeight
    }
    window.addEventListener('resize', handleResize)

    // 生成少量轻量粒子
    const particleCount = 28
    const particles = Array.from({ length: particleCount }, () => ({
      x: Math.random() * width,
      y: Math.random() * height,
      vx: (Math.random() - 0.5) * 0.35,
      vy: (Math.random() - 0.5) * 0.35,
      radius: Math.random() * 1.5 + 0.8,
      alpha: Math.random() * 0.4 + 0.15,
    }))

    const render = () => {
      ctx.clearRect(0, 0, width, height)

      // 绘制粒子与临近连线
      for (let i = 0; i < particleCount; i++) {
        const p1 = particles[i]
        p1.x += p1.vx
        p1.y += p1.vy

        if (p1.x < 0 || p1.x > width) p1.vx *= -1
        if (p1.y < 0 || p1.y > height) p1.vy *= -1

        ctx.beginPath()
        ctx.arc(p1.x, p1.y, p1.radius, 0, Math.PI * 2)
        ctx.fillStyle = `rgba(99, 102, 241, ${p1.alpha})`
        ctx.fill()

        for (let j = i + 1; j < particleCount; j++) {
          const p2 = particles[j]
          const dx = p1.x - p2.x
          const dy = p1.y - p2.y
          const dist = Math.sqrt(dx * dx + dy * dy)
          if (dist < 110) {
            ctx.beginPath()
            ctx.moveTo(p1.x, p1.y)
            ctx.lineTo(p2.x, p2.y)
            const lineAlpha = (1 - dist / 110) * 0.12
            ctx.strokeStyle = `rgba(99, 102, 241, ${lineAlpha})`
            ctx.lineWidth = 0.8
            ctx.stroke()
          }
        }
      }

      animationFrameId = requestAnimationFrame(render)
    }

    render()

    return () => {
      cancelAnimationFrame(animationFrameId)
      window.removeEventListener('resize', handleResize)
    }
  }, [])

  return (
    <div className={`pointer-events-none absolute inset-0 overflow-hidden ${className}`} aria-hidden="true">
      {/* 顶部柔和环境弥散光晕 */}
      <div className="absolute -top-24 left-1/2 -translate-x-1/2 w-[min(520px,100vw)] h-[260px] rounded-full bg-gradient-to-br from-blue-500/10 via-indigo-500/10 to-purple-500/5 blur-3xl" />
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full opacity-60 dark:opacity-40" />
    </div>
  )
}

/**
 * 实时录音/音频播放波形指示器
 */
export function AudioWaveform({ active = false, className = '' }: { active?: boolean; className?: string }) {
  return (
    <div className={`flex items-center gap-[3px] h-4 ${className}`} aria-label="音频波形">
      {[0.4, 0.8, 1.2, 0.6, 1.0, 0.5].map((delay, i) => (
        <span
          key={i}
          className={`w-[2.5px] rounded-full bg-accent transition-all duration-200 ${
            active ? 'animate-pulse' : 'h-1 opacity-40'
          }`}
          style={{
            height: active ? `${Math.sin(i * 1.5) * 8 + 10}px` : '4px',
            animationDuration: `${0.6 + delay * 0.4}s`,
            animationDelay: `${delay * 0.15}s`,
          }}
        />
      ))}
    </div>
  )
}

/**
 * 空会话极简几何插图
 */
export function EmptyConversationGraphic({ size = 80, className = '' }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 96 96"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      <circle cx="48" cy="48" r="40" className="fill-panel stroke-rule" strokeWidth="1.5" />
      <circle cx="48" cy="48" r="28" stroke="currentColor" strokeDasharray="3 3" className="stroke-ink-4 opacity-40" />
      {/* 对话气泡几何投影 */}
      <rect x="30" y="32" width="36" height="24" rx="8" className="fill-accent-soft stroke-accent" strokeWidth="1.5" />
      <path d="M42 56L38 62L48 56" className="fill-accent-soft stroke-accent" strokeWidth="1.5" strokeLinejoin="round" />
      {/* 内部微光点 */}
      <circle cx="40" cy="44" r="2" className="fill-accent" />
      <circle cx="48" cy="44" r="2" className="fill-accent" />
      <circle cx="56" cy="44" r="2" className="fill-accent" />
    </svg>
  )
}
