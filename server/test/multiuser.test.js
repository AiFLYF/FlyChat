import test from 'node:test'
import assert from 'node:assert/strict'
import { prepareEnv, listen, loadApp } from './helpers/setup.js'

// 关键：MULTI_USER 必须在 import 业务模块之前设置（config 在模块加载时读环境变量）
prepareEnv({ MULTI_USER: 'true', BREAKER_THRESHOLD: '100' })

const createApp = await loadApp()
const { initStorage, getDb } = await import('../store/db.js')
initStorage()

const server = await listen(createApp())

/** 带 cookie 的请求助手 */
function client(cookie = '') {
  const doFetch = (path, { method = 'GET', body, headers = {} } = {}) =>
    fetch(`${server.url}${path}`, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...headers,
      },
      // 允许直接传已序列化好的字符串（个别用例需要精确控制原始 body）
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    })

  return {
    fetch: doFetch,
    json: async (path, opts) => {
      const res = await doFetch(path, opts)
      return { status: res.status, body: await res.json().catch(() => null), res }
    },
    /** 从 Set-Cookie 里只取 name=value，方便下一跳带上 */
    login: async (username, password) => {
      const res = await doFetch('/api/auth/login', { method: 'POST', body: { username, password } })
      const body = await res.json().catch(() => null)
      const raw = res.headers.get('set-cookie') || ''
      const pair = raw.split(';')[0]
      return { status: res.status, body, cookie: pair && !pair.endsWith('=') ? pair : '' }
    },
  }
}

const anon = client()
let adminCookie = ''
let aliceCookie = ''

test.after(() => server.close())

test('未登录：受保护接口 401，公开接口仍可访问', async () => {
  const conv = await anon.json('/api/conversations')
  assert.equal(conv.status, 401)
  assert.equal(conv.body.code, 'login_required')

  // 健康检查与 config 必须公开，否则前端连「该显示登录页」都判断不了
  const health = await anon.json('/api/health')
  assert.equal(health.status, 200)
  const cfg = await anon.json('/api/config')
  assert.equal(cfg.status, 200)
  assert.equal(cfg.body.authMode, 'multi')
  assert.equal(cfg.body.needsSetup, true, '还没建管理员时应该提示需要初始化')

  const me = await anon.json('/api/auth/me')
  assert.equal(me.status, 200)
  assert.equal(me.body.multiUser, true)
  assert.equal(me.body.user, null)
})

test('初始化：创建第一个管理员并自动登录', async () => {
  const res = await anon.fetch('/api/auth/setup', {
    method: 'POST',
    body: JSON.stringify({ username: 'root', password: 'admin-pass-123' }),
  })
  const body = await res.json()
  assert.equal(res.status, 201, JSON.stringify(body))
  assert.equal(body.user.role, 'admin')

  const raw = res.headers.get('set-cookie') || ''
  adminCookie = raw.split(';')[0]
  assert.match(adminCookie, /^flychat_session=.+/)
  // HttpOnly 必须带上，否则 XSS 能直接把登录态读走
  assert.match(raw, /HttpOnly/i)
  assert.match(raw, /SameSite=Lax/i)

  const asAdmin = client(adminCookie)
  const list = await asAdmin.json('/api/conversations')
  assert.equal(list.status, 200)
})

test('初始化只能做一次', async () => {
  const res = await anon.json('/api/auth/setup', {
    method: 'POST',
    body: { username: 'root2', password: 'another-pass-123' },
  })
  assert.equal(res.status, 400)
  assert.equal(res.body.code, 'already_setup')
})

test('登录：密码错不泄露账号是否存在', async () => {
  const wrongPassword = await anon.login('root', 'nope-nope-nope')
  assert.equal(wrongPassword.status, 400)
  assert.equal(wrongPassword.body.code, 'invalid_credentials')

  const noSuchUser = await anon.login('ghost', 'nope-nope-nope')
  assert.equal(noSuchUser.status, 400)
  assert.equal(noSuchUser.body.code, 'invalid_credentials', '两种失败必须长得一样')
})

