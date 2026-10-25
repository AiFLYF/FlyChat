import test from 'node:test'
import assert from 'node:assert/strict'
import { prepareEnv, listen, loadApp } from './helpers/setup.js'

// 多用户必须在 import 业务模块之前打开
prepareEnv({ MULTI_USER: 'true', BREAKER_THRESHOLD: '100' })

const createApp = await loadApp()
const { initStorage } = await import('../store/db.js')
initStorage()

const server = await listen(createApp())

const call = (path, { method = 'GET', body, token, cookie } = {}) =>
  fetch(`${server.url}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })

test.after(() => server.close())

let adminCookie = ''
let aliceId = ''

test.before(async () => {
  const res = await call('/api/auth/setup', {
    method: 'POST',
    body: { username: 'root', password: 'admin-pass-123' },
  })
  assert.equal(res.status, 201, await res.clone().text())
  adminCookie = (res.headers.get('set-cookie') || '').split(';')[0]

  const created = await call('/api/users', {
    method: 'POST',
    cookie: adminCookie,
    body: { username: 'alice', password: 'alice-pass-123' },
  })
  const alice = await created.json()
  assert.equal(created.status, 201, JSON.stringify(alice))
  aliceId = alice.id
})

test('没登录不能签发令牌', async () => {
  const res = await call('/api/auth/token', { method: 'POST' })
  assert.equal(res.status, 401)
  assert.equal((await res.json()).code, 'login_required')
})

test('签发令牌：格式带 fcp_ 前缀，返回 base_url 与提示', async () => {
  const res = await call('/api/auth/token', { method: 'POST', cookie: adminCookie })
  const body = await res.json()
  assert.equal(res.status, 201, JSON.stringify(body))
  assert.match(body.token, /^fcp_[A-Za-z0-9_-]{20,}$/)
  assert.match(body.baseUrl, /\/v1$/)
  assert.match(body.hint, /只显示这一次|无法再次查看/)
})

test('Bearer 令牌能访问 /api（不需要 cookie）', async () => {
  const issued = await (await call('/api/auth/token', { method: 'POST', cookie: adminCookie })).json()

  const list = await call('/api/conversations', { token: issued.token })
  assert.equal(list.status, 200, await list.clone().text())

  const me = await (await call('/api/auth/me', { token: issued.token })).json()
  assert.equal(me.user.username, 'root')
  assert.equal(me.authVia, 'token', '应标明这次是令牌认证')
  assert.equal(me.hasApiToken, true)
})

test('Bearer 令牌能访问 /v1 —— 这是加 PAT 的主要原因', async () => {
  const issued = await (await call('/api/auth/token', { method: 'POST', cookie: adminCookie })).json()

  const models = await call('/v1/models', { token: issued.token })
  assert.equal(models.status, 200, await models.clone().text())
  const body = await models.json()
  assert.equal(body.object, 'list')

  // 没有令牌时必须还是 401，且是 OpenAI 的错误形状
  const anon = await call('/v1/models')
  assert.equal(anon.status, 401)
  const err = await anon.json()
  assert.equal(err.error.type, 'authentication_error')
})

test('伪造令牌无效', async () => {
  const res = await call('/api/conversations', { token: 'fcp_this_is_not_real_at_all' })
  assert.equal(res.status, 401)
})

test('重复签发会作废旧令牌（避免「到底哪个在泄漏」说不清）', async () => {
  const first = await (await call('/api/auth/token', { method: 'POST', cookie: adminCookie })).json()
  const second = await (await call('/api/auth/token', { method: 'POST', cookie: adminCookie })).json()
  assert.notEqual(first.token, second.token)

  assert.equal((await call('/api/conversations', { token: first.token })).status, 401, '旧令牌必须失效')
  assert.equal((await call('/api/conversations', { token: second.token })).status, 200)
})

test('吊销令牌后立即失效', async () => {
  const issued = await (await call('/api/auth/token', { method: 'POST', cookie: adminCookie })).json()
  assert.equal((await call('/api/conversations', { token: issued.token })).status, 200)

  const revoke = await call('/api/auth/token', { method: 'DELETE', cookie: adminCookie })
  assert.equal(revoke.status, 200)
  assert.equal((await call('/api/conversations', { token: issued.token })).status, 401)

  const me = await (await call('/api/auth/me', { cookie: adminCookie })).json()
  assert.equal(me.hasApiToken, false)
})

test('被禁用的用户，令牌同样失效', async () => {
  // 给 alice 签发令牌
  const login = await call('/api/auth/login', {
    method: 'POST',
    body: { username: 'alice', password: 'alice-pass-123' },
  })
  const aliceCookie = (login.headers.get('set-cookie') || '').split(';')[0]
  const issued = await (await call('/api/auth/token', { method: 'POST', cookie: aliceCookie })).json()
  assert.equal((await call('/api/conversations', { token: issued.token })).status, 200)

  await call(`/api/users/${aliceId}`, { method: 'PATCH', cookie: adminCookie, body: { disabled: true } })
  assert.equal(
    (await call('/api/conversations', { token: issued.token })).status,
    401,
    '禁用用户后令牌不能还能用'
  )

  await call(`/api/users/${aliceId}`, { method: 'PATCH', cookie: adminCookie, body: { disabled: false } })
})

test('令牌不出现在任何接口的响应里（只有明文那一次）', async () => {
  const issued = await (await call('/api/auth/token', { method: 'POST', cookie: adminCookie })).json()
  const me = await (await call('/api/auth/me', { cookie: adminCookie })).text()
  assert.ok(!me.includes(issued.token), '/api/auth/me 不能回传令牌明文')

  const users = await (await call('/api/users', { cookie: adminCookie })).text()
  assert.ok(!users.includes(issued.token), '用户列表更不能回传令牌')
})
