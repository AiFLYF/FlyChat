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

test('estimateMessageTokens：tool_calls 的名称与参数都要计入', () => {
  const plain = estimateMessageTokens({ role: 'assistant', content: '' })
  const args = { query: '长参数'.repeat(500) }
  const withCall = estimateMessageTokens({
    role: 'assistant',
    content: '',
    tool_calls: [{ id: 'call_1', name: 'lookup', arguments: args }],
  })
  assert.ok(withCall > plain + 500, `工具调用参数必须计入预算：${withCall} vs ${plain}`)
  const asString = estimateMessageTokens({
    role: 'assistant',
    content: '',
    tool_calls: [{ id: 'call_1', name: 'lookup', arguments: JSON.stringify(args) }],
  })
  assert.ok(Math.abs(withCall - asString) <= 2, '参数无论对象还是字符串都应等价估算')
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
  assert.ok(plan.messages.length >= 4, '预算允许时保留 minKeepMessages 条')
  assert.ok(plan.estimatedInputTokens <= plan.budget)
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

function assertWithinBudget(plan) {
  const actual = estimateTokens(plan.system) + estimateMessagesTokens(plan.messages)
  assert.equal(plan.estimatedInputTokens, actual, '必须返回裁剪结果的真实估算值')
  assert.ok(actual <= plan.budget, `${actual} 不得超过 ${plan.budget}`)
  assert.ok(estimateTokens(plan.system) <= Math.floor(plan.budget * 0.4), 'system 不得超过预算 40%')
}

function freezeDeep(value) {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) freezeDeep(item)
    Object.freeze(value)
  }
  return value
}

const contextOverflow = { name: 'AppError', status: 400, code: 'context_overflow' }

test('planContext：小窗口不设 1024 下限，输出至少预留一个 token', () => {
  for (const maxOutput of [0, 1, 64]) {
    const plan = planContext({
      contextWindow: 512,
      maxOutput,
      messages: [{ role: 'user', content: '中文长文本'.repeat(1000) }],
    })
    assert.equal(plan.budget, 512 - Math.max(1, maxOutput) - 26)
    assertWithinBudget(plan)
    assert.equal(plan.trimmed, true)
    assert.equal(plan.truncated, 1)
    assert.equal(plan.dropped, 0)
  }
})

test('planContext：输出和安全余量耗尽窗口时明确返回 400', () => {
  for (const maxOutput of [950, 1000, 2000]) {
    assert.throws(() => planContext({ contextWindow: 1000, maxOutput }), contextOverflow)
  }
  assert.throws(() => planContext({
    contextWindow: 10,
    maxOutput: 6,
    messages: [{ role: 'user', content: 'hi' }],
  }), contextOverflow, '预算不足消息固定开销时不能假装成功')
})

test('planContext：大 system 独立计入截断统计，保留头尾且标记不超 40%', () => {
  const system = `系统开头重要。${'中文约束 abc '.repeat(5000)}系统结尾重要。`
  const messages = [{ role: 'user', content: '简短问题' }]
  const plan = planContext({ system, messages, contextWindow: 4096, maxOutput: 512 })
  assertWithinBudget(plan)
  assert.ok(plan.system.startsWith('系统开头重要。'))
  assert.ok(plan.system.endsWith('系统结尾重要。'))
  assert.match(plan.system, /原文过长已中段截断/)
  assert.equal(plan.trimmed, true)
  assert.equal(plan.truncated, 1)
  assert.equal(plan.dropped, 0)
  assert.strictEqual(plan.messages, messages, 'system 截断不能误改消息')
})

test('planContext：system 与正文同时超长时分别统计截断', () => {
  const plan = planContext({
    system: '系统约束'.repeat(5000),
    messages: [{ role: 'user', content: '中文问题'.repeat(5000) }],
    contextWindow: 4096,
    maxOutput: 512,
  })
  assertWithinBudget(plan)
  assert.equal(plan.truncated, 2)
  assert.equal(plan.trimmed, true)
  assert.equal(plan.dropped, 0)
})

test('planContext：极小预算使用短标记或清空，仍如实统计截断', () => {
  const plan = planContext({
    system: '长系统提示'.repeat(100),
    messages: [{ role: 'user', content: '长正文'.repeat(100) }],
    contextWindow: 10,
    maxOutput: 1,
  })
  assertWithinBudget(plan)
  assert.equal(plan.system, '…')
  assert.equal(plan.messages[0].content, '…')
  assert.equal(plan.truncated, 2)
  assert.equal(plan.trimmed, true)

  const empty = planContext({ system: '长系统提示', contextWindow: 10, maxOutput: 8 })
  assertWithinBudget(empty)
  assert.equal(empty.system, '')
  assert.equal(empty.truncated, 1)
  assert.equal(empty.trimmed, true)
})

