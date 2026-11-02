import assert from 'node:assert/strict'
import { chromium } from '../lib/playwright.mjs'

const base = process.env.BASE || 'http://127.0.0.1:5180'
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--no-proxy-server'] })
const errors = []
let passed = 0
const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
async function test(name, fn) {
  const context = await browser.newContext()
  const page = await context.newPage()
  await page.addInitScript(() => {
    window.testModule = (modulePath) => {
      const loaded = performance.getEntriesByType('resource').find((entry) => new URL(entry.name).pathname === modulePath)
      return import(loaded?.name || modulePath)
    }
  })
  page.on('pageerror', (err) => errors.push(err.message))
  try {
    await fn(page)
    passed += 1
    console.log(`PASS ${name}`)
  } catch (err) {
    console.error(await page.locator('body').innerText())
    console.error(await page.evaluate(async () => {
      const { useAuthStore } = await window.testModule('/src/store/auth.ts')
      const { useChatStore } = await window.testModule('/src/store/chat.ts')
      const { config, user, loading, modalOpen, error } = useAuthStore.getState()
      return { config, user, loading, modalOpen, error, hydrated: useChatStore.getState().hydrated }
    }))
    throw err
  } finally {
    await context.close()
  }
}
async function openApp(page) {
  await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await page.locator('textarea').first().waitFor({ timeout: 120000 })
}