test('管理员建普通用户，普通用户能登录但看不到别人的会话', async () => {
  const asAdmin = client(adminCookie)
  const created = await asAdmin.json('/api/users', {
    method: 'POST',
    body: { username: 'alice', password: 'alice-pass-123' },
  })
  assert.equal(created.status, 201, JSON.stringify(created.body))
  assert.equal(created.body.role, 'user')

  // 管理员建一个会话
  const adminConv = await asAdmin.json('/api/conversations', {
    method: 'POST',
    body: { id: 'conv-admin-1', title: '管理员的会话', messages: [{ id: 'm1', role: 'user', content: 'hi' }] },
  })
  assert.equal(adminConv.status, 201)

  const login = await anon.login('alice', 'alice-pass-123')
  assert.equal(login.status, 200, JSON.stringify(login.body))
  aliceCookie = login.cookie
  const asAlice = client(aliceCookie)

  const aliceList = await asAlice.json('/api/conversations')
  assert.equal(aliceList.status, 200)
  assert.equal(aliceList.body.items.length, 0, 'alice 不该看到管理员的会话')

  // 直接猜 id 也读不到（返回 404 而不是 403，避免探测存在性）
  const peek = await asAlice.json('/api/conversations/conv-admin-1')
  assert.equal(peek.status, 404)

  // 也不能覆盖写
  const overwrite = await asAlice.json('/api/conversations', {
    method: 'POST',
    body: { id: 'conv-admin-1', title: '篡改', messages: [] },
  })
  assert.equal(overwrite.status, 404)

  // 不能删
  const del = await asAlice.json('/api/conversations/conv-admin-1', { method: 'DELETE' })
  assert.equal(del.body.ok, false)

  // 自己的会话正常
  const own = await asAlice.json('/api/conversations', {
    method: 'POST',
    body: { id: 'conv-alice-1', title: 'alice 的会话', messages: [{ id: 'a1', role: 'user', content: 'hello' }] },
  })
  assert.equal(own.status, 201)
  const ownList = await asAlice.json('/api/conversations')
  assert.deepEqual(ownList.body.items.map((c) => c.id), ['conv-alice-1'])
})

test('普通用户不能碰用户管理', async () => {
  const asAlice = client(aliceCookie)
  assert.equal((await asAlice.json('/api/users')).status, 403)
  const create = await asAlice.json('/api/users', {
    method: 'POST',
    body: { username: 'mallory', password: 'mallory-pass-123' },
  })
  assert.equal(create.status, 403)
})

test('不能把最后一个管理员降级或删掉（否则没人能管了）', async () => {
  const asAdmin = client(adminCookie)
  const me = await asAdmin.json('/api/auth/me')
  const adminId = me.body.user.id

  const demote = await asAdmin.json(`/api/users/${adminId}`, { method: 'PATCH', body: { role: 'user' } })
  assert.equal(demote.status, 400)
  assert.equal(demote.body.code, 'last_admin')

  const remove = await asAdmin.json(`/api/users/${adminId}`, { method: 'DELETE' })
  assert.equal(remove.status, 400)
  assert.equal(remove.body.code, 'last_admin')
})

test('禁用用户后其登录态立即失效', async () => {
  const asAdmin = client(adminCookie)
  const users = await asAdmin.json('/api/users')
  const alice = users.body.items.find((u) => u.username === 'alice')

  const patch = await asAdmin.json(`/api/users/${alice.id}`, { method: 'PATCH', body: { disabled: true } })
  assert.equal(patch.status, 200)
  assert.equal(patch.body.disabled, true)

  const asAlice = client(aliceCookie)
  const res = await asAlice.json('/api/conversations')
  assert.equal(res.status, 401, '被禁用的用户不应还能用旧 cookie')

  // 也登不进来
  const login = await anon.login('alice', 'alice-pass-123')
  assert.equal(login.status, 400)

  await asAdmin.json(`/api/users/${alice.id}`, { method: 'PATCH', body: { disabled: false } })
})