test('planContext：minKeep 尽量截短旧消息，但不能强行保留到超预算', () => {
  const messages = [
    { id: 'oldest', role: 'user', content: '更早的历史'.repeat(1000) },
    { id: 'older', role: 'assistant', content: '上一轮的回答'.repeat(1000) },
    { id: 'latest', role: 'user', content: '现在的问题' },
  ]
  const one = planContext({ messages, contextWindow: 512, maxOutput: 64, minKeepMessages: 1 })
  const two = planContext({ messages, contextWindow: 512, maxOutput: 64, minKeepMessages: 2 })
  const many = planContext({ messages, contextWindow: 512, maxOutput: 64, minKeepMessages: 100 })
  for (const plan of [one, two, many]) {
    assertWithinBudget(plan)
    assert.strictEqual(plan.messages.at(-1), messages.at(-1), '最新消息优先且不能为凑条数裁剪')
    assert.equal(plan.dropped, messages.length - plan.messages.length)
  }
  assert.equal(one.messages.length, 1)
  assert.equal(two.messages.length, 2)
  assert.equal(two.messages[0].id, 'older')
  assert.equal(two.truncated, 1)
  assert.deepEqual(many.messages.map((m) => m.id), ['older', 'latest'], 'minKeep 很大也不能突破预算')
  assert.equal(many.dropped, 1)
  assert.equal(many.truncated, 1)
})

test('planContext：minKeep 不能强留放不下的旧图片，也不跳过中间消息', () => {
  const messages = [
    { id: 'oldest', role: 'user', content: '小消息' },
    { id: 'image', role: 'assistant', content: '', attachments: [{ type: 'image', dataUrl: 'data:image/png;base64,AAA' }] },
    { id: 'latest', role: 'user', content: '继续' },
  ]
  const plan = planContext({ messages, contextWindow: 512, maxOutput: 64, minKeepMessages: 100 })
  assertWithinBudget(plan)
  assert.deepEqual(plan.messages, [messages[2]])
  assert.equal(plan.dropped, 2)
  assert.equal(plan.truncated, 0)
  assert.equal(plan.trimmed, true)
})

test('planContext：大文本附件单独触发截断，保留头尾并计入统计', () => {
  const text = `附件开头。${'很长的附件正文'.repeat(5000)}附件结尾。`
  const message = { role: 'user', content: '', attachments: [{ type: 'file', name: '说明.txt', text }] }
  const plan = planContext({ messages: [message], contextWindow: 2048, maxOutput: 256 })
  assertWithinBudget(plan)
  const attachment = plan.messages[0].attachments[0]
  assert.equal(attachment.name, '说明.txt')
  assert.ok(attachment.text.startsWith('附件开头。'))
  assert.ok(attachment.text.endsWith('附件结尾。'))
  assert.match(attachment.text, /原文过长已中段截断/)
  assert.equal(plan.truncated, 1)
  assert.equal(plan.trimmed, true)
  assert.equal(plan.dropped, 0)
})

test('planContext：正文与多个附件共同裁剪，不变更原输入或图片', () => {
  const messages = freezeDeep([{
    id: 'immutable',
    role: 'user',
    createdAt: 123,
    content: '正文 abc 中文'.repeat(5000),
    attachments: [
      { type: 'image', name: '照片.png', dataUrl: 'data:image/png;base64,AAA' },
      { type: 'file', name: '中文.txt', text: '附件中文'.repeat(5000) },
      { type: 'file', name: 'english.txt', text: 'English text '.repeat(5000) },
      { type: 'file', name: '空.txt', text: '' },
    ],
  }])
  const original = structuredClone(messages)
  const plan = planContext({ messages, contextWindow: 8000, maxOutput: 1000 })
  assertWithinBudget(plan)
  assert.deepEqual(messages, original)
  assert.notStrictEqual(plan.messages[0], messages[0])
  assert.equal(plan.messages[0].id, messages[0].id)
  assert.equal(plan.messages[0].createdAt, messages[0].createdAt)
  assert.ok(plan.messages[0].content.length < messages[0].content.length)
  assert.strictEqual(plan.messages[0].attachments[0], messages[0].attachments[0])
  for (const index of [1, 2]) {
    assert.ok(plan.messages[0].attachments[index].text.length < messages[0].attachments[index].text.length)
  }
  assert.equal(plan.truncated, 1, '同一消息的正文及多个附件合计一次')
})

test('planContext：最新图片超限抛 400；固定开销刚好装下时保留原图片', () => {
  const messages = freezeDeep([{
    role: 'user', content: '需要裁剪的正文',
    attachments: [{ type: 'image', dataUrl: 'data:image/png;base64,AAA' }],
  }])
  const original = structuredClone(messages)
  assert.throws(() => planContext({ messages, contextWindow: 2000, maxOutput: 797 }), contextOverflow)
  const plan = planContext({ messages, contextWindow: 2000, maxOutput: 796 })
  assertWithinBudget(plan)
  assert.equal(plan.budget, 1104)
  assert.equal(plan.estimatedInputTokens, 1104)
  assert.equal(plan.messages[0].content, '')
  assert.strictEqual(plan.messages[0].attachments[0], messages[0].attachments[0])
  assert.equal(plan.truncated, 1)
  assert.equal(plan.trimmed, true)
  assert.deepEqual(messages, original)
})

test('planContext：附件名称与包装固定开销放不下时明确抛 400', () => {
  const messages = [{ role: 'user', content: '', attachments: [{ type: 'file', name: '长文件名'.repeat(100), text: '内容' }] }]
  assert.throws(() => planContext({ messages, contextWindow: 100, maxOutput: 10 }), contextOverflow)
})

test('planContext：原文含截断提示不代表本次发生截断', () => {
  const messages = [
    { role: 'assistant', content: '旧消息'.repeat(5000) },
    { role: 'user', content: '请解释“原文过长已中段截断”' },
  ]
  const plan = planContext({ messages, contextWindow: 512, maxOutput: 64, minKeepMessages: 1 })
  assertWithinBudget(plan)
  assert.equal(plan.dropped, 1)
  assert.equal(plan.truncated, 0)
})
