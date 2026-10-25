import { test } from 'node:test'
import assert from 'node:assert/strict'
import { inspectBaseUrl, validateBaseUrl } from '../lib/ssrf.js'

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

test('validateBaseUrl：域名解析到被禁地址时拒绝', async () => {
  const r = await validateBaseUrl('http://169.254.169.254')
  assert.equal(r.ok, false)
})

test('validateBaseUrl：解析失败时放行但带上 dnsError（离线环境也要能用）', async () => {
  const r = await validateBaseUrl('http://this-host-should-not-exist.invalid/v1', { timeoutMs: 1500 })
  assert.equal(r.ok, true)
  assert.ok(r.dnsError)
})