test('改密码：旧会话被踢掉，新密码可用', async () => {
  const login = await anon.login('alice', 'alice-pass-123')
  const asAlice = client(login.cookie)

  const changed = await asAlice.json('/api/auth/password', {
    method: 'POST',
    body: { oldPassword: 'alice-pass-123', newPassword: 'alice-pass-456' },
  })
  assert.equal(changed.status, 200)

  const stale = await asAlice.json('/api/conversations')
  assert.equal(stale.status, 401, '改密码后旧 cookie 必须失效')

  assert.equal((await anon.login('alice', 'alice-pass-123')).status, 400)
  const relogin = await anon.login('alice', 'alice-pass-456')
  assert.equal(relogin.status, 200)
  aliceCookie = relogin.cookie
})

test('退出登录：cookie 被清掉且服务端会话已删', async () => {
  const login = await anon.login('alice', 'alice-pass-456')
  const asAlice = client(login.cookie)
  const out = await asAlice.fetch('/api/auth/logout', { method: 'POST' })
  assert.equal(out.status, 200)
  assert.match(out.headers.get('set-cookie') || '', /Max-Age=0/)

  const after = await asAlice.json('/api/conversations')
  assert.equal(after.status, 401)
})

test('伪造 cookie 无效', async () => {
  const fake = client('flychat_session=this-is-not-a-real-token')
  const res = await fake.json('/api/conversations')
  assert.equal(res.status, 401)
})

test('/v1 也要登录（第三方客户端不能绕过）', async () => {
  const res = await anon.fetch('/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({ model: 'x:y', messages: [{ role: 'user', content: 'hi' }] }),
  })
  assert.equal(res.status, 401)
  const body = await res.json()
  // /v1 的错误必须是 OpenAI 形状，SDK 才读得到
  assert.equal(typeof body.error, 'object')
  assert.equal(body.error.type, 'authentication_error')
})

test('无主会话可以被管理员认领（单用户升级上来的场景）', async () => {
  const { getDb } = await import('../store/db.js')
  const db = getDb()
  // 直接造一条没有归属的历史会话，模拟「多用户模式开启前就存在的数据」
  db.prepare(
    `INSERT INTO conversations (id, title, pinned, using_context, created_at, updated_at, user_id)
     VALUES ('conv-orphan-1', '老会话', 0, 1, ?, ?, NULL)`
  ).run(Date.now(), Date.now())

  const asAdmin = client(adminCookie)
  const before = await asAdmin.json('/api/conversations/conv-orphan-1')
  assert.equal(before.status, 404, '无主会话默认对谁都不可见（宁可看不见也不越权）')

  const claimed = await asAdmin.json('/api/conversations/claim-orphans', { method: 'POST' })
  assert.equal(claimed.status, 200)
  assert.ok(claimed.body.claimed >= 1)

  const after = await asAdmin.json('/api/conversations/conv-orphan-1')
  assert.equal(after.status, 200)
  assert.equal(after.body.title, '老会话')
})

test('密码强度：太短直接拒绝', async () => {
  const asAdmin = client(adminCookie)
  const res = await asAdmin.json('/api/users', {
    method: 'POST',
    body: { username: 'bob', password: '123' },
  })
  assert.equal(res.status, 400)
  assert.equal(res.body.code, 'weak_password')
})

test('用户名重复 / 非法字符被拒', async () => {
  const asAdmin = client(adminCookie)
  const dup = await asAdmin.json('/api/users', {
    method: 'POST',
    body: { username: 'alice', password: 'whatever-123' },
  })
  assert.equal(dup.status, 400)
  assert.equal(dup.body.code, 'username_taken')

  const bad = await asAdmin.json('/api/users', {
    method: 'POST',
    body: { username: 'a b', password: 'whatever-123' },
  })
  assert.equal(bad.status, 400)
  assert.equal(bad.body.code, 'invalid_username')
})