try {
  await test('图片撤销、并发写入和账号附件命名空间', async (page) => {
    await openApp(page)
    const result = await page.evaluate(async () => {
      const { idbStorage } = await window.testModule('/src/lib/db.ts')
      const a = 'flychat-test-storage-a'
      const b = 'flychat-test-storage-b'
      const state = (url) => JSON.stringify({ state: { conversations: [{ id: 'c', messages: [{ attachments: [{ id: 'same-id', type: 'image', dataUrl: url }] }] }] } })
      const read = async (name) => JSON.parse(await idbStorage.getItem(name)).state.conversations[0].messages[0].attachments[0].dataUrl
      await idbStorage.setItem(a, state('data:image/png;base64,QQ=='))
      await idbStorage.setItem(a, JSON.stringify({ state: { conversations: [] } }))
      await idbStorage.setItem(a, state('data:image/png;base64,QQ=='))
      const restored = await read(a)
      await idbStorage.setItem(b, state('data:image/png;base64,Qg=='))
      const isolated = [await read(a), await read(b)]
      await Promise.all([
        idbStorage.setItem(a, JSON.stringify({ state: { conversations: [] }, revision: 1 })),
        idbStorage.setItem(a, state('data:image/png;base64,QQ==')),
      ])
      const newest = await read(a)
      await idbStorage.removeItem(a)
      const untouched = await read(b)
      await idbStorage.removeItem(b)
      const fallbackName = 'flychat-test-storage-fallback'
      await idbStorage.setItem(fallbackName, JSON.stringify({ revision: 1 }))
      const put = IDBObjectStore.prototype.put
      try {
        IDBObjectStore.prototype.put = function (value, key) {
          if (key === fallbackName) throw new DOMException('测试写入失败', 'QuotaExceededError')
          return put.call(this, value, key)
        }
        await idbStorage.setItem(fallbackName, JSON.stringify({ revision: 2 }))
      } finally {
        IDBObjectStore.prototype.put = put
      }
      const fallbackRevision = JSON.parse(await idbStorage.getItem(fallbackName)).revision
      await idbStorage.setItem(fallbackName, JSON.stringify({ revision: 3 }))
      const finalRevision = JSON.parse(await idbStorage.getItem(fallbackName)).revision
      const fallbackCleared = localStorage.getItem(fallbackName) === null
      localStorage.setItem(fallbackName, JSON.stringify({ revision: 1 }))
      const legacyConflictRevision = JSON.parse(await idbStorage.getItem(fallbackName)).revision
      const legacyPreserved = JSON.parse(localStorage.getItem(fallbackName)).revision === 1
      await idbStorage.removeItem(fallbackName)
      return { restored, isolated, newest, untouched, fallbackRevision, finalRevision, fallbackCleared, legacyConflictRevision, legacyPreserved }
    })
    assert.equal(result.restored, 'data:image/png;base64,QQ==')
    assert.deepEqual(result.isolated, ['data:image/png;base64,QQ==', 'data:image/png;base64,Qg=='])
    assert.equal(result.newest, result.restored)
    assert.equal(result.untouched, 'data:image/png;base64,Qg==')
    assert.equal(result.fallbackRevision, 2)
    assert.equal(result.finalRevision, 3)
    assert.equal(result.fallbackCleared, true)
    assert.equal(result.legacyConflictRevision, 3)
    assert.equal(result.legacyPreserved, true)
  })

  await test('切换账号不混用会话、草稿，刷新后按身份恢复', async (page) => {
    let user = { id: 'test-user-a', username: 'account-a', role: 'user' }
    await page.route('**/api/config', (route) => json(route, { authMode: 'multi', needsSetup: false, authRequired: true }))
    await page.route('**/api/auth/me', (route) => json(route, { multiUser: true, user }))
    await page.route('**/api/auth/logout', (route) => { user = null; return json(route, { ok: true }) })
    await page.route('**/api/auth/login', (route) => {
      const username = route.request().postDataJSON().username
      user = { id: username === 'account-a' ? 'test-user-a' : 'test-user-b', username, role: 'user' }
      return json(route, { ok: true, user })
    })
    await openApp(page)
    await page.evaluate(async () => {
      const { useChatStore } = await window.testModule('/src/store/chat.ts')
      const { useComposer } = await window.testModule('/src/store/composer.ts')
      const { flushPersist } = await window.testModule('/src/lib/db.ts')
      const id = useChatStore.getState().createConversation()
      useChatStore.getState().renameConversation(id, '账户 A 私有标记')
      useComposer.getState().setText('账户 A 未发送草稿')
      await flushPersist()
      const { useAuthStore } = await window.testModule('/src/store/auth.ts')
      await useAuthStore.getState().logout()
    })
    await page.getByRole('dialog', { name: '账户登录' }).waitFor()
    assert.equal(await page.getByText('账户 A 私有标记', { exact: true }).count(), 0)
    await page.getByLabel('用户名', { exact: true }).fill('account-b')
    await page.getByLabel('密码', { exact: true }).fill('browser-test-only')
    await page.getByRole('button', { name: '立即登录', exact: true }).click()
    await page.locator('textarea').first().waitFor()
    assert.equal(await page.locator('textarea').first().inputValue(), '')
    assert.equal(await page.getByText('账户 A 私有标记', { exact: true }).count(), 0)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.locator('textarea').first().waitFor()
    assert.equal(await page.getByText('账户 A 私有标记', { exact: true }).count(), 0)
    await page.evaluate(async () => { const { useAuthStore } = await window.testModule('/src/store/auth.ts'); await useAuthStore.getState().logout() })
    await page.getByLabel('用户名', { exact: true }).fill('account-a')
    await page.getByLabel('密码', { exact: true }).fill('browser-test-only')
    await page.getByRole('button', { name: '立即登录', exact: true }).click()
    await page.getByText('账户 A 私有标记', { exact: true }).first().waitFor()
    const key = await page.evaluate(async () => (await window.testModule('/src/store/chat.ts')).useChatStore.persist.getOptions().name)
    assert.equal(key, 'flychat-user-test-user-a')
  })

  await test('过期会话与快速重登按顺序切换持久化身份', async (page) => {
    const user = { id: 'test-fast-login', username: 'fast-login', role: 'user' }
    await page.route('**/api/config', (route) => json(route, { authMode: 'multi', needsSetup: false, authRequired: true }))
    await page.route('**/api/auth/me', (route) => json(route, { multiUser: true, user }))
    await page.route('**/api/auth/login', (route) => json(route, { ok: true, user }))
    await openApp(page)
    const result = await page.evaluate(async () => {
      const auth = (await window.testModule('/src/store/auth.ts')).useAuthStore
      const chat = (await window.testModule('/src/store/chat.ts')).useChatStore
      await Promise.all([auth.getState().setUser(null), auth.getState().login('fast-login', 'browser-test-only')])
      const id = chat.getState().createConversation()
      chat.getState().renameConversation(id, '快速重登持久化标记')
      await (await window.testModule('/src/lib/db.ts')).flushPersist()
      return { key: chat.persist.getOptions().name, user: auth.getState().user.id, loading: auth.getState().loading }
    })
    assert.deepEqual(result, { key: 'flychat-user-test-fast-login', user: 'test-fast-login', loading: false })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.getByText('快速重登持久化标记', { exact: true }).first().waitFor()
  })

  await test('生成访问令牌后的鉴权刷新保留一次性令牌', async (page) => {
    const user = { id: 'test-token-user', username: 'token-user', role: 'user', hasApiToken: false }
    await page.route('**/api/config', (route) => json(route, { authMode: 'multi', needsSetup: false, authRequired: true }))
    await page.route('**/api/auth/me', (route) => json(route, { multiUser: true, user }))
    await page.route('**/api/auth/token', (route) => {
      user.hasApiToken = true
      return json(route, { ok: true, token: 'test-only-not-a-real-token', hint: 'test', baseUrl: `${base}/v1` })
    })
    await openApp(page)
    await page.evaluate(async () => (await window.testModule('/src/components/openPanels.ts')).useSettingsOpen.getState().setOpen(true))
    await page.getByRole('tab', { name: 'API 网关', exact: true }).click()
    await page.getByRole('button', { name: '生成访问令牌', exact: true }).click()
    await page.getByRole('button', { name: '重新生成', exact: true }).waitFor()
    await page.getByText('test-only-not-a-real-token', { exact: true }).waitFor()
    assert.equal(await page.getByText('令牌已生成（关闭后无法再次查看，请立即保存）', { exact: true }).count(), 1)
  })

  await test('知识库切换丢弃旧响应，删除后停止轮询', async (page) => {
    await openApp(page)
    let releaseA
    const slowA = new Promise((resolve) => { releaseA = resolve })
    let aStarted
    const requestedA = new Promise((resolve) => { aStarted = resolve })
    await page.route('**/api/documents?*', async (route) => {
      const workspaceId = new URL(route.request().url()).searchParams.get('workspaceId')
      if (workspaceId === 'a') { aStarted(); await slowA }
      return json(route, { items: [{ id: `doc-${workspaceId}`, workspaceId, name: `文档 ${workspaceId}`, status: 'ready' }] })
    })
    await page.evaluate(async () => { (await window.testModule('/src/store/knowledge.ts')).useKnowledgeStore.getState().setActiveWorkspaceId('a') })
    await requestedA
    await page.evaluate(async () => { (await window.testModule('/src/store/knowledge.ts')).useKnowledgeStore.getState().setActiveWorkspaceId('b') })
    await page.waitForFunction(async () => (await window.testModule('/src/store/knowledge.ts')).useKnowledgeStore.getState().documents[0]?.id === 'doc-b')
    releaseA()
    await page.waitForResponse((res) => res.url().includes('workspaceId=a'))
    await page.evaluate(() => new Promise(requestAnimationFrame))
    const ids = await page.evaluate(async () => (await window.testModule('/src/store/knowledge.ts')).useKnowledgeStore.getState().documents.map((doc) => doc.id))
    assert.deepEqual(ids, ['doc-b'])
    let polls = 0
    await page.route('**/api/documents/doc-pending', (route) => {
      if (route.request().method() === 'DELETE') return json(route, { ok: true })
      polls += 1
      return json(route, { id: 'doc-pending', workspaceId: 'b', name: '待处理', status: 'processing' })
    })
    await page.route('**/api/documents', (route) => json(route, { id: 'doc-pending', status: 'pending' }))
    await page.evaluate(async () => {
      const store = (await window.testModule('/src/store/knowledge.ts')).useKnowledgeStore
      await store.getState().upload({ text: '本地轮询测试' })
      await store.getState().removeDocument('doc-pending')
    })
    await page.waitForTimeout(1800)
    assert.equal(polls, 0)
  })

  await test('旧工作区删除完成不作废新工作区的在途列表', async (page) => {
    await openApp(page)
    let releaseDelete, deleteStarted, releaseList, listStarted
    const deleteGate = new Promise((resolve) => { releaseDelete = resolve })
    const deleting = new Promise((resolve) => { deleteStarted = resolve })
    const listGate = new Promise((resolve) => { releaseList = resolve })
    const listing = new Promise((resolve) => { listStarted = resolve })
    await page.route('**/api/documents/doc-a', async (route) => {
      deleteStarted()
      await deleteGate
      return json(route, { ok: true })
    })
    await page.route('**/api/documents?*', async (route) => {
      listStarted()
      await listGate
      return json(route, { items: [{ id: 'doc-b', workspaceId: 'b', name: '文档 B', status: 'ready' }] })
    })
    await page.evaluate(async () => {
      const store = (await window.testModule('/src/store/knowledge.ts')).useKnowledgeStore
      store.setState({ activeWorkspaceId: 'a', documents: [{ id: 'doc-a', workspaceId: 'a', status: 'ready' }] })
      window.pendingDelete = store.getState().removeDocument('doc-a')
    })
    await deleting
    await page.evaluate(async () => (await window.testModule('/src/store/knowledge.ts')).useKnowledgeStore.getState().setActiveWorkspaceId('b'))
    await listing
    releaseDelete()
    await page.evaluate(() => window.pendingDelete)
    releaseList()
    await page.waitForFunction(async () => (await window.testModule('/src/store/knowledge.ts')).useKnowledgeStore.getState().documents[0]?.id === 'doc-b')
  })

  await test('身份重置后忽略旧预设列表和保存响应', async (page) => {
    await openApp(page)
    let release, allStarted, started = 0
    const gate = new Promise((resolve) => { release = resolve })
    const requests = new Promise((resolve) => { allStarted = resolve })
    await page.route('**/api/presets', async (route) => {
      if (++started === 2) allStarted()
      await gate
      const preset = { id: 'old-account-preset', name: '旧账号预设' }
      return json(route, route.request().method() === 'GET' ? { items: [preset] } : preset)
    })
    await page.evaluate(async () => {
      const store = (await window.testModule('/src/store/preset.ts')).usePresetStore
      window.pendingPresets = Promise.all([store.getState().fetchPresets(), store.getState().savePreset({ name: '旧账号预设' })])
    })
    await requests
    await page.evaluate(async () => {
      const store = (await window.testModule('/src/store/preset.ts')).usePresetStore
      store.getState().reset()
      store.setState({ presets: [{ id: 'new-account-preset', name: '新账号预设' }] })
    })
    release()
    await page.evaluate(() => window.pendingPresets)
    const ids = await page.evaluate(async () => (await window.testModule('/src/store/preset.ts')).usePresetStore.getState().presets.map((preset) => preset.id))
    assert.deepEqual(ids, ['new-account-preset'])
  })

  await test('切换 / 新建会话不会清空全局系统提示词', async (page) => {
    await openApp(page)
    const result = await page.evaluate(async () => {
      const { useChatStore } = await window.testModule('/src/store/chat.ts')
      const store = () => useChatStore.getState()
      store().updateSettings({ systemPrompt: '全局默认指令' })
      const first = store().createConversation()
      const afterCreate = store().settings.systemPrompt
      const second = store().createConversation()
      store().setActive(first)
      const afterSwitch = store().settings.systemPrompt
      store().setConversationSystemPrompt(first, '会话专属指令')
      const afterConvPrompt = store().settings.systemPrompt
      const convPrompt = store().conversations.find((c) => c.id === first)?.systemPrompt
      store().deleteConversation(first)
      store().deleteConversation(second)
      store().updateSettings({ systemPrompt: '' })
      return { afterCreate, afterSwitch, afterConvPrompt, convPrompt }
    })
    assert.equal(result.afterCreate, '全局默认指令', '新建会话不能清空全局提示词')
    assert.equal(result.afterSwitch, '全局默认指令', '切换会话不能清空全局提示词')
    assert.equal(result.afterConvPrompt, '全局默认指令', '写会话级提示词不能覆盖全局提示词')
    assert.equal(result.convPrompt, '会话专属指令', '会话级提示词应独立保存')
  })

  await test('会话同步失败自动重试且只发最新快照，4xx 不重试', async (page) => {
    const calls = []
    await page.route('**/api/conversations', async (route) => {
      if (route.request().method() !== 'POST') return route.continue()
      let body = {}
      try {
        body = route.request().postDataJSON() || {}
      } catch {
        body = {}
      }
      calls.push({ id: body.id, title: body.title })
      if (body.id === 'sync-retry-ok') {
        const attempt = calls.filter((c) => c.id === 'sync-retry-ok').length
        return attempt === 1 ? json(route, { error: 'temporary' }, 500) : json(route, { ok: true })
      }
      return json(route, { error: 'bad request' }, 400)
    })
    await openApp(page)
    await page.evaluate(async () => {
      const { queueConversationSync } = await window.testModule('/src/lib/serverSync.ts')
      const base = { messages: [], createdAt: 1, updatedAt: 1 }
      queueConversationSync({ ...base, id: 'sync-retry-ok', title: '第一版' })
      queueConversationSync({ ...base, id: 'sync-retry-ok', title: '第二版', updatedAt: 2 })
      queueConversationSync({ ...base, id: 'sync-retry-denied', title: '不该重试' })
    })
    await page.waitForTimeout(4000)
    const okCalls = calls.filter((c) => c.id === 'sync-retry-ok')
    const deniedCalls = calls.filter((c) => c.id === 'sync-retry-denied')
    assert.equal(okCalls.length, 2, '5xx 应自动重试一次')
    assert.equal(okCalls[1].title, '第二版', '重试必须携带最新快照，不能把旧内容盖回去')
    assert.equal(deniedCalls.length, 1, '4xx 属于终态错误，不应重试')
  })

  await test('刷新后自动补发未同步会话，成功后清空待办', async (page) => {
    const calls = []
    const waiters = new Set()
    let failing = true
    let generation = 0
    const notify = () => {
      for (const check of [...waiters]) check()
    }
    const waitFor = (predicate, label) => new Promise((resolve, reject) => {
      let timer = null
      const check = () => {
        if (!predicate()) return
        clearTimeout(timer)
        waiters.delete(check)
        resolve()
      }
      timer = setTimeout(() => {
        waiters.delete(check)
        reject(new Error(`等待超时：${label}`))
      }, 10000)
      waiters.add(check)
      check()
    })
    await page.route('**/api/conversations', (route) => {
      if (route.request().method() !== 'POST') return route.continue()
      let body = {}
      try {
        body = route.request().postDataJSON() || {}
      } catch {
        body = {}
      }
      calls.push({ id: body.id, title: body.title, generation, rejected: failing })
      notify()
      return failing ? json(route, { error: 'temporary' }, 500) : json(route, { ok: true })
    })
    await openApp(page)
    const convId = await page.evaluate(async () => {
      const { useChatStore } = await window.testModule('/src/store/chat.ts')
      const { flushPersist } = await window.testModule('/src/lib/db.ts')
      const id = useChatStore.getState().createConversation()
      useChatStore.getState().renameConversation(id, '跨刷新待同步')
      await flushPersist()
      return id
    })
    await page.evaluate(async (id) => {
      const { queueConversationSync } = await window.testModule('/src/lib/serverSync.ts')
      const { useChatStore } = await window.testModule('/src/store/chat.ts')
      const conv = useChatStore.getState().conversations.find((c) => c.id === id)
      queueConversationSync(conv)
    }, convId)
    await waitFor(() => calls.some((c) => c.generation === 0 && c.id === convId), '首次同步请求')
    const pendingBefore = await page.evaluate(() => JSON.parse(localStorage.getItem('flychat-pending-sync:flychat-store') || 'null'))
    assert.ok(pendingBefore?.conversations?.includes(convId), '失败后待同步 id 必须落盘，刷新才能补发')

    generation = 1
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.locator('textarea').first().waitFor({ timeout: 120000 })
    await waitFor(() => calls.some((c) => c.generation === 1 && c.id === convId), '刷新后自动补发')
    const resumed = calls.find((c) => c.generation === 1 && c.id === convId)
    assert.equal(resumed.title, '跨刷新待同步', '补发必须携带本地恢复的最新快照')
    assert.equal(resumed.rejected, true, '刷新后应重新发起同步，而不是只把 id 留在存储里')

    failing = false
    await page.evaluate(async () => (await window.testModule('/src/lib/serverSync.ts')).flushAll())
    await waitFor(() => calls.some((c) => c.generation === 1 && c.id === convId && !c.rejected), '恢复后补发成功')
    const latest = calls.filter((c) => c.generation === 1 && c.id === convId).at(-1)
    assert.equal(latest.title, '跨刷新待同步')
    await page.waitForFunction((id) => {
      const pending = JSON.parse(localStorage.getItem('flychat-pending-sync:flychat-store') || 'null')
      return !pending || !(pending.conversations || []).includes(id)
    }, convId)
  })

  await test('清空全部会话会取消待同步任务，在途同步不会把会话写回服务端', async (page) => {
    const posts = []
    let deletes = 0
    let releasePost
    let postStarted
    const postGate = new Promise((resolve) => { releasePost = resolve })
    const postSeen = new Promise((resolve) => { postStarted = resolve })
    await page.route('**/api/conversations', async (route) => {
      const method = route.request().method()
      if (method === 'DELETE') {
        deletes += 1
        return json(route, { ok: true, deleted: 0 })
      }
      if (method !== 'POST') return route.continue()
      let body = {}
      try {
        body = route.request().postDataJSON() || {}
      } catch {
        body = {}
      }
      posts.push({ id: body.id, title: body.title })
      postStarted()
      // 卡住这一次同步，模拟「请求已经发出但还没回来」时用户点了清空
      await postGate
      return json(route, { error: 'temporary' }, 500)
    })
    await openApp(page)
    const convId = await page.evaluate(async () => {
      const { useChatStore } = await window.testModule('/src/store/chat.ts')
      const { flushPersist } = await window.testModule('/src/lib/db.ts')
      const id = useChatStore.getState().createConversation()
      useChatStore.getState().renameConversation(id, '清空前待同步')
      await flushPersist()
      return id
    })
    await page.evaluate(async (id) => {
      const { queueConversationSync } = await window.testModule('/src/lib/serverSync.ts')
      const { useChatStore } = await window.testModule('/src/store/chat.ts')
      queueConversationSync(useChatStore.getState().conversations.find((c) => c.id === id))
    }, convId)
    await postSeen
    const pendingBefore = await page.evaluate(() => JSON.parse(localStorage.getItem('flychat-pending-sync:flychat-store') || 'null'))
    assert.ok(pendingBefore?.conversations?.includes(convId), '清空前待办应已落盘')

    await page.evaluate(async () => {
      ;(await window.testModule('/src/store/chat.ts')).useChatStore.getState().clearAll()
    })
    await page.waitForTimeout(600)
    assert.equal(deletes, 0, '在途同步没落地就清服务端，删除会被后到的同步覆盖')

    releasePost()
    await page.waitForResponse((res) => res.url().includes('/api/conversations') && res.request().method() === 'DELETE')
    assert.equal(deletes, 1, '在途同步结束后必须清一次服务端会话')
    const pendingAfter = await page.evaluate(() => JSON.parse(localStorage.getItem('flychat-pending-sync:flychat-store') || 'null'))
    assert.ok(!(pendingAfter?.conversations || []).includes(convId), '清空后必须移除待同步 id')
    assert.deepEqual(pendingAfter?.deletes || [], [], '清空后不应残留排队中的删除任务')

    // 恢复网络后也不能把刚清掉的会话重新上传
    await page.evaluate(async () => (await window.testModule('/src/lib/serverSync.ts')).flushAll())
    await page.waitForTimeout(2500)
    assert.equal(posts.filter((p) => p.id === convId).length, 1, '清空后旧任务不能再把会话写回服务端')
  })

  await test('删除后立即撤销：等在途删除落地再重新同步，服务端最终保留会话', async (page) => {
    const events = []
    let releaseDelete
    const deleteGate = new Promise((resolve) => { releaseDelete = resolve })
    await page.route('**/api/conversations/*', async (route) => {
      if (route.request().method() !== 'DELETE') return route.continue()
      events.push('delete-start')
      await deleteGate
      events.push('delete-done')
      return json(route, { ok: true })
    })
    await page.route('**/api/conversations', (route) => {
      if (route.request().method() !== 'POST') return route.continue()
      let body = {}
      try {
        body = route.request().postDataJSON() || {}
      } catch {
        body = {}
      }
      events.push(`post:${body.id}`)
      return json(route, { ok: true })
    })
    await openApp(page)
    const convId = await page.evaluate(async () => {
      const { useChatStore } = await window.testModule('/src/store/chat.ts')
      const { flushPersist } = await window.testModule('/src/lib/db.ts')
      const store = () => useChatStore.getState()
      const id = store().createConversation()
      store().renameConversation(id, '撤销后仍要保留')
      await flushPersist()
      const conv = store().conversations.find((c) => c.id === id)
      store().deleteConversation(id)
      store().restoreConversation(conv)
      return id
    })
    await page.waitForTimeout(400)
    assert.ok(events.includes('delete-start'), '删除请求应已发出')
    assert.equal(events.some((e) => e.startsWith('post:')), false, '在途删除结束前不能上传，否则会被后到的 DELETE 删掉')

    releaseDelete()
    await page.waitForResponse((res) => res.request().method() === 'POST' && res.url().endsWith('/api/conversations'))
    assert.deepEqual(
      events.filter((e) => e === 'delete-done' || e.startsWith('post:')),
      ['delete-done', `post:${convId}`],
      '必须先删除完成再重新上传'
    )
    const local = await page.evaluate(async (id) => {
      const { useChatStore } = await window.testModule('/src/store/chat.ts')
      return useChatStore.getState().conversations.some((c) => c.id === id)
    }, convId)
    assert.equal(local, true, '撤销后本地应保留会话')
  })

  await test('分享错误密码提示、网络失败保表单、过期错误和恢复', async (page) => {
    let expired = false
    let down = false
    await page.route('**/api/share/test-share', (route) => {
      if (down) return route.abort('failed')
      if (expired) return json(route, { error: '分享已过期', code: 'share_expired' }, 410)
      if (route.request().headers()['x-share-password'] !== 'correct-value') {
        return json(route, { error: '分享需要密码', code: 'share_password_required' }, 401)
      }
      return json(route, { id: 'test-share', title: '测试分享已解锁', messages: [], messageCount: 0, createdAt: Date.now(), views: 1 })
    })
    await page.goto(`${base}/s/test-share`, { waitUntil: 'domcontentloaded' })
    await page.getByLabel('分享密码').fill('wrong-value')
    await page.getByRole('button', { name: '验证并查看' }).click()
    await page.getByRole('alert').filter({ hasText: '密码错误' }).waitFor()
    await page.getByLabel('分享密码').fill('correct-value')
    await page.getByRole('button', { name: '验证并查看' }).click()
    await page.getByRole('heading', { name: '测试分享已解锁' }).waitFor()

    // 网络中断属于可重试错误：密码框和已输入内容必须保留，恢复后再点一次就能进
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.getByLabel('分享密码').waitFor()
    down = true
    await page.getByLabel('分享密码').fill('correct-value')
    await page.getByRole('button', { name: '验证并查看' }).click()
    await page.getByRole('alert').waitFor()
    await page.getByLabel('分享密码').waitFor()
    down = false
    await page.getByRole('button', { name: '验证并查看' }).click()
    await page.getByRole('heading', { name: '测试分享已解锁' }).waitFor()

    // 410 是终态：重试无意义，密码框收起，错误卡给出结论
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.getByLabel('分享密码').waitFor()
    expired = true
    await page.getByLabel('分享密码').fill('correct-value')
    await page.getByRole('button', { name: '验证并查看' }).click()
    await page.getByText('该分享链接已过期', { exact: true }).waitFor()
    assert.equal(await page.getByLabel('分享密码').count(), 0)
  })

  assert.deepEqual(errors, [])
  console.log(`状态回归 ${passed}/13 通过；浏览器未捕获异常 0`)
} finally {
  await browser.close()
}
