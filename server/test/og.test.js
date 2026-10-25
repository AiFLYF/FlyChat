import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { prepareEnv, listen, loadApp } from './helpers/setup.js'

prepareEnv()

const createApp = await loadApp()
const { initStorage } = await import('../store/db.js')
const { buildShareMeta, escapeHtml, injectMeta, renderMetaTags } = await import('../lib/og.js')
initStorage()

const server = await listen(createApp())

const post = (p, body) =>
  fetch(`${server.url}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

test.after(() => server.close())

const INDEX = path.join(process.cwd(), 'dist', 'index.html')
const hasDist = fs.existsSync(INDEX)

/* ——— 纯函数 ——— */

test('escapeHtml：分享标题来自用户输入，必须转义', () => {
  assert.equal(escapeHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;')
  assert.equal(escapeHtml(`a"b'c&d`), 'a&quot;b&#39;c&amp;d')
  assert.equal(escapeHtml(null), '')
})

test('buildShareMeta：标题取会话名，摘要取首条用户提问并去掉 Markdown', () => {
  const meta = buildShareMeta({
    title: '限流方案讨论',
    messages: [
      { role: 'user', content: '**令牌桶**和漏桶有什么区别？`Redis` 能实现吗' },
      { role: 'assistant', content: '令牌桶允许突发…' },
    ],
  })
  assert.equal(meta.title, '限流方案讨论')
  assert.ok(!meta.description.includes('**'), `摘要里不该有 Markdown：${meta.description}`)
  assert.ok(!meta.description.includes('`'), '反引号也要去掉')
  assert.match(meta.description, /令牌桶/)
  assert.equal(meta.noindex, false)
})

test('buildShareMeta：没有用户消息时退回助手内容；都没有给兜底文案', () => {
  const onlyAssistant = buildShareMeta({
    title: 'T',
    messages: [{ role: 'assistant', content: '这是一段回答' }],
  })
  assert.match(onlyAssistant.description, /这是一段回答/)

  const empty = buildShareMeta({ title: 'T', messages: [] })
  assert.match(empty.description, /共 0 条消息/)
})

test('buildShareMeta：密码保护的分享不泄露标题与正文', () => {
  const meta = buildShareMeta({
    title: '季度财报分析',
    hasPassword: true,
    messages: [{ role: 'user', content: '机密内容' }],
  })
  assert.ok(!meta.title.includes('季度财报'), '加密分享不能把标题写进 meta')
  assert.ok(!meta.description.includes('机密内容'))
  assert.equal(meta.noindex, true, '加密分享不该被搜索引擎收录')
})

test('buildShareMeta：摘要按长度截断，不会把整段正文塞进 meta', () => {
  const long = '这是一段很长的内容。'.repeat(50)
  const meta = buildShareMeta({ title: 'T', messages: [{ role: 'user', content: long }] })
  assert.ok(meta.description.length <= 160, `摘要过长：${meta.description.length}`)
  assert.ok(meta.description.endsWith('…'))
})

test('injectMeta：替换标题、插入 og 标签，其余文档保持不变', () => {
  const html = '<!doctype html><html><head><title>FlyChat</title></head><body><div id="root"></div></body></html>'
  const out = injectMeta(html, { title: '我的对话', description: '一段摘要' }, { url: 'https://x.test/s/abc' })

  assert.match(out, /<title>我的对话<\/title>/)
  assert.ok(!out.includes('<title>FlyChat</title>'), '原标题必须被替换')
  assert.match(out, /property="og:title" content="我的对话"/)
  assert.match(out, /property="og:description" content="一段摘要"/)
  assert.match(out, /property="og:url" content="https:\/\/x\.test\/s\/abc"/)
  assert.match(out, /name="twitter:card"/)
  assert.match(out, /<div id="root"><\/div>/, 'body 不能被改动')
  // 所有 meta 都必须在 </head> 之前
  assert.ok(out.indexOf('og:title') < out.indexOf('</head>'))
})

test('injectMeta：标题里的引号与标签被转义，不能闭合属性或注入脚本', () => {
  const html = '<html><head><title>x</title></head><body></body></html>'
  const out = injectMeta(html, { title: '"><script>alert(1)</script>', description: "it's" })

  assert.ok(!out.includes('<script>alert(1)</script>'), '不能把脚本原样写进 HTML')
  assert.match(out, /content="&quot;&gt;&lt;script&gt;/)
})

test('injectMeta：没有 <title> 时也能插入', () => {
  const out = injectMeta('<html><head></head><body></body></html>', { title: 'T', description: 'D' })
  assert.match(out, /<title>T<\/title>/)
  assert.match(out, /og:title/)
})

test('renderMetaTags：noindex 时带 robots 标签', () => {
  const tags = renderMetaTags({ title: 'T', description: 'D', noindex: true })
  assert.match(tags, /name="robots" content="noindex, nofollow"/)
})

/* ——— 路由 ——— */

test('GET /s/:id 注入真实分享的标题与摘要', { skip: !hasDist && '没有构建产物 dist/index.html' }, async (t) => {
  const created = await post('/api/share', {
    snapshot: {
      id: 'conv-og-1',
      title: '向量库选型笔记',
      messages: [
        { id: 'm1', role: 'user', content: 'HNSW 和 IVF 该怎么选？' },
        { id: 'm2', role: 'assistant', content: '看你的召回要求…' },
      ],
    },
  })
  const share = await created.json()
  assert.equal(created.status, 201, JSON.stringify(share))
  t.after(() => fetch(`${server.url}/api/share/${share.id}`, { method: 'DELETE' }))

  const res = await fetch(`${server.url}/s/${share.id}`)
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type') || '', /text\/html/)
  const html = await res.text()
  assert.match(html, /<title>向量库选型笔记<\/title>/)
  assert.match(html, /property="og:title" content="向量库选型笔记"/)
  assert.match(html, /og:description" content="HNSW 和 IVF 该怎么选？/)
  // 仍然是 SPA：根节点和脚本都还在
  assert.match(html, /id="root"/)
})

test('GET /s/:id 对不存在的分享返回页面而不是 404（否则抓取器会缓存成坏链接）', { skip: !hasDist && '没有构建产物' }, async () => {
  const res = await fetch(`${server.url}/s/definitely-not-exist`)
  assert.equal(res.status, 200)
  const html = await res.text()
  assert.match(html, /name="robots" content="noindex/)
})

test('GET /s/:id 对密码保护的分享不泄露内容', { skip: !hasDist && '没有构建产物' }, async (t) => {
  const created = await post('/api/share', {
    snapshot: {
      id: 'conv-og-2',
      title: '机密对话',
      messages: [{ id: 'm1', role: 'user', content: '这里是机密内容' }],
    },
    password: 'p@ssw0rd',
  })
  const share = await created.json()
  t.after(() => fetch(`${server.url}/api/share/${share.id}`, { method: 'DELETE' }))

  const html = await (await fetch(`${server.url}/s/${share.id}`)).text()
  assert.ok(!html.includes('机密对话'), '加密分享的标题不能出现在 HTML 里')
  assert.ok(!html.includes('这里是机密内容'), '正文更不能出现')
  assert.match(html, /name="robots" content="noindex/)
})