// ============================================================
// 多用户模式下的管理权与归属（安全回归）：
// MCP server 的 stdio 配置 = 在服务器上执行任意命令的能力，
// 自定义服务商 / 预算 / 分享管理同理，普通用户绝不能碰。
// ============================================================

let mcpServerId = ''

test('MCP 管理只允许 admin：普通用户写 403，读不受限', async () => {
  const login = await anon.login('alice', 'alice-pass-456')
  assert.equal(login.status, 200, JSON.stringify(login.body))
  const asAlice = client(login.cookie)
  aliceCookie = login.cookie

  // 写：注册 stdio server 等于 RCE，必须 403
  const create = await asAlice.json('/api/mcp/servers', {
    method: 'POST',
    body: { name: '恶意 server', transport: 'stdio', command: 'node', args: ['-e', 'process.exit(0)'] },
  })
  assert.equal(create.status, 403, JSON.stringify(create.body))

  const del = await asAlice.json('/api/mcp/servers/mcp-fake', { method: 'DELETE' })
  assert.equal(del.status, 403)

  const trust = await asAlice.json('/api/mcp/servers/mcp-fake/trust', { method: 'POST', body: { trusted: true } })
  assert.equal(trust.status, 403)

  // 读：普通用户要能看到可用工具，列表不设 admin 门
  const list = await asAlice.json('/api/mcp/servers')
  assert.equal(list.status, 200)
  assert.ok(Array.isArray(list.body.items))

  // 管理员正常创建（http 传输 + 占位地址，不会真实连接）
  const asAdmin = client(adminCookie)
  const okCreate = await asAdmin.json('/api/mcp/servers', {
    method: 'POST',
    body: { name: '测试 server', transport: 'http', baseUrl: 'http://127.0.0.1:9/mcp' },
  })
  assert.equal(okCreate.status, 201, JSON.stringify(okCreate.body))
  mcpServerId = okCreate.body.id
})

test('MCP 列表对普通用户脱敏：args / command 不返回', async () => {
  const asAdmin = client(adminCookie)
  const created = await asAdmin.json('/api/mcp/servers', {
    method: 'POST',
    body: {
      name: '带密钥的 server',
      transport: 'stdio',
      command: 'node',
      args: ['server.js', '--token=super-secret-token'],
    },
  })
  assert.equal(created.status, 201, JSON.stringify(created.body))
  const secretId = created.body.id

  // 管理员自己能看到完整命令行（要能编辑）
  const adminList = await asAdmin.json('/api/mcp/servers')
  const adminItem = adminList.body.items.find((s) => s.id === secretId)
  assert.ok(adminItem.args.join(' ').includes('super-secret-token'))

  // 普通用户能看列表，但拿不到命令行参数——token 常写在 args 里
  const asAlice = client(aliceCookie)
  const aliceList = await asAlice.json('/api/mcp/servers')
  assert.equal(aliceList.status, 200)
  const aliceItem = aliceList.body.items.find((s) => s.id === secretId)
  assert.ok(aliceItem, '普通用户仍应看到 server 存在')
  assert.equal(aliceItem.args, undefined)
  assert.equal(aliceItem.command, undefined)
  assert.ok(!JSON.stringify(aliceList.body).includes('super-secret-token'))

  await asAdmin.json(`/api/mcp/servers/${secretId}`, { method: 'DELETE' })
})

