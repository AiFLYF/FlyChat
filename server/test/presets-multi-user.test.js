import test from 'node:test'
import assert from 'node:assert/strict'
import { prepareEnv, listen, loadApp } from './helpers/setup.js'

// 多用户必须在 import 业务模块之前打开
prepareEnv({ MULTI_USER: 'true', BREAKER_THRESHOLD: '100' })

const createApp = await loadApp()
const { initStorage } = await import('../store/db.js')
const { createPreset } = await import('../store/presets.js')
initStorage()
const server = await listen(createApp())

const call = (path, { method = 'GET', body, cookie, token } = {}) =>
  fetch(`${server.url}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })

const cookieOf = (res) => (res.headers.get('set-cookie') || '').split(';')[0]
const login = async (username, password) => {
  const res = await call('/api/auth/login', { method: 'POST', body: { username, password } })
  assert.equal(res.status, 200, await res.clone().text())
  return cookieOf(res)
}

test.after(() => server.close())

let adminCookie = ''
let aliceCookie = ''
let bobCookie = ''

test.before(async () => {
  const setup = await call('/api/auth/setup', {
    method: 'POST',
    body: { username: 'root', password: 'admin-pass-123' },
  })
  assert.equal(setup.status, 201, await setup.clone().text())
  adminCookie = cookieOf(setup)

  for (const name of ['alice', 'bob']) {
    const created = await call('/api/users', {
      method: 'POST',
      cookie: adminCookie,
      body: { username: name, password: `${name}-pass-123` },
    })
    assert.equal(created.status, 201, await created.clone().text())
  }
  aliceCookie = await login('alice', 'alice-pass-123')
  bobCookie = await login('bob', 'bob-pass-123')
})

async function save(cookie, preset) {
  const res = await call('/api/presets', { method: 'POST', cookie, body: preset })
  assert.equal(res.status, 201, await res.clone().text())
  return res.json()
}

async function list(cookie) {
  const res = await call('/api/presets', { cookie })
  assert.equal(res.status, 200, await res.clone().text())
  return (await res.json()).items
}

test('自定义预设按用户隔离：别人看不到、改不了、删不掉', async () => {
  const preset = await save(aliceCookie, { name: 'Alice 私有预设', systemPrompt: '只属于 alice' })
  assert.equal(preset.readonly, undefined, '自己创建的预设不应是只读')

  assert.ok((await list(aliceCookie)).some((p) => p.id === preset.id), 'alice 应看到自己的预设')
  assert.ok(!(await list(bobCookie)).some((p) => p.id === preset.id), 'bob 不应看到 alice 的预设')

  assert.equal((await call(`/api/presets/${preset.id}`, { cookie: bobCookie })).status, 404)
  assert.equal(
    (await call(`/api/presets/${preset.id}`, {
      method: 'PUT',
      cookie: bobCookie,
      body: { name: '被 bob 改了' },
    })).status,
    404
  )
  const deleted = await (await call(`/api/presets/${preset.id}`, { method: 'DELETE', cookie: bobCookie })).json()
  assert.equal(deleted.ok, false, 'bob 删除别人的预设必须失败')
  assert.equal((await call(`/api/presets/${preset.id}`, { cookie: aliceCookie })).status, 200, 'alice 的预设不能被 bob 删掉')
})

test('无主老预设是共享只读：全员可用，只有管理员能改，普通用户可克隆', async () => {
  // 模拟升级前创建的预设：没有 user_id
  const shared = createPreset({ name: '旧共享预设', systemPrompt: '老数据' })

  const aliceView = (await list(aliceCookie)).find((p) => p.id === shared.id)
  assert.ok(aliceView, '普通用户应能看到无主共享预设')
  assert.equal(aliceView.readonly, true, '普通用户看到的共享预设应标记只读')
  const adminView = (await list(adminCookie)).find((p) => p.id === shared.id)
  assert.notEqual(adminView.readonly, true, '管理员可以管理共享预设')

  const denied = await call(`/api/presets/${shared.id}`, {
    method: 'PUT',
    cookie: aliceCookie,
    body: { name: 'alice 改共享' },
  })
  assert.equal(denied.status, 403)
  assert.equal((await denied.json()).code, 'preset_readonly')
  assert.equal(
    (await (await call(`/api/presets/${shared.id}`, { method: 'DELETE', cookie: aliceCookie })).json()).ok,
    false
  )

  const dup = await (await call(`/api/presets/${shared.id}/duplicate`, {
    method: 'POST',
    cookie: aliceCookie,
  })).json()
  assert.ok(dup.id && dup.id !== shared.id, '克隆应得到新 id')
  assert.notEqual(dup.readonly, true, '克隆出来的预设归 alice，可编辑')
  assert.ok(!(await list(bobCookie)).some((p) => p.id === dup.id), '克隆件同样按用户隔离')

  const adminUpdate = await call(`/api/presets/${shared.id}`, {
    method: 'PUT',
    cookie: adminCookie,
    body: { description: '管理员维护' },
  })
  assert.equal(adminUpdate.status, 200, await adminUpdate.clone().text())
  assert.equal((await adminUpdate.json()).description, '管理员维护')
})

test('/v1 只暴露当前令牌用户的预设与共享预设', async () => {
  const alicePreset = await save(aliceCookie, { name: 'Alice /v1 预设' })
  const bobPreset = await save(bobCookie, { name: 'Bob /v1 预设' })
  const shared = createPreset({ name: '共享 /v1 预设' })

  const issued = await (await call('/api/auth/token', { method: 'POST', cookie: aliceCookie })).json()
  assert.match(issued.token, /^fcp_/, '签发 PAT 失败：' + JSON.stringify(issued))

  const res = await call('/v1/models', { token: issued.token })
  assert.equal(res.status, 200, await res.clone().text())
  const ids = (await res.json()).data.map((m) => m.id)
  assert.ok(ids.includes(`preset:${alicePreset.id}`), '应包含自己的预设')
  assert.ok(ids.includes(`preset:${shared.id}`), '应包含无主共享预设')
  assert.ok(!ids.includes(`preset:${bobPreset.id}`), '不能包含别人的预设')

  const denied = await call('/v1/chat/completions', {
    method: 'POST',
    token: issued.token,
    body: { model: `preset:${bobPreset.id}`, messages: [{ role: 'user', content: 'hi' }] },
  })
  assert.equal(denied.status, 404)
  assert.equal((await denied.json()).error.code, 'preset_not_found')
})
