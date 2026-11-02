import { test } from 'node:test'
import assert from 'node:assert/strict'
import dns from 'node:dns/promises'

// STRICT_SSRF 在加载模块时读取；隔离模块实例并立即恢复宿主环境。
async function loadSsrf(strict) {
  const original = process.env.STRICT_SSRF
  process.env.STRICT_SSRF = strict ? '1' : '0'
  try {
    return await import(`../lib/ssrf.js?strict=${strict}`)
  } finally {
    if (original === undefined) delete process.env.STRICT_SSRF
    else process.env.STRICT_SSRF = original
  }
}

const { inspectBaseUrl, validateBaseUrl } = await loadSsrf(false)
const strictSsrf = await loadSsrf(true)

test('inspectBaseUrl：只接受 http/https', () => {
  assert.equal(inspectBaseUrl('https://api.openai.com/v1').ok, true)
  assert.equal(inspectBaseUrl('http://localhost:11434/v1').ok, true)
  assert.equal(inspectBaseUrl('ftp://example.com').ok, false)
  assert.equal(inspectBaseUrl('file:///etc/passwd').ok, false)
  assert.equal(inspectBaseUrl('not a url').ok, false)
})

test('inspectBaseUrl：拒绝带用户名密码的 URL', () => {
  const r = inspectBaseUrl('https://user:pass@example.com/v1')
  assert.equal(r.ok, false)
  assert.match(r.reason, /用户名或密码/)
})

test('inspectBaseUrl：永远拒绝云元数据与链路本地地址', () => {
  assert.equal(inspectBaseUrl('http://169.254.169.254/latest/meta-data').ok, false)
  assert.equal(inspectBaseUrl('http://metadata.google.internal/v1').ok, false)
  assert.equal(inspectBaseUrl('http://0.0.0.0:8080').ok, false)
})

test('inspectBaseUrl：默认允许回环与内网（Ollama / 局域网网关是真实需求）', () => {
  assert.equal(inspectBaseUrl('http://127.0.0.1:11434/v1').ok, true)
  assert.equal(inspectBaseUrl('http://192.168.1.10:8000/v1').ok, true)
  assert.equal(inspectBaseUrl('http://10.0.0.5/v1').ok, true)
})

test('inspectBaseUrl：IPv6 字面量必须识别为回环/内网/链路本地', () => {
  const loop = inspectBaseUrl('http://[::1]:3001')
  assert.equal(loop.ok, true)
  assert.equal(loop.private, true)

  const mapped = inspectBaseUrl('http://[::ffff:7f00:1]/')
  assert.equal(mapped.private, true, '::ffff:7f00:1 是 127.0.0.1 的十六进制映射')

  const private6 = inspectBaseUrl('http://[fd00::1]/')
  assert.equal(private6.private, true)

  const link = inspectBaseUrl('http://[::ffff:a9fe:a9fe]/')
  assert.equal(link.ok, false, '::ffff:a9fe:a9fe 是 169.254.169.254 的映射')
})

test('inspectBaseUrl：IPv4 映射 IPv6 的完整/点分写法同样识别', () => {
  for (const url of [
    'http://[0:0:0:0:0:ffff:7f00:1]:3001/',
    'http://[0:0:0:0:0:ffff:127.0.0.1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://[::127.0.0.1]/',
  ]) {
    const r = inspectBaseUrl(url)
    assert.equal(r.private, true, `${url} 应识别为回环`)
  }
  assert.equal(
    inspectBaseUrl('http://[0:0:0:0:0:ffff:a9fe:a9fe]/').ok,
    false,
    '完整写法映射到 169.254.169.254 也必须被拒绝'
  )
  assert.equal(inspectBaseUrl('http://[ff02::1]/').ok, false, 'IPv6 组播地址不可作为 Base URL')
  assert.equal(inspectBaseUrl('http://[0:0:0:0:0:ffff:0a00:1]/').private, true, '映射到 10.0.0.1 属于内网')
})