test('知识库网页入库：多用户模式拒绝内网地址', async () => {
  const asAlice = client(aliceCookie)
  const res = await asAlice.json('/api/documents', {
    method: 'POST',
    body: { url: 'http://127.0.0.1:9/internal-admin' },
  })
  assert.equal(res.status, 400, JSON.stringify(res.body))
  assert.equal(res.body.code, 'unsafe_url')

  const privateNet = await asAlice.json('/api/documents', {
    method: 'POST',
    body: { url: 'http://192.168.1.1/' },
  })
  assert.equal(privateNet.status, 400, JSON.stringify(privateNet.body))
  assert.equal(privateNet.body.code, 'unsafe_url')
})

test('自定义服务商与模型覆盖只允许 admin', async () => {
  const asAlice = client(aliceCookie)
  const create = await asAlice.json('/api/providers/custom', {
    method: 'POST',
    body: { name: '内网网关', type: 'openai-compat', baseUrl: 'http://127.0.0.1:9/v1', models: ['m'] },
  })
  assert.equal(create.status, 403, JSON.stringify(create.body))

  const del = await asAlice.json('/api/providers/custom/some-id', { method: 'DELETE' })
  assert.equal(del.status, 403)

  const override = await asAlice.json('/api/providers/openai/models', {
    method: 'PUT',
    body: { models: ['hack'] },
  })
  assert.equal(override.status, 403)
})

test('预算设置只允许 admin（预算是全实例的）', async () => {
  const asAlice = client(aliceCookie)
  const res = await asAlice.json('/api/budget', { method: 'PUT', body: { dailyUsd: 0.01, monthlyUsd: 0 } })
  assert.equal(res.status, 403, JSON.stringify(res.body))

  const asAdmin = client(adminCookie)
  const ok = await asAdmin.json('/api/budget', { method: 'PUT', body: { dailyUsd: 0, monthlyUsd: 0 } })
  assert.equal(ok.status, 200)
})

test('分享归属：不能把别人的会话做成公开链接，列表与删除按用户隔离', async () => {
  const asAlice = client(aliceCookie)
  const asAdmin = client(adminCookie)

  // alice 自己的会话 + 分享，正常成功
  const ownShare = await asAlice.json('/api/share', {
    method: 'POST',
    body: { conversationId: 'conv-alice-1' },
  })
  assert.equal(ownShare.status, 201, JSON.stringify(ownShare.body))

  // 管理员想把 alice 的会话分享出去 → 归属校验挡住（404，不泄露存在性）
  const stolen = await asAdmin.json('/api/share', {
    method: 'POST',
    body: { conversationId: 'conv-alice-1' },
  })
  assert.equal(stolen.status, 404, JSON.stringify(stolen.body))

  // 管理员分享自己的会话 → 成功
  const adminConv = await asAdmin.json('/api/conversations', {
    method: 'POST',
    body: { id: 'conv-admin-share', title: '待分享', messages: [{ id: 'sm1', role: 'user', content: 'hi' }] },
  })
  assert.equal(adminConv.status, 201)
  const adminShare = await asAdmin.json('/api/share', {
    method: 'POST',
    body: { conversationId: 'conv-admin-share' },
  })
  assert.equal(adminShare.status, 201, JSON.stringify(adminShare.body))

  // 列表隔离：alice 看不到管理员的分享
  const aliceShares = await asAlice.json('/api/shares')
  assert.equal(aliceShares.status, 200)
  assert.ok(
    aliceShares.body.items.every((s) => s.id !== adminShare.body.id),
    'alice 的分享列表里不能出现管理员的分享'
  )
  const adminShares = await asAdmin.json('/api/shares')
  assert.ok(adminShares.body.items.some((s) => s.id === adminShare.body.id))

  // 删除权限：alice 删不掉管理员的分享
  const stolenDelete = await asAlice.json(`/api/share/${adminShare.body.id}`, { method: 'DELETE' })
  assert.equal(stolenDelete.status, 404)
  const stillThere = await asAdmin.json(`/api/share/${adminShare.body.id}`)
  assert.equal(stillThere.status, 200)

  // 自己的分享自己删，正常
  const ownDelete = await asAlice.json(`/api/share/${ownShare.body.id}`, { method: 'DELETE' })
  assert.equal(ownDelete.status, 200)
})

