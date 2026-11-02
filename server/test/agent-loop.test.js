import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startMockUpstream } from './helpers/mock-upstream.js'
import { runAgentLoop, fitHistoryForWindow } from '../agent/loop.js'

function toolGroup(id, content) {
  return [
    { role: 'assistant', content: '', tool_calls: [{ id, name: 'lookup', arguments: {} }] },
    { role: 'tool', tool_call_id: id, name: 'lookup', content },
  ]
}

function toolIds(history) {
  return history.filter((m) => m?.role === 'tool').map((m) => m.tool_call_id)
}

test('fitHistoryForWindow：不传 contextWindow 时不做任何改动', () => {
  const history = [
    { role: 'user', content: '问题' },
    ...toolGroup('call_a', 'A'.repeat(50_000)),
  ]
  const snapshot = structuredClone(history)
  const result = fitHistoryForWindow(history)
  assert.equal(result.trimmed, false)
  assert.deepEqual(history, snapshot)
})

test('fitHistoryForWindow：预算够时原样返回', () => {
  const history = [
    { role: 'user', content: '问题' },
    ...toolGroup('call_a', '{"ok":true}'),
  ]
  const snapshot = structuredClone(history)
  const result = fitHistoryForWindow(history, { contextWindow: 128_000, maxTokens: 4096 })
  assert.equal(result.trimmed, false)
  assert.deepEqual(history, snapshot)
})

test('fitHistoryForWindow：先省略较早的工具结果，最新结果保持原样', () => {
  const history = [
    { role: 'user', content: '问题' },
    ...toolGroup('call_a', 'A'.repeat(20_000)),
    ...toolGroup('call_b', 'B'.repeat(20_000)),
  ]
  const newest = history.at(-1).content
  const result = fitHistoryForWindow(history, { contextWindow: 8192, maxTokens: 1024 })
  assert.equal(result.trimmed, true)
  assert.equal(result.dropped, 0)
  assert.match(history[2].content, /已被省略/)
  assert.equal(history.at(-1).content, newest, '最新工具结果不应被改动')
  assert.deepEqual(toolIds(history), ['call_a', 'call_b'], 'tool_call 配对关系必须保留')
})

test('fitHistoryForWindow：只剩一条超大工具结果时中段截断，保留头尾', () => {
  const content = `开头很重要。${'中间内容'.repeat(5000)}结尾也很重要。`
  const history = [
    { role: 'user', content: '问题' },
    ...toolGroup('call_a', content),
  ]
  const result = fitHistoryForWindow(history, { contextWindow: 4096, maxTokens: 512 })
  assert.equal(result.trimmed, true)
  assert.equal(result.dropped, 0)
  const cut = history.at(-1).content
  assert.ok(cut.length < content.length)
  assert.ok(cut.startsWith('开头很重要。'))
  assert.ok(cut.endsWith('结尾也很重要。'))
  assert.match(cut, /中段截断/)
})

test('fitHistoryForWindow：仍放不下时丢弃最早的调用组，但保留最后一组', () => {
  const history = [
    { role: 'user', content: '超长历史'.repeat(8000) },
    ...toolGroup('call_a', 'A'.repeat(4000)),
    ...toolGroup('call_b', 'B'.repeat(4000)),
  ]
  const result = fitHistoryForWindow(history, { contextWindow: 4096, maxTokens: 512 })
  assert.equal(result.trimmed, true)
  assert.ok(result.dropped >= 2)
  assert.deepEqual(toolIds(history), ['call_b'])
  const assistantCalls = history
    .filter((m) => m?.role === 'assistant' && m.tool_calls?.length)
    .flatMap((m) => m.tool_calls.map((c) => c.id))
  assert.equal(assistantCalls.at(-1), 'call_b', '被保留的 tool 消息必须有对应的助手调用')
})

test('agent 循环：工具结果超窗时压缩后再请求，tool_call 配对不破坏', async (t) => {
  const upstream = await startMockUpstream({
    toolPlan: [
      { toolCalls: [{ name: 'fake_heavy', arguments: {} }] },
      { text: '已经根据工具结果作答。' },
    ],
  })
  t.after(() => upstream.close())

  const notices = []
  const deltas = []
  const result = await runAgentLoop({
    provider: {
      id: 'mock-heavy',
      name: '本地假上游',
      type: 'openai-compat',
      baseUrl: upstream.baseUrl,
      apiKey: 'sk-mock',
    },
    model: 'mock-model',
    messages: [{ role: 'user', content: '帮我查一下' }],
    system: '你是助手。',
    maxTokens: 512,
    toolDefs: [{
      type: 'function',
      function: { name: 'fake_heavy', description: '返回大量文本', parameters: { type: 'object', properties: {} } },
    }],
    contextWindow: 4096,
    mcpIndex: new Map([['fake_heavy', {
      serverId: 'mock-server',
      toolName: 'fake_heavy',
      serverName: '假 MCP',
      trusted: true,
    }]]),
    onExecuteMcp: async () => ({ ok: true, text: '哈'.repeat(50_000) }),
    onNotice: (message) => notices.push(message),
    onDelta: (text) => deltas.push(text),
  })

  assert.equal(result.steps, 2)
  assert.equal(upstream.state.hits, 2, '工具执行后必须发起第二轮请求')
  assert.equal(deltas.join(''), '已经根据工具结果作答。')

  const second = upstream.state.lastBody
  const toolMessage = second.messages.find((m) => m.role === 'tool')
  assert.ok(toolMessage, '第二轮必须带上工具结果')
  assert.equal(toolMessage.tool_call_id, 'call_0')
  assert.ok(toolMessage.content.length < 20_000, `工具结果应被压缩，实际 ${toolMessage.content.length} 字符`)
  assert.match(toolMessage.content, /中段截断|已被省略/)

  const assistant = second.messages.find((m) => m.role === 'assistant' && m.tool_calls?.length)
  assert.ok(assistant, '助手 tool_calls 必须保留，否则上游会拒绝 tool 消息')
  assert.equal(assistant.tool_calls[0].id, toolMessage.tool_call_id)
  assert.ok(
    notices.some((n) => /已压缩较早的工具结果/.test(n)),
    `用户应收到压缩提示，实际：${notices.join(' | ')}`
  )
})
