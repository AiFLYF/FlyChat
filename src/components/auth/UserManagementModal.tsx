import { useEffect, useState } from 'react'
import {
  Ban,
  Check,
  KeyRound,
  Plus,
  Shield,
  Trash2,
  UserCheck,
  X,
} from 'lucide-react'
import {
  createUser,
  deleteUser,
  fetchUsers,
  updateUser,
} from '../../api/client'
import { useAuthStore } from '../../store/auth'
import { BUTTON_PRIMARY, FIELD, ICON_BTN_SM } from '../../lib/ui'
import type { AuthUser, UserRole } from '../../types'

export default function UserManagementModal() {
  const open = useAuthStore((s) => s.userManagementOpen)
  const setOpen = useAuthStore((s) => s.setUserManagementOpen)
  const currentUser = useAuthStore((s) => s.user)

  const [users, setUsers] = useState<AuthUser[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 新增用户表单态
  const [showAddForm, setShowAddForm] = useState(false)
  const [newUsername, setNewUsername] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [newDisplayName, setNewDisplayName] = useState('')
  const [newRole, setNewRole] = useState<UserRole>('user')
  const [creating, setCreating] = useState(false)

  // 重置密码态
  const [resettingId, setResettingId] = useState<string | null>(null)
  const [resetPassword, setResetPassword] = useState('')

  const loadList = async () => {
    try {
      setLoading(true)
      const res = await fetchUsers()
      setUsers(res.items || [])
    } catch (err: any) {
      setError(err.message || '加载用户列表失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (open) {
      setError(null)
      loadList()
    }
  }, [open])

  if (!open) return null

  // 统计当前管理员数量，用于保护最后一个管理员
  const adminCount = users.filter((u) => u.role === 'admin' && !u.disabled).length

  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    if (!newUsername.trim() || !newPassword) {
      setError('用户名和初始密码为必填项')
      return
    }
    if (newPassword.length < 8) {
      setError('初始密码至少需要 8 个字符')
      return
    }

    setCreating(true)
    try {
      await createUser({
        username: newUsername.trim(),
        password: newPassword,
        displayName: newDisplayName.trim() || undefined,
        role: newRole,
      })
      setShowAddForm(false)
      setNewUsername('')
      setNewPassword('')
      setNewDisplayName('')
      setNewRole('user')
      await loadList()
    } catch (err: any) {
      setError(err.message || '创建用户失败')
    } finally {
      setCreating(false)
    }
  }

  const handleToggleDisable = async (user: AuthUser) => {
    if (user.role === 'admin' && !user.disabled && adminCount <= 1) {
      alert('系统至少需要保留一个有效的管理员')
      return
    }
    try {
      await updateUser(user.id, { disabled: !user.disabled })
      await loadList()
    } catch (err: any) {
      alert(err.message || '操作失败')
    }
  }

  const handleToggleRole = async (user: AuthUser) => {
    if (user.role === 'admin' && adminCount <= 1) {
      alert('系统至少需要保留一个管理员，无法降级最后一个管理员')
      return
    }
    const nextRole: UserRole = user.role === 'admin' ? 'user' : 'admin'
    try {
      await updateUser(user.id, { role: nextRole })
      await loadList()
    } catch (err: any) {
      alert(err.message || '角色修改失败')
    }
  }

  const handleDeleteUser = async (user: AuthUser) => {
    if (user.role === 'admin' && adminCount <= 1) {
      alert('系统至少需要保留一个管理员，不可删除')
      return
    }
    if (!confirm(`确定要彻底删除用户「${user.username}」吗？`)) return
    try {
      await deleteUser(user.id)
      await loadList()
    } catch (err: any) {
      alert(err.message || '删除失败')
    }
  }

  const handleCommitResetPassword = async (id: string) => {
    if (!resetPassword || resetPassword.length < 8) {
      alert('重置密码至少需要 8 个字符')
      return
    }
    try {
      await updateUser(id, { password: resetPassword })
      setResettingId(null)
      setResetPassword('')
      alert('密码重置成功')
    } catch (err: any) {
      alert(err.message || '重置失败')
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm anim-fade-in">
      <div className="relative flex max-h-[85vh] w-full max-w-2xl flex-col rounded-2xl border border-rule bg-panel shadow-3 anim-modal-rise overflow-hidden">
        {/* 标题栏 */}
        <div className="flex h-14 shrink-0 items-center justify-between border-b border-rule px-5">
          <div className="flex items-center gap-2">
            <Shield className="text-accent" size={18} />
            <h2 className="text-base font-semibold text-ink-1">用户与权限管理</h2>
          </div>
          <button onClick={() => setOpen(false)} className={ICON_BTN_SM} aria-label="关闭">
            <X size={15} />
          </button>
        </div>

        {/* 顶部操作与错误提示 */}
        <div className="p-5 pb-3">
          {error && (
            <div className="mb-3 rounded-lg border border-danger/20 bg-danger/10 px-3 py-2 text-xs text-danger">
              {error}
            </div>
          )}

          <div className="flex items-center justify-between">
            <span className="text-xs text-ink-3">
              共 {users.length} 位用户 · {adminCount} 位管理员
            </span>
            <button
              onClick={() => setShowAddForm((v) => !v)}
              className={`${BUTTON_PRIMARY} py-1.5 text-xs`}
            >
              <Plus size={14} />
              <span>新建账号</span>
            </button>
          </div>
        </div>

        {/* 新建用户抽屉表单 */}
        {showAddForm && (
          <form
            onSubmit={handleCreateUser}
            className="mx-5 mb-4 rounded-xl border border-accent/30 bg-hover-soft p-4 space-y-3 anim-fade-down"
          >
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-ink-1">添加新用户</span>
              <button
                type="button"
                onClick={() => setShowAddForm(false)}
                className="text-ink-4 hover:text-ink-1"
              >
                <X size={14} />
              </button>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-[11px] font-medium text-ink-2">用户名 *</label>
                <input
                  required
                  value={newUsername}
                  onChange={(e) => setNewUsername(e.target.value)}
                  placeholder="例如 alice"
                  className={FIELD}
                />
              </div>
              <div>
                <label className="mb-1 block text-[11px] font-medium text-ink-2">初始密码 (≥8位) *</label>
                <input
                  required
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="••••••••"
                  className={FIELD}
                />
              </div>
              <div>
                <label className="mb-1 block text-[11px] font-medium text-ink-2">显示名称</label>
                <input
                  value={newDisplayName}
                  onChange={(e) => setNewDisplayName(e.target.value)}
                  placeholder="例如 Alice"
                  className={FIELD}
                />
              </div>
              <div>
                <label className="mb-1 block text-[11px] font-medium text-ink-2">角色</label>
                <select
                  value={newRole}
                  onChange={(e) => setNewRole(e.target.value as UserRole)}
                  className={FIELD}
                >
                  <option value="user">普通用户 (User)</option>
                  <option value="admin">系统管理员 (Admin)</option>
                </select>
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setShowAddForm(false)}
                className="rounded-lg px-3 py-1.5 text-xs text-ink-2 hover:bg-hover"
              >
                取消
              </button>
              <button
                type="submit"
                disabled={creating}
                className={`${BUTTON_PRIMARY} py-1.5 text-xs`}
              >
                {creating ? '创建中...' : '确认创建'}
              </button>
            </div>
          </form>
        )}

        {/* 用户列表 */}
        <div className="flex-1 overflow-y-auto px-5 pb-5">
          {loading ? (
            <div className="py-12 text-center text-xs text-ink-3">正在加载用户数据...</div>
          ) : (
            <div className="divide-y divide-rule rounded-xl border border-rule bg-panel">
              {users.map((u) => {
                const isSelf = currentUser?.id === u.id
                const isLastAdmin = u.role === 'admin' && adminCount <= 1 && !u.disabled

                return (
                  <div key={u.id} className="flex items-center justify-between p-3.5 hover:bg-hover-soft transition-colors">
                    <div className="flex items-center gap-3 min-w-0 flex-1">
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-hover text-ink-2 font-semibold text-sm">
                        {u.displayName?.[0] || u.username[0]?.toUpperCase() || 'U'}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-xs text-ink-1 truncate">
                            {u.displayName ? `${u.displayName} (@${u.username})` : u.username}
                          </span>
                          {isSelf && (
                            <span className="rounded bg-accent/15 px-1.5 py-0.2 text-[10px] font-medium text-accent">
                              当前账号
                            </span>
                          )}
                          <span
                            className={`rounded px-1.5 py-0.2 text-[10px] font-medium ${
                              u.role === 'admin'
                                ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
                                : 'bg-hover text-ink-3'
                            }`}
                          >
                            {u.role === 'admin' ? '管理员' : '普通用户'}
                          </span>
                          {u.disabled && (
                            <span className="rounded bg-danger/15 px-1.5 py-0.2 text-[10px] font-medium text-danger">
                              已禁用
                            </span>
                          )}
                        </div>
                        <p className="mt-0.5 text-[11px] text-ink-4">
                          {u.lastLoginAt ? `最近登录: ${new Date(u.lastLoginAt).toLocaleString()}` : '尚未登录'}
                        </p>
                      </div>
                    </div>

                    {/* 操作区 */}
                    <div className="flex items-center gap-1.5 shrink-0 ml-4">
                      {resettingId === u.id ? (
                        <div className="flex items-center gap-1">
                          <input
                            type="password"
                            placeholder="新密码(≥8位)"
                            value={resetPassword}
                            onChange={(e) => setResetPassword(e.target.value)}
                            className="h-7 w-28 rounded border border-rule px-2 text-xs"
                          />
                          <button
                            onClick={() => handleCommitResetPassword(u.id)}
                            className={ICON_BTN_SM}
                            title="确认"
                          >
                            <Check size={13} />
                          </button>
                          <button
                            onClick={() => {
                              setResettingId(null)
                              setResetPassword('')
                            }}
                            className={ICON_BTN_SM}
                            title="取消"
                          >
                            <X size={13} />
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => {
                            setResettingId(u.id)
                            setResetPassword('')
                          }}
                          className={ICON_BTN_SM}
                          title="重置密码"
                        >
                          <KeyRound size={13} />
                        </button>
                      )}

                      {/* 切换角色 */}
                      <button
                        onClick={() => handleToggleRole(u)}
                        disabled={isLastAdmin}
                        className={`${ICON_BTN_SM} ${isLastAdmin ? 'opacity-30 cursor-not-allowed' : ''}`}
                        title={
                          isLastAdmin
                            ? '至少保留一个管理员'
                            : u.role === 'admin'
                              ? '降级为普通用户'
                              : '提升为管理员'
                        }
                      >
                        <Shield size={13} />
                      </button>

                      {/* 禁用 / 启用 */}
                      <button
                        onClick={() => handleToggleDisable(u)}
                        disabled={isLastAdmin}
                        className={`${ICON_BTN_SM} ${isLastAdmin ? 'opacity-30 cursor-not-allowed' : ''} ${
                          u.disabled ? 'text-success' : 'hover:text-danger'
                        }`}
                        title={
                          isLastAdmin
                            ? '不能禁用最后一个管理员'
                            : u.disabled
                              ? '启用账号'
                              : '禁用账号'
                        }
                      >
                        {u.disabled ? <UserCheck size={13} /> : <Ban size={13} />}
                      </button>

                      {/* 删除 */}
                      <button
                        onClick={() => handleDeleteUser(u)}
                        disabled={isLastAdmin}
                        className={`${ICON_BTN_SM} hover:text-danger ${
                          isLastAdmin ? 'opacity-30 cursor-not-allowed' : ''
                        }`}
                        title={isLastAdmin ? '不能删除最后一个管理员' : '彻底删除'}
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
