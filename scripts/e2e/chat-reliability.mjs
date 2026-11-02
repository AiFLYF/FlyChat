import assert from 'node:assert/strict'
import { chromium } from '../lib/playwright.mjs'

const base = process.env.BASE || 'http://127.0.0.1:5180'
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--no-proxy-server'] })
const errors = []
let passed = 0
const json = (route, body) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) })
const sse = (route, events) => route.fulfill({ contentType: 'text/event-stream', body: events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') })

async function test(name, fn) {
  const context = await browser.newContext()
  const page = await context.newPage()
  page.setDefaultTimeout(30000)
  page.on('pageerror', (err) => errors.push(err.message))
  await page.addInitScript(() => {
    window.testModule = (path) => {
      const resource = performance.getEntriesByType('resource').find((entry) => new URL(entry.name).pathname === path)
      return import(resource?.name || path)
    }
  })
  await page.route('**/api/providers', (route) => json(route, {
    providers: [{ id: 'test-provider', name: '测试模型', type: 'openai-compat', models: ['test-model'] }], webSearch: false,
  }))
  await page.route('**/api/tasks/suggest', (route) => json(route, { suggestions: [] }))
  await page.route('**/api/tasks/title', (route) => json(route, { title: '测试标题' }))
  await page.route('**/api/conversations', (route) => json(route, { ok: true, items: [] }))
  try {
    await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 120000 })
    await page.locator('textarea').first().waitFor({ timeout: 120000 })
    await page.waitForFunction(() => document.querySelector('textarea')?.disabled === false)
    await fn(page)
    passed += 1
    console.log(`PASS ${name}`)
  } catch (err) {
    console.error(await page.locator('body').innerText())
    throw err
  } finally {
    await context.close()
  }
}

async function lastStatus(page, status) {
  await page.waitForFunction(async (wanted) => {
    const store = (await window.testModule('/src/store/chat.ts')).useChatStore.getState()
    return store.conversations.find((c) => c.id === store.activeId)?.messages.at(-1)?.status === wanted
  }, status)
}

async function pendingChat(page) {
  await page.evaluate(() => {
    const original = window.fetch
    window.fetch = async (url, options) => {
      if (url !== '/api/chat') return original(url, options)
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"type":"delta","content":"已收到的部分内容"}\n\n'))
          options.signal.addEventListener('abort', () => controller.error(new DOMException('cancelled', 'AbortError')), { once: true })
        },
      }), { headers: { 'Content-Type': 'text/event-stream' } })
    }
  })
}

