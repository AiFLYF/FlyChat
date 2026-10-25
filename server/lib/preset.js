/**
 * 预设 → 请求参数 的解析。
 *
 * 设计原则：**预设是默认值，不是强制值。**
 * 用户选了某个预设之后，仍然可以在界面上临时改模型、改温度、关掉联网——
 * 这些显式传上来的字段必须覆盖预设，否则「预设」就变成了枷锁。
 *
 * 服务端做这件事（而不是让前端自己拼好再发）有两个好处：
 * 1. `/v1` 的第三方客户端也能用预设（`model: "preset:xxx"`），不用改客户端；
 * 2. 预设的定义只有一份，不会出现「前端按 A 版本拼、后端按 B 版本存」的漂移。
 */

/** 显式传了「有内容的值」才算覆盖；空字符串 / null / undefined 都算没传 */
function given(value) {
  if (value === undefined || value === null) return false
  if (typeof value === 'string') return value.trim() !== ''
  return true
}

/**
 * @param {object} body 请求体
 * @param {object|null} preset `store/presets.js#getPreset` 的结果
 * @returns {object} 合并后的请求体（不改原对象）
 */
export function applyPreset(body, preset) {
  if (!preset) return body
  const p = preset.params || {}
  const merged = { ...body }

  // 模型：请求里指定了就用请求的（比如临时换成更强的模型），否则用预设的
  if (!given(body.provider) && preset.provider) merged.provider = preset.provider
  if (!given(body.model) && preset.model) merged.model = preset.model

  // 系统提示：请求里带了就完全以请求为准（避免「预设的提示 + 请求里的提示」被拼两遍）
  if (!given(body.system) && preset.systemPrompt) merged.system = preset.systemPrompt

  // 采样参数逐项覆盖
  for (const key of ['temperature', 'topP', 'maxTokens', 'think', 'webSearch', 'agent', 'tools', 'imageGeneration']) {
    if (body[key] === undefined && p[key] !== undefined) merged[key] = p[key]
  }

  // 知识库：预设绑了库就用它；但请求里显式 `knowledge: false` 表示这一轮不检索
  if (body.workspaceId === undefined && body.knowledge === undefined && preset.workspaceId) {
    merged.workspaceId = preset.workspaceId
  }
  if (body.topK === undefined && p.topK !== undefined) merged.topK = p.topK

  // MCP：`mcpMode` 决定「用全部已启用 server」还是「只用预设挑的那几个」
  if (body.mcpServers === undefined && p.mcpMode === 'selected') {
    merged.mcpServers = Array.isArray(preset.mcpServers) ? preset.mcpServers : []
  }

  merged.presetId = preset.id
  return merged
}

/**
 * 把 `/v1` 的 `model` 字段解析成「预设 or provider:model」。
 *
 * 支持三种写法：
 *   `preset:<id>`      → 用该预设（模型、参数、提示、工具全都按预设来）
 *   `provider:model`   → 直接指定服务商与模型（原有行为）
 *   `model`            → 只有一个名字，交给原有逻辑猜服务商
 */
export function parseModelRef(raw) {
  const spec = String(raw || '').trim()
  if (spec.startsWith('preset:')) return { presetId: spec.slice('preset:'.length) }
  return { spec }
}
