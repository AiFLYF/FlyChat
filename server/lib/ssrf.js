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

/**
 * 展开成 8 个 16 位整数；非法返回 null。支持末尾内嵌 IPv4。
 *
 * 只认 `::ffff:7f00:1` 这种压缩写法是不够的——完整写法
 * `0:0:0:0:0:ffff:7f00:1` 同样能连到 127.0.0.1，漏判就是一个 SSRF 绕过。
 */
function expandIpv6(host) {
  let h = String(host || '').replace(/^\[|\]$/g, '').toLowerCase()
  if (h.includes('.')) {
    const idx = h.lastIndexOf(':')
    if (idx < 0) return null
    const v4 = parseIPv4(h.slice(idx + 1))
    if (!v4) return null
    h = h.slice(0, idx + 1) + `${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`
  }
  const parts = h.split('::')
  if (parts.length > 2) return null
  const left = parts[0] ? parts[0].split(':') : []
  const right = parts.length === 2 && parts[1] ? parts[1].split(':') : []
  const missing = 8 - left.length - right.length
  if (parts.length === 1 ? left.length !== 8 : missing < 0) return null
  const groups = parts.length === 2 ? [...left, ...Array(missing).fill('0'), ...right] : left
  const nums = groups.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN))
  return nums.some((n) => Number.isNaN(n)) ? null : nums
}

function ipv6Kind(host) {
  const g = expandIpv6(host)
  if (!g) return 'reserved'
  if (g.every((n) => n === 0)) return 'reserved'
  if (g.slice(0, 7).every((n) => n === 0) && g[7] === 1) return 'loopback'

  const hiZero = g.slice(0, 5).every((n) => n === 0)
  const v4 = (hi, lo) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`
  // IPv4 映射 ::ffff:0:0/96
  if (hiZero && g[5] === 0xffff) return ipv4Kind(v4(g[6], g[7]))
  // IPv4 兼容 ::/96（::127.0.0.1 的历史写法），:: 与 ::1 已在上方排除
  if (hiZero && g[5] === 0) return ipv4Kind(v4(g[6], g[7]))

  if ((g[0] & 0xfe00) === 0xfc00) return 'private' // fc00::/7
  if ((g[0] & 0xffc0) === 0xfe80) return 'link-local' // fe80::/10
  if ((g[0] & 0xff00) === 0xff00) return 'reserved' // ff00::/8 组播
  if (g[0] === 0x2001 && g[1] === 0x0db8) return 'reserved' // 2001:db8::/32 文档地址
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
  // URL.hostname 对 IPv6 会保留方括号（[::1]），必须先去掉，
  // 否则 net.isIP 返回 0，后面的字面量校验会被整体绕过。
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
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
  let timer
  try {
    addresses = await Promise.race([
      dns.lookup(host, { all: true, verbatim: true }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('DNS 解析超时')), timeoutMs)
      }),
    ])
    if (!addresses.length) throw new Error('DNS 未返回任何地址')
  } catch (err) {
    const dnsError = err?.message || 'DNS 解析失败'
    // 严格校验无法确认目标地址时必须拒绝，不能让后续 fetch 的 DNS 重试绕过检查。
    if (rejectPrivate || STRICT) {
      return { ok: false, reason: `无法验证 ${host} 的目标地址：${dnsError}`, dnsError }
    }
    // 默认保留离线/内网 DNS 配置场景的宽松策略，但向调用方提示。
    return { ok: true, url: inspected.url, dnsError }
  } finally {
    clearTimeout(timer)
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