try {
  await test('SSE 完成标记、末行、UTF-8 分块与异常传播', async (page) => {
    const results = await page.evaluate(async () => {
      const { streamChat } = await window.testModule('/src/api/client.ts')
      const { useChatStore } = await window.testModule('/src/store/chat.ts')
      const original = window.fetch
      const run = async (events, { open = false, throws = false, bytes = false } = {}) => {
        let text = '', error = '', cancelled = false
        window.fetch = async () => new Response(new ReadableStream({
          start(controller) {
            const data = new TextEncoder().encode(events)
            if (bytes) for (const byte of data) controller.enqueue(new Uint8Array([byte]))
            else controller.enqueue(data)
            if (!open) controller.close()
          },
          cancel() { cancelled = true },
        }))
        const abort = new AbortController()
        const timer = setTimeout(() => abort.abort(), 3000)
        try {
          await streamChat({
            settings: useChatStore.getState().settings,
            messages: [{ role: 'user', content: 'test' }],
            onDelta: (chunk) => { if (throws) throw new Error('callback-sentinel'); text += chunk },
          }, abort.signal)
        } catch (err) {
          error = err.message
        } finally {
          clearTimeout(timer)
        }
        return { text, error, cancelled }
      }
      try {
        return {
          unicode: await run('data: {"type":"delta","content":"你好"}\n\ndata: {"type":"done"}', { bytes: true }),
          terminal: await run('data: {"type":"delta","content":"完成"}\n\ndata: {"type":"done"}\n\ndata: {"type":"delta","content":"多余"}\n\n', { open: true }),
          eof: await run('data: {"type":"delta","content":"保留末行"}'),
          callback: await run('data: {"type":"delta","content":"x"}\n\n', { throws: true }),
          server: await run('data: {"type":"error","message":"上游不可用"}\n\n'),
        }
      } finally {
        window.fetch = original
      }
    })
    assert.equal(results.unicode.text, '你好')
    assert.equal(results.unicode.error, '')
    assert.equal(results.terminal.text, '完成')
    assert.equal(results.terminal.cancelled, true)
    assert.equal(results.terminal.error, '')
    assert.equal(results.eof.text, '保留末行')
    assert.match(results.eof.error, /未收到完成标记/)
    assert.equal(results.callback.error, 'callback-sentinel')
    assert.equal(results.server.error, '上游不可用')
  })

  await test('未收到 done 的界面保留正文并标记失败，不生成标题', async (page) => {
    let titles = 0
    page.on('request', (request) => { if (/\/api\/(tasks\/)?title$/.test(request.url())) titles += 1 })
    await page.route('**/api/chat', (route) => sse(route, [{ type: 'delta', content: '保留这段答案' }]))
    await page.locator('textarea').first().fill('测试断流')
    await page.locator('textarea').first().press('Enter')
    await lastStatus(page, 'error')
    await page.getByText(/生成中断：响应流意外中断/).waitFor()
    assert.ok((await page.locator('body').innerText()).includes('保留这段答案'))
    assert.equal(titles, 0)
  })

  await test('并发附件全部解析完才允许 Enter 发送', async (page) => {
    const releases = new Map()
    const started = Promise.withResolvers()
    let sent
    await page.route('**/api/extract', async (route) => {
      const { name } = route.request().postDataJSON()
      await new Promise((resolve) => {
        releases.set(name, resolve)
        if (releases.size === 2) started.resolve()
      })
      return json(route, { text: `解析结果 ${name}` })
    })
    await page.route('**/api/chat', (route) => {
      sent = route.request().postDataJSON()
      return sse(route, [{ type: 'delta', content: '附件已收到' }, { type: 'done' }])
    })
    const fileInput = page.locator('input[type="file"]').first()
    await fileInput.setInputFiles({ name: 'first.pdf', mimeType: 'application/pdf', buffer: Buffer.from('test-one') })
    await fileInput.setInputFiles({ name: 'second.pdf', mimeType: 'application/pdf', buffer: Buffer.from('test-two') })
    await page.waitForFunction(() => document.querySelector('[aria-busy="true"]'))
    await page.locator('textarea').first().fill('分析附件')
    await page.locator('textarea').first().press('Enter')
    assert.equal(sent, undefined)
    const timer = setTimeout(() => started.reject(new Error('附件解析请求未全部发出')), 30000)
    try {
      await started.promise
    } finally {
      clearTimeout(timer)
    }
    assert.equal(releases.size, 2)
    releases.get('first.pdf')()
    await page.waitForFunction(async () => (await window.testModule('/src/store/composer.ts')).useComposer.getState().attachments.length === 1)
    await page.locator('textarea').first().press('Enter')
    assert.equal(sent, undefined)
    releases.get('second.pdf')()
    await page.waitForFunction(async () => (await window.testModule('/src/store/composer.ts')).useComposer.getState().attachments.length === 2)
    await page.locator('textarea').first().press('Enter')
    await lastStatus(page, 'done')
    assert.deepEqual(sent.messages.at(-1).attachments.map((attachment) => attachment.name), ['first.pdf', 'second.pdf'])
  })

  await test('删掉最后一个附件不会取消仍在解析的文件', async (page) => {
    const releases = new Map()
    const bothStarted = Promise.withResolvers()
    await page.route('**/api/extract', async (route) => {
      const { name } = route.request().postDataJSON()
      await new Promise((resolve) => {
        releases.set(name, resolve)
        if (releases.size === 2) bothStarted.resolve()
      })
      return json(route, { text: `解析结果 ${name}` })
    })
    const fileInput = page.locator('input[type="file"]').first()
    await fileInput.setInputFiles({ name: 'first.pdf', mimeType: 'application/pdf', buffer: Buffer.from('test-one') })
    await fileInput.setInputFiles({ name: 'second.pdf', mimeType: 'application/pdf', buffer: Buffer.from('test-two') })
    const timer = setTimeout(() => bothStarted.reject(new Error('附件解析请求未全部发出')), 30000)
    try {
      await bothStarted.promise
    } finally {
      clearTimeout(timer)
    }

    releases.get('first.pdf')()
    await page.waitForFunction(async () => (await window.testModule('/src/store/composer.ts')).useComposer.getState().attachments.length === 1)
    // 清空最后一个附件时，第二条仍在解析；旧实现会把整批解析任务取消，文件静默消失
    await page.getByRole('button', { name: '移除附件 first.pdf' }).click()
    await page.waitForFunction(async () => (await window.testModule('/src/store/composer.ts')).useComposer.getState().attachments.length === 0)
    releases.get('second.pdf')()
    await page.waitForFunction(async () => {
      const list = (await window.testModule('/src/store/composer.ts')).useComposer.getState().attachments
      return list.length === 1 && list[0].name === 'second.pdf'
    })
  })

  await test('停止首轮生成不触发自动标题或追问请求', async (page) => {
    let secondaryRequests = 0
    page.on('request', (request) => { if (/\/api\/(tasks\/)?(title|suggest)$/.test(request.url())) secondaryRequests += 1 })
    await pendingChat(page)
    await page.locator('textarea').first().fill('请生成回答')
    await page.locator('textarea').first().press('Enter')
    await page.getByText('已收到的部分内容', { exact: true }).waitFor()
    await page.getByRole('button', { name: '停止生成', exact: true }).click()
    await lastStatus(page, 'aborted')
    await page.evaluate(() => new Promise(requestAnimationFrame))
    assert.equal(secondaryRequests, 0)
  })

  await test('身份切换中止生成，不把旧会话同步到新身份', async (page) => {
    let syncs = 0, titles = 0
    page.on('request', (request) => {
      if (request.url().endsWith('/api/conversations') && request.method() === 'POST') syncs += 1
      if (/\/api\/(tasks\/)?title$/.test(request.url())) titles += 1
    })
    await pendingChat(page)
    await page.locator('textarea').first().fill('旧账号私有内容')
    await page.locator('textarea').first().press('Enter')
    await page.getByText('已收到的部分内容', { exact: true }).waitFor()
    await page.evaluate(async () => {
      const auth = (await window.testModule('/src/store/auth.ts')).useAuthStore
      auth.setState({ config: { authMode: 'multi', needsSetup: false } })
      await auth.getState().setUser(null)
    })
    await page.getByRole('dialog', { name: '账户登录' }).waitFor()
    await page.evaluate(() => new Promise(requestAnimationFrame))
    assert.equal(syncs, 0)
    assert.equal(titles, 0)
    assert.equal(await page.getByText('已收到的部分内容', { exact: true }).count(), 0)
  })

  assert.deepEqual(errors, [])
  console.log(`聊天回归 ${passed}/6 通过；浏览器未捕获异常 0`)
} finally {
  await browser.close()
}