test('MCP 配置清理：管理员删除测试 server', async () => {
  const asAdmin = client(adminCookie)
  const res = await asAdmin.json(`/api/mcp/servers/${mcpServerId}`, { method: 'DELETE' })
  assert.equal(res.status, 200)
})

test('知识库工作区按用户隔离，不能读取或删除别人的库', async () => {
  const asAdmin = client(adminCookie)
  const asAlice = client(aliceCookie)

  const adminWs = await asAdmin.json('/api/workspaces', {
    method: 'POST',
    body: { name: '管理员知识库' },
  })
  assert.equal(adminWs.status, 201, JSON.stringify(adminWs.body))
  const aliceWs = await asAlice.json('/api/workspaces', {
    method: 'POST',
    body: { name: 'alice 知识库' },
  })
  assert.equal(aliceWs.status, 201, JSON.stringify(aliceWs.body))

  const adminList = await asAdmin.json('/api/workspaces')
  const aliceList = await asAlice.json('/api/workspaces')
  assert.equal(adminList.status, 200)
  assert.equal(aliceList.status, 200)
  assert.ok(adminList.body.items.some((w) => w.id === adminWs.body.id))
  assert.ok(!adminList.body.items.some((w) => w.id === aliceWs.body.id))
  assert.ok(aliceList.body.items.some((w) => w.id === aliceWs.body.id))
  assert.ok(!aliceList.body.items.some((w) => w.id === adminWs.body.id))
  assert.match(adminList.body.defaultId, /^default-/)
  assert.notEqual(adminList.body.defaultId, aliceList.body.defaultId)

  // 直接猜别人的 workspaceId：列表、检索、删除都必须拒绝
  assert.equal(
    (await asAlice.json(`/api/documents?workspaceId=${encodeURIComponent(adminWs.body.id)}`)).status,
    404
  )
  assert.equal(
    (
      await asAlice.json('/api/retrieve', {
        method: 'POST',
        body: { workspaceId: adminWs.body.id, query: '机密' },
      })
    ).status,
    404
  )
  const crossDelete = await asAlice.json(`/api/workspaces/${adminWs.body.id}`, { method: 'DELETE' })
  assert.equal(crossDelete.status, 200)
  assert.equal(crossDelete.body.ok, false)

  const stillThere = await asAdmin.json('/api/workspaces')
  assert.ok(stillThere.body.items.some((w) => w.id === adminWs.body.id), '别人的删除不能生效')

  // 文档 id 也要按 workspace 归属校验，不能靠猜 id 读到别人的文档
  const db = getDb()
  const docId = `doc-${'a'.repeat(16)}`
  const t = Date.now()
  db.prepare(
    'INSERT INTO documents (id, workspace_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
  ).run(docId, adminWs.body.id, '管理员机密文档', t, t)
  assert.equal((await asAdmin.json(`/api/documents/${docId}`)).status, 200)
  assert.equal((await asAlice.json(`/api/documents/${docId}`)).status, 404)
  db.prepare('DELETE FROM documents WHERE id = ?').run(docId)

  // 自己的默认库仍然不可删除
  const ownDefault = await asAlice.json(`/api/workspaces/${aliceList.body.defaultId}`, {
    method: 'DELETE',
  })
  assert.equal(ownDefault.status, 400)

  await asAdmin.json(`/api/workspaces/${adminWs.body.id}`, { method: 'DELETE' })
  await asAlice.json(`/api/workspaces/${aliceWs.body.id}`, { method: 'DELETE' })
})

