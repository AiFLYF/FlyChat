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

const upstream = await startMockUpstream({
  // 拆得越碎越能看清打字机手感；40ms/片 ≈ 真实模型的流式节奏，
  // 也让「停止生成」按钮有足够的可操作窗口
  chunks: REPLY.match(/[\s\S]{1,6}/g) || ['好的'],
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
