import { useEffect, useState } from 'react'
import { KeyRound, Lock, User, X } from 'lucide-react'
import { useAuthStore } from '../../store/auth'
import { BUTTON_PRIMARY, FIELD, ICON_BTN_SM, LABEL, OVERLAY } from '../../lib/ui'
import { BrandLogo } from '../ui/BrandLogo'

export default function AuthModal() {
  const modalOpen = useAuthStore((s) => s.modalOpen)
  const setModalOpen = useAuthStore((s) => s.setModalOpen)
  const config = useAuthStore((s) => s.config)
  const user = useAuthStore((s) => s.user)
  const login = useAuthStore((s) => s.login)
  const setup = useAuthStore((s) => s.setup)

  const isMulti = config?.authMode === 'multi'
  const isSetup = !!config?.needsSetup

  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  // Esc 关闭：只在「已登录、主动来改密码」时允许。
  // 初始化管理员和登录是强制流程，Esc 把人关在门外等于让应用没法用，
  // 所以这里不能像其它弹窗那样无条件响应。
  useEffect(() => {
    if (!modalOpen || !user) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setModalOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [modalOpen, user, setModalOpen])

  // 当不需要登录或不是多用户模式时，不显示
  if (!isMulti || (!isSetup && user) || !modalOpen) {
    return null
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)

    const u = username.trim()
    if (!u) {
      setError('请输入用户名')
      return
    }

    if (!password) {
      setError('请输入密码')
      return
    }

    if (isSetup) {
      if (password.length < 8) {
        setError('密码长度至少需要 8 位字符')
        return
      }
      if (password !== confirmPassword) {
        setError('两次输入的密码不一致')
        return
      }
    }

    setSubmitting(true)
    try {
      if (isSetup) {
        await setup(u, password, displayName.trim() || undefined)
      } else {
        await login(u, password)
      }
    } catch (err: any) {
      // 按照后端契约规范：登录错误统一提示「用户名或密码不正确」，不泄露用户存在性
      if (err.code === 'invalid_credentials') {
        setError('用户名或密码不正确')
      } else if (err.code === 'weak_password') {
        setError('密码至少需要 8 个字符')
      } else if (err.code === 'username_taken') {
        setError('该用户名已被占用')
      } else {
        setError(err.message || '操作失败，请重试')
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className={OVERLAY}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={isSetup ? '初始化系统管理员' : '账户登录'}
        className="relative w-full max-w-sm rounded-2xl border border-rule bg-panel p-6 shadow-3 anim-modal-rise"
      >
        {/* 如果已经登录了只是手动打开修改，允许关闭；若未登录则强制完成 */}
        {user && (
          <button
            onClick={() => setModalOpen(false)}
            className={`absolute right-4 top-4 ${ICON_BTN_SM}`}
            aria-label="关闭"
          >
            <X size={15} />
          </button>
        )}

        <div className="mb-6 text-center">
          <div className="mb-3 flex justify-center">
            <BrandLogo size="lg" glow />
          </div>
          <h2 className="text-lg font-semibold text-ink-1">
            {isSetup ? '初始化系统管理员' : '登录 FlyChat'}
          </h2>
          <p className="mt-1 text-xs text-ink-3">
            {isSetup
              ? '本实例尚未创建账号，第一个账号将获得最高管理员权限'
              : '输入用户名和密码以访问您的会话与数据'}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3.5">
          {error && (
            <div className="rounded-lg border border-danger/20 bg-danger/10 px-3 py-2 text-xs text-danger anim-fade-in">
              {error}
            </div>
          )}

          <div>
            <label className={LABEL}>用户名</label>
            <div className="relative">
              <User size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-3" />
              <input
                autoFocus
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="例如 admin"
                className={`${FIELD} pl-8.5`}
                autoComplete="username"
              />
            </div>
          </div>

          {isSetup && (
            <div>
              <label className={LABEL}>显示名称（可选）</label>
              <input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="管理员"
                className={FIELD}
              />
            </div>
          )}

          <div>
            <label className={LABEL}>密码</label>
            <div className="relative">
              <Lock size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-3" />
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={isSetup ? '至少 8 个字符' : '••••••••'}
                className={`${FIELD} pl-8.5`}
                autoComplete={isSetup ? 'new-password' : 'current-password'}
              />
            </div>
          </div>

          {isSetup && (
            <div>
              <label className={LABEL}>确认密码</label>
              <div className="relative">
                <KeyRound size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-3" />
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="重复输入密码"
                  className={`${FIELD} pl-8.5`}
                  autoComplete="new-password"
                />
              </div>
            </div>
          )}

          <div className="pt-2">
            <button
              type="submit"
              disabled={submitting}
              className={`${BUTTON_PRIMARY} w-full justify-center py-2.5 font-medium`}
            >
              {submitting ? '请稍候...' : isSetup ? '创建并开启服务' : '立即登录'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
