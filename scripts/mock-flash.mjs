#!/usr/bin/env node
/**
 * 本地闪测模型（mock 上游）。
 *
 * 用途：没有任何真实 API Key / 自代理网关时，也能跑通完整产品链路——
 * 流式输出、思考过程、工具调用、视界（图片块）、用量统计。
 * 复用测试基建里的假上游（OpenAI + Anthropic 双协议 SSE），零新依赖。
 *
 * 用法：
 *   node scripts/mock-flash.mjs                 # 前台运行，打印 baseUrl
 *   BASE_URL=<url> node scripts/mock-flash.mjs  # 只注册不启动（配合已运行的实例）
 *
 * 之后在网页「设置 → 模型服务」添加自定义服务商：
 *   类型 openai-compat，Base URL 用打印出来的地址，模型 mock-flash
 * 或直接 curl 注册：
 *   curl -X POST localhost:3001/api/providers/custom -H 'Content-Type: application/json' \
 *     -d '{"name":"闪测模型","type":"openai-compat","baseUrl":"<url>","apiKey":"sk-mock","models":["mock-flash"]}'
 */
import { startMockUpstream } from '../server/test/helpers/mock-upstream.js'

const REPLY = [
  '好的，我是本地闪测模型。这段回复经由 SSE 逐字流式返回，',
  '用于验证前端打字机效果、Markdown 渲染、思考过程折叠与用量统计。',
  '\n\n**加粗**、`行内代码`、列表：\n\n- 第一项\n- 第二项\n\n',
  '```js\nconsole.log("代码块高亮正常吗？")\n```\n',
].join('')

/**
 * 提示词里提到网页/构件时回一段 HTML。
 *
 * 这样产物工作台（代码块「分屏」→ iframe 沙箱）才有得测：
 * 「分屏」按钮只在代码块是 html/svg 时出现，固定回 js 的话这条链路永远测不到。
 */
const HTML_REPLY = [
  '这是一个可直接预览的构件：\n\n',
  '```html\n',
  '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8" />\n',
  '<style>\n  body{margin:0;font-family:system-ui,sans-serif;display:grid;place-items:center;height:100vh;background:#0f172a;color:#e2e8f0}\n',
  '  .card{padding:24px 32px;border-radius:16px;background:#1e293b;box-shadow:0 8px 30px rgba(0,0,0,.35);text-align:center}\n',
  '  h1{margin:0 0 8px;font-size:20px}\n  p{margin:0;color:#94a3b8;font-size:13px}\n</style>\n</head>\n<body>\n',
  '  <div class="card"><h1>构件沙箱正常</h1><p>iframe 已成功渲染这段 HTML</p></div>\n',
  '</body>\n</html>\n```\n',
].join('')

/**
 * 提示词要求「长文」时回一段明显更长的内容。
 *
 * 固定 1 秒的回复有个副作用：测「停止生成」时按钮只存在 1 秒，
 * Playwright 的可见性/稳定性检查还没走完就没了（实测偶发 click 超时）。
 * 让长文请求真的长一点，既更接近真实模型，也把可点击窗口拉到 4~5 秒。
 */
const LONG_REPLY = (() => {
  const parts = ['好的，这是一篇较长的示例文章，用于验证长文流式渲染与「停止生成」。\n\n']
  for (let i = 1; i <= 24; i += 1) {
    parts.push(
      `## 第 ${i} 节\n\n` +
        `这一节用来占位，模拟模型持续输出的场景。段落里混入**加粗**、\`行内代码\` 与普通文本，` +
        `确保流式过程中 Markdown 增量解析不会抖动。第 ${i} 节结束。\n\n`
    )
  }
  parts.push('```js\nconsole.log("长文结束")\n```\n')
  return parts.join('')
})()

const wantsLong = (body) => {
  const msgs = body?.messages
  if (!Array.isArray(msgs)) return false
  const lastUser = [...msgs].reverse().find((m) => m?.role === 'user')
  const text = typeof lastUser?.content === 'string' ? lastUser.content : JSON.stringify(lastUser?.content ?? '')
  return /很长|长文|长一点|详细展开|长文章/.test(text)
}