test('彻底删除用户：会话、文件夹、公开分享一起清理', async () => {
  const asAdmin = client(adminCookie)
  const created = await asAdmin.json('/api/users', {
    method: 'POST',
    body: { username: 'delete-me', password: 'delete-pass-123' },
  })
  assert.equal(created.status, 201, JSON.stringify(created.body))
  const userId = created.body.id

  const login = await anon.login('delete-me', 'delete-pass-123')
  assert.equal(login.status, 200, JSON.stringify(login.body))
  const asUser = client(login.cookie)

  const conv = await asUser.json('/api/conversations', {
    method: 'POST',
    body: {
      id: 'conv-delete-me',
      title: '待删除用户会话',
      messages: [{ id: 'msg-delete-me', role: 'user', content: '只属于这个用户' }],
    },
  })
  assert.equal(conv.status, 201, JSON.stringify(conv.body))

  const folder = await asUser.json('/api/folders', {
    method: 'POST',
    body: { name: '待删除文件夹' },
  })
  assert.equal(folder.status, 201, JSON.stringify(folder.body))

  const workspace = await asUser.json('/api/workspaces', {
    method: 'POST',
    body: { name: '待删除知识库' },
  })
  assert.equal(workspace.status, 201, JSON.stringify(workspace.body))

  const share = await asUser.json('/api/share', {
    method: 'POST',
    body: { conversationId: 'conv-delete-me' },
  })
  assert.equal(share.status, 201, JSON.stringify(share.body))
  assert.equal((await anon.json(`/api/share/${share.body.id}`)).status, 200)

  // 造一条该用户的用量记录，验证删除时一并清理
  const { recordUsage } = await import('../store/usage.js')
  recordUsage({ userId, provider: 'mock', model: 'm', total: 5, costUsd: 0.05 })

  const removed = await asAdmin.json(`/api/users/${userId}`, { method: 'DELETE' })
  assert.equal(removed.status, 200, JSON.stringify(removed.body))

  // 公开链接必须失效，旧登录态也不能再用
  assert.equal((await anon.json(`/api/share/${share.body.id}`)).status, 404)
  assert.equal((await anon.login('delete-me', 'delete-pass-123')).status, 400)

  // 数据库里不能留下该用户的会话/文件夹/分享/用量
  const db = getDb()
  const count = (sql, ...args) => db.prepare(sql).get(...args)?.n || 0
  assert.equal(count('SELECT COUNT(*) AS n FROM conversations WHERE user_id = ?', userId), 0)
  assert.equal(count('SELECT COUNT(*) AS n FROM folders WHERE user_id = ?', userId), 0)
  assert.equal(count('SELECT COUNT(*) AS n FROM shares WHERE user_id = ?', userId), 0)
  assert.equal(count('SELECT COUNT(*) AS n FROM workspaces WHERE user_id = ?', userId), 0)
  assert.equal(count('SELECT COUNT(*) AS n FROM usage_events WHERE user_id = ?', userId), 0)
})

test('用量统计按用户隔离：普通用户看不到别人的花费', async () => {
  const { recordUsage } = await import('../store/usage.js')
  const db = getDb()
  const alice = db.prepare('SELECT id FROM users WHERE username = ?').get('alice')
  const root = db.prepare('SELECT id FROM users WHERE username = ?').get('root')
  assert.ok(alice?.id && root?.id, '测试账号应存在')

  recordUsage({ userId: alice.id, provider: 'mock', model: 'm', total: 11, costUsd: 0.11 })
  recordUsage({ userId: root.id, provider: 'mock', model: 'm', total: 99, costUsd: 0.99 })

  const asAlice = client(aliceCookie)
  const mine = await asAlice.json('/api/usage?days=0')
  assert.equal(mine.status, 200)
  assert.equal(mine.body.totals.totalTokens, 11, '只应统计自己的 token')
  assert.equal(mine.body.totals.costUsd, 0.11)

  const recent = await asAlice.json('/api/usage/recent?limit=10')
  assert.ok(recent.body.items.every((it) => it.total === 11), '明细里也不能出现别人的记录')
})
