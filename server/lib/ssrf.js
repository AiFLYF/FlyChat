import dns from 'node:dns/promises'
import net from 'node:net'

/**
 * Base URL 安全校验。
 *
 * 自定义服务商的 Base URL 是用户可控输入，服务端会拿它去发请求——
 * 如果不校验，等于给了一个「让服务器访问任意地址」的能力（SSRF）：
 * 云主机的 169.254.169.254 元数据接口、内网管理后台都可能被读出来。
 *
 * 策略：
 * - 只允许 http / https，禁止 URL 里带用户名密码（会出现在日志里）
 * - 永远拒绝链路本地地址与云元数据地址
 * - 默认**允许**回环与内网地址（Ollama、局域网网关是真实需求），但记警告
 * - 设置 STRICT_SSRF=1 后连回环/内网一起拒绝，适合纯公网部署
 */

const STRICT = /^(1|true|yes|on)$/i.test(process.env.STRICT_SSRF || '')

const BLOCKED_HOSTNAMES = new Set([
  'metadata',
  'metadata.google.internal',
  'instance-data',
])

function parseIPv4(host) {
  const parts = host.split('.')
  if (parts.length !== 4) return null
  const nums = parts.map((p) => Number(p))
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null
  return nums
}

function ipv4Kind(host) {
  const n = parseIPv4(host)
  if (!n) return null
  const [a, b] = n
  if (a === 127) return 'loopback'
  if (a === 10) return 'private'
  if (a === 172 && b >= 16 && b <= 31) return 'private'
  if (a === 192 && b === 168) return 'private'
  if (a === 169 && b === 254) return 'link-local'
  if (a === 100 && b >= 64 && b <= 127) return 'private' // CGNAT
  if (a === 0) return 'reserved'
  if (a >= 224) return 'reserved'
  return 'public'
}

function ipv6Kind(host) {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase()
  if (h === '::1') return 'loopback'
  if (h === '::') return 'reserved'
  // IPv4 映射地址（::ffff:127.0.0.1）
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h)
  if (mapped) return ipv4Kind(mapped[1])
  if (/^f[cd]/.test(h)) return 'private' // fc00::/7
  if (/^fe[89ab]/.test(h)) return 'link-local'
  return 'public'
}

function addressKind(address) {
  const family = net.isIP(address)
  if (family === 4) return ipv4Kind(address)
  if (family === 6) return ipv6Kind(address)
  return null
}

/** 同步的结构校验（不发 DNS），保存配置时先过这一关 */
export function inspectBaseUrl(raw) {
  let url
  try {
    url = new URL(String(raw || '').trim())
  } catch {
    return { ok: false, reason: 'Base URL 不是合法的 URL' }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: 'Base URL 必须以 http:// 或 https:// 开头' }
  }
  if (url.username || url.password) {
    return { ok: false, reason: 'Base URL 不能包含用户名或密码' }
  }
  const host = url.hostname.toLowerCase()
  if (BLOCKED_HOSTNAMES.has(host)) {
    return { ok: false, reason: `禁止访问 ${host}（云元数据地址）` }
  }
  // 字面量 IP 直接判定
  const literal = addressKind(host)
  if (literal === 'link-local' || literal === 'reserved') {
    return { ok: false, reason: `禁止访问链路本地/保留地址 ${host}` }
  }
  if (STRICT && (literal === 'loopback' || literal === 'private')) {
    return { ok: false, reason: `严格模式禁止访问内网地址 ${host}` }
  }
  return { ok: true, url, literal, private: literal === 'loopback' || literal === 'private' }
}

/**
 * 完整校验：结构 + DNS 解析后的实际地址。
 * 保存自定义服务商时调用，能提前发现打错的域名，也拦住解析到内网的公网域名。
 *
 * `rejectPrivate: true` 时连回环/内网一起拒绝（无视 STRICT_SSRF）。
 * 知识库入库允许内网源（用户自己贴的 Ollama / 局域网文档服务），
 * 但 **agent 工具** 的抓取对象来自模型输出——模型可能被页面内容诱导（提示注入），
 * 必须按最严格口径逐跳校验，两个场景不能共用一个默认值。
 */
export async function validateBaseUrl(raw, { timeoutMs = 3000, rejectPrivate = false } = {}) {
  const inspected = inspectBaseUrl(raw)
  if (!inspected.ok) return inspected
  if (rejectPrivate && inspected.private) {
    return { ok: false, reason: `禁止访问内网或回环地址 ${inspected.url.hostname}` }
  }

  const host = inspected.url.hostname.replace(/^\[|\]$/g, '')
  if (net.isIP(host)) return inspected

  let addresses
  try {
    addresses = await Promise.race([
      dns.lookup(host, { all: true, verbatim: true }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('DNS 解析超时')), timeoutMs)),
    ])
  } catch (err) {
    // 解析失败不代表一定有问题（离线环境、内网 DNS），放行但提示
    return { ok: true, url: inspected.url, dnsError: err?.message || 'DNS 解析失败' }
  }

  for (const { address } of addresses) {
    const kind = addressKind(address)
    if (kind === 'link-local' || kind === 'reserved') {
      return { ok: false, reason: `域名 ${host} 解析到被禁止的地址 ${address}` }
    }
    if ((rejectPrivate || STRICT) && (kind === 'loopback' || kind === 'private')) {
      return { ok: false, reason: `禁止 ${host} 解析到内网地址 ${address}` }
    }
  }
  return { ok: true, url: inspected.url, addresses: addresses.map((a) => a.address) }
}

/** 抛错版本，供路由层直接使用 */
export async function assertSafeBaseUrl(raw, options = {}) {
  const result = await validateBaseUrl(raw, options)
  if (!result.ok) {
    const err = new Error(result.reason)
    err.status = 400
    err.code = 'unsafe_base_url'
    throw err
  }
  return result
}
