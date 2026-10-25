/**
 * 文档切块。
 *
 * 目标不是「切得均匀」，而是「切得能回答问题」：
 * - 按段落/标题边界切，别把一句话劈成两半；
 * - 每块带上所属章节标题，检索命中后模型知道这段在讲什么；
 * - 相邻块留一点重叠，避免答案正好卡在边界上被切断。
 */

const DEFAULT_MAX_CHARS = 900
const DEFAULT_OVERLAP = 120

/** 判断一行是不是 Markdown 标题，返回层级与文本 */
function parseHeading(line) {
  const m = /^(#{1,6})\s+(.*)$/.exec(line.trim())
  if (!m) return null
  return { level: m[1].length, text: m[2].trim() }
}

/**
 * 把长文本切成若干块。
 * @param {string} text
 * @param {{maxChars?: number, overlap?: number}} options
 * @returns {{text: string, heading: string, chars: number}[]}
 */
export function chunkText(text, { maxChars = DEFAULT_MAX_CHARS, overlap = DEFAULT_OVERLAP } = {}) {
  const source = String(text || '').replace(/\r\n/g, '\n').trim()
  if (!source) return []
  // 短文档不用切
  if (source.length <= maxChars) {
    return [{ text: source, heading: firstHeading(source) || '', chars: source.length }]
  }

  const lines = source.split('\n')
  const blocks = []
  let heading = ''
  let buffer = []

  const flushBuffer = () => {
    const text = buffer.join('\n').trim()
    if (text) blocks.push({ text, heading })
    buffer = []
  }

  for (const line of lines) {
    const h = parseHeading(line)
    if (h) {
      flushBuffer()
      // 用「上级标题 > 当前标题」的路径，深文档里更好定位
      heading = heading ? `${heading.split(' > ')[0]} > ${h.text}` : h.text
      continue
    }
    if (line.trim() === '') {
      flushBuffer()
      continue
    }
    buffer.push(line)
    // 单段过长（例如整篇没换行的 PDF）先按句子拆开
    if (buffer.join('').length > maxChars * 1.5) flushBuffer()
  }
  flushBuffer()

  // 把段落合并成不超过 maxChars 的块
  const chunks = []
  let current = ''
  let currentHeading = blocks[0]?.heading || ''

  const push = () => {
    const body = current.trim()
    if (!body) return
    chunks.push({ text: body, heading: currentHeading, chars: body.length })
  }

  for (const block of blocks) {
    if (block.heading && block.heading !== currentHeading) {
      push()
      current = ''
      currentHeading = block.heading
    }
    if (!current) {
      current = block.text
      continue
    }
    if (current.length + block.text.length + 2 <= maxChars) {
      current += `\n\n${block.text}`
      continue
    }
    // 装不下了：先落盘，再把上一块尾巴作为重叠带到下一块
    push()
    const tail = current.length > overlap ? current.slice(-overlap) : ''
    current = tail ? `${tail}\n\n${block.text}` : block.text
  }
  push()

  // 兜底：某一块仍然超长（单段特别长），按字符硬切
  const out = []
  for (const chunk of chunks) {
    if (chunk.chars <= maxChars * 1.6) {
      out.push(chunk)
      continue
    }
    for (let i = 0; i < chunk.text.length; i += maxChars) {
      const piece = chunk.text.slice(i, i + maxChars + overlap).trim()
      if (piece) out.push({ text: piece, heading: chunk.heading, chars: piece.length })
    }
  }
  return out
}

function firstHeading(text) {
  for (const line of String(text).split('\n').slice(0, 20)) {
    const h = parseHeading(line)
    if (h) return h.text
  }
  return ''
}

/**
 * 给切块加上「来源抬头」。
 * 这是检索质量的关键：模型看到「[文档: 年报 | 章节: 风险因素]」才知道这段话属于谁。
 */
export function decorateChunk(chunk, docName) {
  const meta = [`文档: ${docName || '未命名'}`]
  if (chunk.heading) meta.push(`章节: ${chunk.heading}`)
  return `【${meta.join(' | ')}】\n${chunk.text}`
}
