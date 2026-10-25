import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { prepareEnv, listen, loadApp} from './helpers/setup.js'

prepareEnv({ FLYCHAT_ACCESS_TOKEN: 'secret-token-123' })

const createApp = await loadApp()
const { initStorage } = await import('../store/db.js')

let server

before(async () => {
  initStorage()
  server = await listen(createApp())
})

after(async () => {
  await server.close()
})

test('未带令牌：业务接口返回 401', async () => {
  const res = await fetch(`${server.url}/api/providers`)
  assert.equal(res.status, 401)
  const body = await res.json()
  assert.equal(body.code, 'unauthorized')
})

test('健康检查与配置接口始终放行（探针不需要令牌）', async () => {
  assert.equal((await fetch(`${server.url}/api/health`)).status, 200)
  assert.equal((await fetch(`${server.url}/api/config`)).status, 200)
})

test('错误令牌：拒绝', async () => {
  const res = await fetch(`${server.url}/api/providers`, {
    headers: { Authorization: 'Bearer wrong-token' },
  })
  assert.equal(res.status, 401)
})

test('正确令牌：Authorization Bearer 放行', async () => {
  const res = await fetch(`${server.url}/api/providers`, {
    headers: { Authorization: 'Bearer secret-token-123' },
  })
  assert.equal(res.status, 200)
})

test('正确令牌：X-FlyChat-Token 头也能放行', async () => {
  const res = await fetch(`${server.url}/api/config`, {
    headers: { 'X-FlyChat-Token': 'secret-token-123' },
  })
  assert.equal(res.status, 200)
})

test('GET /api/config：告知前端需要鉴权', async () => {
  const body = await (await fetch(`${server.url}/api/config`)).json()
  assert.equal(body.authRequired, true)
  assert.equal(body.features.serverStorage, true)
})