test('validateBaseUrl：rejectPrivate 必须拦住 IPv6 字面量', async () => {
  for (const url of [
    'http://[::1]:3001/api/health',
    'http://[::ffff:7f00:1]/',
    'http://[fd00::1]/',
    'http://[0:0:0:0:0:ffff:7f00:1]/',
    'http://[0:0:0:0:0:ffff:0a00:1]/',
  ]) {
    const r = await validateBaseUrl(url, { rejectPrivate: true })
    assert.equal(r.ok, false, url)
  }
})

test('validateBaseUrl：域名解析到被禁地址时拒绝', async () => {
  const r = await validateBaseUrl('http://169.254.169.254')
  assert.equal(r.ok, false)
})

const policies = [
  { name: '默认宽松', validate: validateBaseUrl, options: {}, allowed: true },
  { name: 'rejectPrivate', validate: validateBaseUrl, options: { rejectPrivate: true }, allowed: false },
  { name: 'STRICT_SSRF', validate: strictSsrf.validateBaseUrl, options: {}, allowed: false },
]

for (const policy of policies) {
  for (const scenario of [
    { name: 'DNS 失败', lookup: async () => { throw new Error('getaddrinfo ENOTFOUND') }, hint: /ENOTFOUND/ },
    { name: 'DNS 超时', lookup: () => new Promise(() => {}), hint: /DNS 解析超时/, timeout: true },
    { name: 'DNS 空结果', lookup: async () => [], hint: /DNS 未返回任何地址/ },
  ]) {
    test(`validateBaseUrl：${policy.name}处理${scenario.name}并清理定时器`, async (t) => {
      // 每例由 TestContext 自动恢复 DNS 与计时器，不依赖真实 DNS 或墙钟等待。
      const lookup = t.mock.method(dns, 'lookup', scenario.lookup)
      t.mock.timers.enable({ apis: ['setTimeout'] })
      const clearTimer = t.mock.method(globalThis, 'clearTimeout')
      const pending = policy.validate('https://dns-test.invalid/v1', { ...policy.options, timeoutMs: 20 })
      if (scenario.timeout) t.mock.timers.tick(20)
      const result = await pending
      assert.equal(result.ok, policy.allowed)
      assert.match(result.dnsError, scenario.hint)
      if (!policy.allowed) assert.match(result.reason, /无法验证 dns-test\.invalid 的目标地址/)
      else assert.equal(result.url.href, 'https://dns-test.invalid/v1')
      assert.equal(lookup.mock.callCount(), 1)
      assert.deepEqual(lookup.mock.calls[0].arguments, ['dns-test.invalid', { all: true, verbatim: true }])
      assert.equal(clearTimer.mock.callCount(), 1)
      assert.notEqual(clearTimer.mock.calls[0].arguments[0], undefined)
    })
  }

  test(`validateBaseUrl：${policy.name}检查 DNS 成功返回的全部地址并清理定时器`, async (t) => {
    const lookup = t.mock.method(dns, 'lookup', async () => [{ address: '93.184.216.34', family: 4 }])
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const clearTimer = t.mock.method(globalThis, 'clearTimeout')
    const result = await policy.validate('https://dns-test.invalid/v1', policy.options)
    assert.equal(result.ok, true)
    assert.deepEqual(result.addresses, ['93.184.216.34'])
    assert.equal(clearTimer.mock.callCount(), 1)

    lookup.mock.mockImplementation(async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ])
    assert.equal((await policy.validate('https://dns-test.invalid/v1', policy.options)).ok, policy.allowed)
    lookup.mock.mockImplementation(async () => [{ address: '169.254.169.254', family: 4 }])
    assert.equal((await policy.validate('https://dns-test.invalid/v1', policy.options)).ok, false)
    assert.equal(clearTimer.mock.callCount(), 3)
  })
}