/** 提到 svg / 图标 / 矢量图时回一段 SVG（验证「代码块预览」与产物工作台的 svg 分支） */
const SVG_REPLY = [
  '这是一个可直接预览的 SVG：\n\n',
  '```svg\n',
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" width="120" height="120">\n',
  '  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">\n',
  '    <stop offset="0" stop-color="#5b8bff"/><stop offset="1" stop-color="#22d3ee"/>\n',
  '  </linearGradient></defs>\n',
  '  <circle cx="60" cy="60" r="46" fill="url(#g)" opacity="0.18"/>\n',
  '  <circle cx="60" cy="60" r="46" fill="none" stroke="url(#g)" stroke-width="3"/>\n',
  '  <path d="M40 62l14 14 26-30" fill="none" stroke="url(#g)" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>\n',
  '</svg>\n```\n',
].join('')

const wantsSvg = (body) => {
  const msgs = body?.messages
  if (!Array.isArray(msgs)) return false
  const lastUser = [...msgs].reverse().find((m) => m?.role === 'user')
  const text = typeof lastUser?.content === 'string' ? lastUser.content : JSON.stringify(lastUser?.content ?? '')
  return /svg|图标|矢量/i.test(text)
}

const wantsHtml = (body) => {
  const msgs = body?.messages
  if (!Array.isArray(msgs)) return false
  const lastUser = [...msgs].reverse().find((m) => m?.role === 'user')
  const text = typeof lastUser?.content === 'string' ? lastUser.content : JSON.stringify(lastUser?.content ?? '')
  return /html|构件|artifact|网页|页面/i.test(text)
}

const upstream = await startMockUpstream({
  // 拆得越碎越能看清打字机手感；40ms/片 ≈ 真实模型的流式节奏，
  // 也让「停止生成」按钮有足够的可操作窗口
  chunks: REPLY.match(/[\s\S]{1,6}/g) || ['好的'],
  resolveChunks: (body) => {
    if (wantsSvg(body)) return SVG_REPLY.match(/[\s\S]{1,16}/g)
    if (wantsHtml(body)) return HTML_REPLY.match(/[\s\S]{1,24}/g)
    if (wantsLong(body)) return LONG_REPLY.match(/[\s\S]{1,10}/g)
    return null
  },
  delayMs: 40,
  models: ['mock-flash'],
  // 固定端口：重启脚本后已注册的服务商配置不会失效
  port: Number(process.env.MOCK_FLASH_PORT || 8790),
})

console.log(`[mock-flash] ready at ${upstream.baseUrl}`)
console.log('[mock-flash] provider: openai-compat / model: mock-flash')

// ——register [flychat-url]：把闪测模型注册进 FlyChat。
// 必须用 node fetch（标准 UTF-8）：在 Windows shell 里用 curl 内联中文 JSON
// 会被本地代码页毁成 mojibake（真实踩过：服务商名变成一串 U+FFFD 方块）。
const regIdx = process.argv.indexOf('--register')
if (regIdx > -1) {
  const flychat = /^https?:\/\//.test(process.argv[regIdx + 1] || '')
    ? process.argv[regIdx + 1]
    : 'http://127.0.0.1:3001'
  try {
    const res = await fetch(`${flychat}/api/providers/custom`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: '闪测模型',
        type: 'openai-compat',
        baseUrl: upstream.baseUrl,
        apiKey: 'sk-mock',
        models: ['mock-flash'],
      }),
    })
    const out = await res.json().catch(() => ({}))
    if (res.ok) console.log(`[mock-flash] 已注册到 ${flychat}（id: ${out.id}），刷新页面即可在设置里选用`)
    else console.error(`[mock-flash] 注册失败 HTTP ${res.status}:`, JSON.stringify(out))
  } catch (err) {
    console.error(`[mock-flash] 注册失败（后端没在 ${flychat} 运行？）:`, err?.message)
  }
}

console.log('[mock-flash] Ctrl+C 退出')

const shutdown = () => {
  void upstream.close().then(() => process.exit(0))
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
