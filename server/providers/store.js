import fs from 'node:fs'
import path from 'node:path'
import { config } from '../config.js'
import { readJsonSafe, writeJsonAtomic } from '../lib/atomic.js'
import { assertSafeBaseUrl, inspectBaseUrl } from '../lib/ssrf.js'
import { badRequest } from '../lib/errors.js'
import { logger } from '../lib/logger.js'

/**
 * 自定义服务商与模型覆盖的持久化。
 *
 * 文件里存着 API Key，所以：原子写（避免断电留下半截 JSON）、
 * 不进 git、出错时留档而不是静默丢配置。
 */

const DATA_DIR = config.storage.dataDir
const FILE = path.join(DATA_DIR, 'custom-providers.json')

/** 允许的协议类型，必须与 providers/stream.js 的 ADAPTERS 对齐 */
export const PROVIDER_TYPES = ['openai-compat', 'anthropic', 'gemini']

const EMPTY = () => ({ custom: [], modelOverrides: {} })

/** 配置里出现非 ASCII（常见于复制时带进全角标点）会让 fetch 抛难以理解的错，提前拦掉 */
const asciiOnly = (value) => !/[^\x00-\x7F]/.test(value)

/** 读缓存：文件没变就不重复读盘（每次请求会读好几次） */
let cache = { mtime: 0, data: null }

function normalizeShape(raw) {
  return {
    custom: Array.isArray(raw?.custom) ? raw.custom : [],
    modelOverrides: raw?.modelOverrides && typeof raw.modelOverrides === 'object' ? raw.modelOverrides : {},
  }
}

function readRaw() {
  let mtime = 0
  try {
    mtime = fs.statSync(FILE).mtimeMs
  } catch {
    return EMPTY()
  }
  if (cache.data && cache.mtime === mtime) return cache.data
  const data = normalizeShape(
    readJsonSafe(FILE, null, {
      onCorrupt: (err) => logger.error('自定义服务商配置损坏，已留档并重置', { file: FILE, message: err?.message }),
    })
  )
  cache = { mtime, data }
  return data
}

function writeRaw(data) {
  writeJsonAtomic(FILE, data)
  // 写完后让缓存失效，下次读盘拿到新 mtime
  try {
    cache = { mtime: fs.statSync(FILE).mtimeMs, data }
  } catch {
    cache = { mtime: 0, data: null }
  }
}

/** 校验并规整来自网页的提供商配置 */
function normalize(input, existing) {
  // 名称只用于界面展示，允许中文
  const name = String(input.name ?? '').trim()
  if (!name) throw badRequest('请填写服务商名称', 'invalid_name')
  if (name.length > 40) throw badRequest('服务商名称不能超过 40 个字符', 'invalid_name')

  const type = String(input.type ?? '')
  if (!PROVIDER_TYPES.includes(type)) throw badRequest(`协议类型必须是 ${PROVIDER_TYPES.join(' / ')}`, 'invalid_type')

  const baseUrl = String(input.baseUrl ?? '').trim().replace(/\/+$/, '')
  const inspected = inspectBaseUrl(baseUrl)
  if (!inspected.ok) throw badRequest(inspected.reason, 'invalid_base_url')
  if (!asciiOnly(baseUrl)) throw badRequest('Base URL 包含非 ASCII 字符（常见于全角标点）', 'non_ascii_config')

  // 前端留空表示「不修改已有密钥」，避免编辑时被迫重填
  const rawKey = input.apiKey == null ? '' : String(input.apiKey).trim()
  const apiKey = rawKey || existing?.apiKey || ''
  if (apiKey && !asciiOnly(apiKey)) throw badRequest('API Key 包含非 ASCII 字符（常见于全角标点）', 'non_ascii_config')

  const models = [...new Set(
    (Array.isArray(input.models) ? input.models : [])
      .map((m) => String(m).trim())
      .filter((m) => m && m.length <= 200)
  )].slice(0, 60)
  if (models.length === 0) throw badRequest('至少填写一个模型名称', 'missing_models')

  return { name, type, baseUrl, apiKey, models }
}

export function listCustom() {
  return readRaw().custom
}

export function findCustom(id) {
  return readRaw().custom.find((p) => p.id === id) || null
}

/** 新增或更新自定义提供商；不传 id 表示新增。异步是因为要校验域名解析结果 */
export async function upsertCustom(input) {
  const data = readRaw()
  const id = input.id ? String(input.id) : ''
  const existing = id ? data.custom.find((p) => p.id === id) : null
  if (id && !existing) throw badRequest('要修改的服务商不存在', 'provider_not_found')

  const normalized = normalize(input, existing)
  // 结构校验通过后再解析域名：拦住「公网域名解析到内网」这类绕过
  await assertSafeBaseUrl(normalized.baseUrl)

  const now = Date.now()
  if (existing) {
    Object.assign(existing, normalized, { updatedAt: now })
    writeRaw(data)
    return existing
  }

  const created = {
    id: `custom-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    ...normalized,
    createdAt: now,
    updatedAt: now,
  }
  data.custom.push(created)
  writeRaw(data)
  return created
}

export function removeCustom(id) {
  const data = readRaw()
  const before = data.custom.length
  data.custom = data.custom.filter((p) => p.id !== id)
  if (data.custom.length === before) throw badRequest('要删除的服务商不存在', 'provider_not_found')
  // 顺带清掉该提供商的模型覆盖，避免残留脏数据
  delete data.modelOverrides[id]
  writeRaw(data)
}

/** 覆盖任意提供商（含内置）的模型列表，免去改 .env 重启 */
export function setModelOverride(id, models) {
  const data = readRaw()
  const list = [...new Set(
    (Array.isArray(models) ? models : [])
      .map((m) => String(m).trim())
      .filter((m) => m && m.length <= 200)
  )].slice(0, 60)
  if (list.length === 0) delete data.modelOverrides[id]
  else data.modelOverrides[id] = list
  writeRaw(data)
  return list
}

export function getModelOverride(id) {
  const list = readRaw().modelOverrides[id]
  return Array.isArray(list) && list.length ? list : null
}

/** 供 registry 使用：把自定义提供商转成与内置一致的内部结构 */
export function customAsProviders() {
  return listCustom().map((p) => ({
    id: p.id,
    name: p.name,
    type: p.type,
    baseUrl: p.baseUrl,
    apiKey: p.apiKey,
    models: p.models,
    source: 'custom',
    // 自定义服务商由网页自行管理，无需判断 .env
    configured: true,
  }))
}

/** 测试用：清掉读缓存 */
export function resetStoreCache() {
  cache = { mtime: 0, data: null }
}
