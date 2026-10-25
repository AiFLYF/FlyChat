import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  estimateTokens,
  estimateMessageTokens,
  estimateMessagesTokens,
  planContext,
  truncateMiddle,
} from '../lib/tokens.js'

test('estimateTokens：ASCII 按约 3.6 字符/token', () => {
  const t = estimateTokens('The quick brown fox jumps over the lazy dog')
  assert.ok(t >= 10 && t <= 14, `实际 ${t}`)
  assert.equal(estimateTokens(''), 0)
})

test('estimateTokens：中文按字计，且比英文更费 token', () => {
  const zh = estimateTokens('你好世界')
  const en = estimateTokens('hello world')
  assert.ok(zh > en, `中文 ${zh} 应大于英文 ${en}`)
  assert.equal(zh, 5) // 4 * 1.05 向上取整
})

test('estimateMessageTokens：附件文本与图片都要计入', () => {
  const plain = estimateMessageTokens({ role: 'user', content: 'hi' })
  const withFile = estimateMessageTokens({
    role: 'user',
    content: 'hi',
    attachments: [{ type: 'file', name: 'a.txt', text: 'x'.repeat(1000) }],
  })
  const withImage = estimateMessageTokens({
    role: 'user',
    content: 'hi',
    attachments: [{ type: 'image', dataUrl: 'data:image/png;base64,AAA' }],
  })
  assert.ok(withFile > plain + 200)
  assert.ok(withImage > plain + 1000)
})

test('planContext：预算充足时原样返回', () => {
  const messages = [
    { role: 'user', content: '你好' },
    { role: 'assistant', content: '你好，有什么可以帮你？' },
  ]
  const plan = planContext({ system: '你是助手', messages, contextWindow: 128_000, maxOutput: 4096 })
  assert.equal(plan.messages.length, 2)
  assert.equal(plan.trimmed, false)
  assert.equal(plan.dropped, 0)
})

test('planContext：超预算时丢最早的消息，保留最新的提问', () => {
  const messages = []
  for (let i = 0; i < 60; i += 1) {
    messages.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: '这是一段很长的历史内容。'.repeat(200) })
  }
  messages.push({ role: 'user', content: '最后一个问题' })

  const plan = planContext({ system: '', messages, contextWindow: 16_000, maxOutput: 2000, minKeepMessages: 4 })
  assert.equal(plan.trimmed, true)
  assert.ok(plan.dropped > 0)
  assert.equal(plan.messages.at(-1).content, '最后一个问题')
  assert.ok(plan.messages.length >= 4, '至少保留 minKeepMessages 条')
  assert.ok(plan.estimatedInputTokens <= plan.budget + 200)
})

test('planContext：单条消息就爆预算时做中段截断，头尾都保留', () => {
  const huge = `开头很重要。${'中间内容'.repeat(20000)}结尾也很重要。`
  const plan = planContext({
    system: '',
    messages: [{ role: 'user', content: huge }],
    contextWindow: 8000,
    maxOutput: 1000,
  })
  assert.equal(plan.messages.length, 1)
  assert.ok(plan.messages[0].content.length < huge.length)
  assert.ok(plan.messages[0].content.startsWith('开头很重要'))
  assert.ok(plan.messages[0].content.includes('原文过长已中段截断'))
  assert.ok(plan.messages[0].content.endsWith('结尾也很重要。'))
})

test('truncateMiddle：不超长时原样返回', () => {
  const r = truncateMiddle('短文本', 100)
  assert.equal(r.truncated, false)
  assert.equal(r.text, '短文本')
})

test('estimateMessagesTokens 累加正确', () => {
  const total = estimateMessagesTokens([
    { role: 'user', content: 'a' },
    { role: 'assistant', content: 'b' },
  ])
  assert.ok(total >= 8)
})
