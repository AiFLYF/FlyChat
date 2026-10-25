interface BrandIconProps {
  size?: number
  className?: string
  glow?: boolean
}

/**
 * FlyChat 核心矢量品牌图标
 * 结合了超音速气动折纸之翼与神经网络几何交织，象征速度、敏锐与高阶智能
 */
export function BrandIcon({ size = 28, className = '', glow = false }: BrandIconProps) {
  return (
    <div
      className={`relative inline-flex shrink-0 items-center justify-center ${className}`}
      style={{ width: size, height: size }}
    >
      {glow && (
        <div
          className="absolute inset-0 rounded-xl bg-accent/25 blur-md -z-10 transition-opacity"
          aria-hidden="true"
        />
      )}
      <svg
        viewBox="0 0 48 48"
        width={size}
        height={size}
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="transition-transform duration-300 ease-out hover:scale-105"
      >
        <defs>
          <linearGradient id="fly-grad-main" x1="4" y1="6" x2="44" y2="42" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#3b82f6" />
            <stop offset="50%" stopColor="#6366f1" />
            <stop offset="100%" stopColor="#8b5cf6" />
          </linearGradient>
          <linearGradient id="fly-grad-wing" x1="16" y1="4" x2="38" y2="28" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#60a5fa" />
            <stop offset="100%" stopColor="#3b82f6" />
          </linearGradient>
          <linearGradient id="fly-grad-accent" x1="20" y1="20" x2="44" y2="44" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#a78bfa" />
            <stop offset="100%" stopColor="#c084fc" />
          </linearGradient>
          <linearGradient id="fly-grad-under" x1="8" y1="24" x2="28" y2="40" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#1e3a8a" stopOpacity="0.8" />
            <stop offset="100%" stopColor="#4338ca" stopOpacity="0.9" />
          </linearGradient>
        </defs>

        {/* 主机翼结构 */}
        <path
          d="M8 24.5L42 7L27 41L21 27.5L8 24.5Z"
          fill="url(#fly-grad-main)"
          className="drop-shadow-sm"
        />
        {/* 上层折光导流翼片 */}
        <path
          d="M21 27.5L42 7L27 21L21 27.5Z"
          fill="url(#fly-grad-wing)"
          fillOpacity="0.9"
        />
        {/* 核心推进与下部机腹阴影 */}
        <path
          d="M8 24.5L21 27.5L16 35L8 24.5Z"
          fill="url(#fly-grad-under)"
        />
        {/* 翼尖动力几何切角 */}
        <path
          d="M27 41L21 27.5L31 29.5L27 41Z"
          fill="url(#fly-grad-accent)"
        />
        {/* 质感高光流线 */}
        <path
          d="M12 24.8L40 8.2"
          stroke="#ffffff"
          strokeWidth="1.2"
          strokeLinecap="round"
          strokeOpacity="0.45"
        />
      </svg>
    </div>
  )
}

interface BrandLogoProps {
  size?: 'sm' | 'md' | 'lg'
  showBadge?: boolean
  badgeText?: string
  className?: string
  glow?: boolean
}

/**
 * 完整品牌标徽（图标 + 精致定制标准字 + 版本标识）
 */
export function BrandLogo({
  size = 'md',
  showBadge = false,
  badgeText = 'SOTA',
  className = '',
  glow = false,
}: BrandLogoProps) {
  const iconSize = size === 'sm' ? 22 : size === 'lg' ? 36 : 28
  const textClass =
    size === 'sm'
      ? 'text-base font-semibold tracking-tight'
      : size === 'lg'
        ? 'text-2xl font-bold tracking-tight'
        : 'text-lg font-semibold tracking-tight'

  return (
    <div className={`inline-flex items-center gap-2.5 select-none ${className}`}>
      <BrandIcon size={iconSize} glow={glow} />
      <div className="flex items-center gap-1.5">
        <span className={`font-sans text-ink-1 leading-none ${textClass}`}>
          Fly<span className="text-accent">Chat</span>
        </span>
        {showBadge && (
          <span className="rounded-full bg-accent-soft px-1.5 py-0.5 text-[10px] font-medium leading-none text-accent border border-accent/20">
            {badgeText}
          </span>
        )}
      </div>
    </div>
  )
}

export default BrandLogo
