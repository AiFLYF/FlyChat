import { parseDataUrl } from './providers/format.js'
import { logger } from './lib/logger.js'
import { htmlToText, extractHtmlTitle } from './lib/html.js'
import { assertSafeBaseUrl } from './lib/ssrf.js'

/** 抽取文本上限，避免超长文档撑爆上下文 */
const MAX_CHARS = 200000
/** CSV 转表格时的行列上限，避免超宽表把上下文撑爆 */
const MAX_TABLE_ROWS = 200
const MAX_TABLE_COLS = 20

/** 纯文本类扩展名（按内容直接读取） */
const TEXT_EXT = new Set([
  // 文档
  'txt', 'md', 'markdown', 'rst', 'log', 'ini', 'cfg', 'conf', 'properties', 'env',
  // 数据 / 配置
  'json', 'jsonc', 'yaml', 'yml', 'toml', 'xml', 'html', 'htm', 'css', 'scss', 'less',
  // 代码
  'py', 'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'vue', 'svelte',
  'java', 'go', 'rs', 'rb', 'php', 'c', 'h', 'cpp', 'hpp', 'cc', 'cs',
  'swift', 'kt', 'kts', 'scala', 'sh', 'bash', 'zsh', 'ps1', 'bat', 'cmd', 'sql',
  'dockerfile', 'makefile', 'gradle', 'lua', 'r', 'pl', 'dart', 'ex', 'exs',
])

/** 分隔符表格类扩展名 */
const TABLE_EXT = new Set(['csv', 'tsv'])

function detectKind(mime, ext) {
  if (mime === 'application/pdf' || ext === 'pdf') return 'pdf'
  if (ext === 'docx' || mime.includes('officedocument.wordprocessingml')) return 'docx'
  if (ext === 'doc') return 'doc'
  if (ext === 'pptx' || mime.includes('officedocument.presentationml')) return 'pptx'
  if (ext === 'ppt') return 'ppt'
  if (ext === 'xlsx' || mime.includes('officedocument.spreadsheetml')) return 'xlsx'
  if (ext === 'xls') return 'xls'
  if (ext === 'html' || ext === 'htm' || mime === 'text/html') return 'html'
  if (TABLE_EXT.has(ext)) return 'table'
  if (mime === 'text/csv') return 'table'
  if (mime === 'text/tab-separated-values') return 'table'
  if (TEXT_EXT.has(ext)) return 'text'
  if (/^(text\/|application\/(json|xml|x-yaml|yaml|javascript|typescript))/.test(mime)) return 'text'
  if (mime.startsWith('image/')) return 'image'
  return 'unknown'
}

/**
 * 重型解析库按需加载。
 * pdf-parse / mammoth 加起来几 MB，冷启动就加载它们纯属浪费；
 * 更重要的是：某个可选依赖装坏了不该让整个服务起不来。
 */
async function loadPdfParser() {
  try {
    const mod = await import('pdf-parse')
    return mod.PDFParse || mod.default?.PDFParse || mod.default
  } catch (err) {
    logger.error('PDF 解析库加载失败', { message: err?.message })
    throw new Error('PDF 解析组件未正确安装，请重新执行 npm install')
  }
}

async function loadMammoth() {
  try {
    const mod = await import('mammoth')
    return mod.default || mod
  } catch (err) {
    logger.error('DOCX 解析库加载失败', { message: err?.message })
    throw new Error('DOCX 解析组件未正确安装，请重新执行 npm install')
  }
}

async function extractPdf(buffer) {
  const PDFParse = await loadPdfParser()
  const parser = new PDFParse({ data: new Uint8Array(buffer) })
  try {
    const result = await parser.getText()
    return result?.text || ''
  } finally {
    try {
      await parser.destroy?.()
    } catch {
      /* ignore */
    }
  }
}

async function extractDocx(buffer) {
  const mammoth = await loadMammoth()
  const result = await mammoth.extractRawText({ buffer })
  return result?.value || ''
}

/**
 * zip 容器（docx/pptx/xlsx 都是 zip + XML）。
 * 用 mammoth 的传递依赖 jszip —— 它已经是直接依赖 mammoth 的依赖树的一部分，
 * 不需要额外安装；万一将来没了，这里会给出可执行的提示而不是崩在深处。
 */
async function loadZip() {
  try {
    const mod = await import('jszip')
    return mod.default || mod
  } catch (err) {
    logger.error('ZIP 解析库加载失败', { message: err?.message })
    throw new Error('ZIP 解析组件不可用，请重新执行 npm install')
  }
}

async function openZip(buffer) {
  const JSZip = await loadZip()
  return JSZip.loadAsync(buffer)
}

/** 从 XML 里取出所有 <a:t>…</a:t>（PPT 的文本节点） */
function pptTextFromSlide(xml) {
  const parts = []
  const re = /<a:t[^>]*>([\s\S]*?)<\/a:t>/g
  let m
  while ((m = re.exec(xml))) {
    const text = decodeXmlEntities(m[1])
    if (text.trim()) parts.push(text)
  }
  return parts.join(' ')
}

function decodeXmlEntities(text) {
  return String(text)
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/**
 * PPTX：按页抽文本。
 * 只取 `<a:t>` 文本节点——形状、图片、动画都不要，知识库要的是「这页讲了什么」。
 */
async function extractPptx(buffer) {
  const zip = await openZip(buffer)
  const slideNames = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => {
      const na = Number(a.match(/(\d+)\.xml$/)?.[1] || 0)
      const nb = Number(b.match(/(\d+)\.xml$/)?.[1] || 0)
      return na - nb
    })
  if (slideNames.length === 0) throw new Error('这个 PPTX 里没有找到幻灯片')

  const out = []
  for (let i = 0; i < slideNames.length; i += 1) {
    const xml = await zip.file(slideNames[i]).async('string')
    const text = pptTextFromSlide(xml)
    if (text.trim()) out.push(`## 第 ${i + 1} 页\n\n${text}`)
  }
  return out.join('\n\n')
}

/** 列字母 → 0 基索引（A→0, AA→26） */
function columnIndex(ref) {
  const letters = String(ref || '').match(/^[A-Z]+/i)?.[0] || ''
  let n = 0
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

/** sharedStrings.xml → 字符串数组 */
function parseSharedStrings(xml) {
  if (!xml) return []
  const out = []
  const siRe = /<si[^>]*>([\s\S]*?)<\/si>/g
  let m
  while ((m = siRe.exec(xml))) {
    // 一个 <si> 里可能有多个 <r><t>，要拼起来（富文本）
    const texts = []
    const tRe = /<t[^>]*>([\s\S]*?)<\/t>/g
    let t
    while ((t = tRe.exec(m[1]))) texts.push(decodeXmlEntities(t[1]))
    out.push(texts.join(''))
  }
  return out
}

/** 单个 worksheet.xml → 二维数组 */
function parseSheet(xml, shared) {
  const rows = []
  const rowRe = /<row[^>]*>([\s\S]*?)<\/row>/g
  let rm
  while ((rm = rowRe.exec(xml))) {
    const cells = []
    const cellRe = /<c\b([^>]*)>([\s\S]*?)<\/c>|<c\b([^>]*)\/>/g
    let cm
    while ((cm = cellRe.exec(rm[1]))) {
      const attrs = cm[1] || cm[3] || ''
      const body = cm[2] || ''
      const ref = attrs.match(/\br="([A-Z]+\d+)"/i)?.[1]
      const type = attrs.match(/\bt="([^"]+)"/)?.[1]
      const idx = ref ? columnIndex(ref) : cells.length

      let value = ''
      if (type === 's') {
        const v = body.match(/<v>([\s\S]*?)<\/v>/)?.[1]
        value = shared[Number(v)] ?? ''
      } else if (type === 'inlineStr') {
        value = decodeXmlEntities(body.match(/<t[^>]*>([\s\S]*?)<\/t>/)?.[1] || '')
      } else if (type === 'b') {
        value = body.includes('<v>1</v>') ? 'TRUE' : 'FALSE'
      } else {
        value = decodeXmlEntities(body.match(/<v>([\s\S]*?)<\/v>/)?.[1] || '')
      }
      cells[idx] = value
    }
    if (cells.some((c) => String(c ?? '').trim() !== '')) rows.push(cells)
  }
  return rows
}

/**
 * XLSX：每个工作表转成一张 Markdown 表格。
 *
 * 说明：日期在 xlsx 里是序列号（45000 这种），要还原成日期得读样式表判断格式。
 * 这里不猜——原样保留数字，比猜错成 1970 年安全。需要日期可让用户在导出时格式化。
 */
async function extractXlsx(buffer) {
  const zip = await openZip(buffer)
  const shared = parseSharedStrings(await zip.file('xl/sharedStrings.xml')?.async('string'))

  // 工作表顺序：优先按 workbook.xml 里的 r:id 顺序，取不到就按文件名数字序
  let sheetFiles = Object.keys(zip.files).filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
  const workbookXml = await zip.file('xl/workbook.xml')?.async('string')
  const sheetNames = []
  if (workbookXml) {
    const re = /<sheet\b[^>]*\bname="([^"]*)"[^>]*\/>/g
    let m
    while ((m = re.exec(workbookXml))) sheetNames.push(decodeXmlEntities(m[1]))
  }
  sheetFiles = sheetFiles.sort((a, b) => {
    const na = Number(a.match(/(\d+)\.xml$/)?.[1] || 0)
    const nb = Number(b.match(/(\d+)\.xml$/)?.[1] || 0)
    return na - nb
  })
  if (sheetFiles.length === 0) throw new Error('这个 XLSX 里没有找到工作表')

  const blocks = []
  for (let i = 0; i < sheetFiles.length; i += 1) {
    const xml = await zip.file(sheetFiles[i]).async('string')
    const rows = parseSheet(xml, shared)
    if (rows.length === 0) continue
    const name = sheetNames[i] || `工作表 ${i + 1}`
    blocks.push(`## ${name}\n\n${toMarkdownTable(rows)}`)
  }
  if (blocks.length === 0) throw new Error('这个 XLSX 里没有可用数据')
  return blocks.join('\n\n')
}

/**
 * 解析分隔符表格（兼容引号包裹、引号转义、字段内换行）
 * 实现参考 RFC 4180 的常用子集。
 */
function parseDelimited(text, delim) {
  const rows = []
  let row = []
  let field = ''
  let inQuotes = false

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 1
        } else {
          inQuotes = false
        }
      } else {
        field += ch
      }
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === delim) {
      row.push(field)
      field = ''
    } else if (ch === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else if (ch !== '\r') {
      field += ch
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  // 丢弃完全空白的行
  return rows.filter((r) => r.some((c) => c.trim() !== ''))
}

/** 猜测分隔符：制表符优先，其次逗号、分号 */
function sniffDelimiter(text, ext) {
  if (ext === 'tsv') return '\t'
  if (ext === 'csv') return ','
  const firstLine = text.split(/\r?\n/, 1)[0] || ''
  const counts = { '\t': 0, ',': 0, ';': 0 }
  for (const ch of firstLine) {
    if (ch in counts) counts[ch] += 1
  }
  let best = ','
  for (const ch of ['\t', ',', ';']) {
    if (counts[ch] > counts[best]) best = ch
  }
  return counts[best] > 0 ? best : ','
}

function escapeCell(value) {
  return String(value).replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ').trim()
}

/** 把二维数组转成 Markdown 表格（首行作表头） */
function toMarkdownTable(rows) {
  const colCount = Math.min(
    rows.reduce((max, r) => Math.max(max, r.length), 0),
    MAX_TABLE_COLS
  )
  if (colCount === 0) return ''

  const rowLimit = Math.min(rows.length, MAX_TABLE_ROWS + 1) // +1 给表头
  const header = rows[0]
  const lines = []
  lines.push(`| ${Array.from({ length: colCount }, (_, i) => escapeCell(header[i] ?? `列${i + 1}`)).join(' | ')} |`)
  lines.push(`| ${Array.from({ length: colCount }, () => '---').join(' | ')} |`)
  for (let r = 1; r < rowLimit; r += 1) {
    lines.push(
      `| ${Array.from({ length: colCount }, (_, i) => escapeCell(rows[r][i] ?? '')).join(' | ')} |`
    )
  }

  const notes = []
  if (rows.length > rowLimit) notes.push(`仅展示前 ${rowLimit - 1} 行，共 ${rows.length - 1} 行数据`)
  const maxCols = rows.reduce((max, r) => Math.max(max, r.length), 0)
  if (maxCols > MAX_TABLE_COLS) notes.push(`仅展示前 ${MAX_TABLE_COLS} 列，共 ${maxCols} 列`)
  if (notes.length) lines.push('', `> 表格已截断：${notes.join('；')}`)

  return lines.join('\n')
}

/** 分隔符文件转 Markdown 表格；解析失败则回退为原文 */
function tableToMarkdown(text, ext) {
  const delim = sniffDelimiter(text, ext)
  const rows = parseDelimited(text, delim)
  if (rows.length < 2) return text
  return toMarkdownTable(rows)
}

const SUPPORTED_HINT =
  '支持 PDF、DOCX、PPTX、XLSX、图片，以及 txt / md / csv / tsv / json / yaml / xml / html 与常见代码文件'

/**
 * 粗判二进制：UTF-8 解码失败会产生大量替换字符（U+FFFD）。
 * 用于兜住「扩展名/MIME 被误判为文本」的情况，避免把乱码喂给模型。
 */
function looksBinary(text) {
  if (text.length < 40) return false
  let bad = 0
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 0xfffd) bad += 1
  }
  return bad / text.length > 0.02
}

/**
 * 从上传的文件中抽取纯文本。
 * @param {{ name?: string, mime?: string, dataUrl: string }} file
 * @returns {Promise<{ text: string, chars: number, truncated: boolean, kind: string }>}
 */
export async function extractText(file) {
  let buffer
  let parsedMime = file.mime || ""
  if (file.buffer) {
    // 异步流水线直接传 Buffer，省一次 base64 往返
    buffer = Buffer.isBuffer(file.buffer) ? file.buffer : Buffer.from(file.buffer)
  } else {
    const parsed = parseDataUrl(file.dataUrl)
    if (!parsed) throw new Error('无法解析文件数据')
    buffer = Buffer.from(parsed.data, parsed.isBase64 ? 'base64' : 'utf8')
    parsedMime = parsedMime || parsed.mime || ""
  }

  const ext = (file.name || '').split('.').pop()?.toLowerCase() || ''
  const kind = detectKind(parsedMime || "", ext)

  let text = ''
  if (kind === 'table') {
    const raw = buffer.toString('utf8').replace(/^\uFEFF/, '')
    if (looksBinary(raw)) throw new Error(`「${file.name || '文件'}」看起来是二进制文件，无法作为文本解析`)
    text = tableToMarkdown(raw, ext)
  } else if (kind === 'text') {
    const raw = buffer.toString('utf8').replace(/^\uFEFF/, '')
    if (looksBinary(raw)) throw new Error(`「${file.name || '文件'}」看起来是二进制文件，无法作为文本解析`)
    text = raw
  } else if (kind === 'pdf') {
    text = await extractPdf(buffer)
  } else if (kind === 'docx') {
    text = await extractDocx(buffer)
  } else if (kind === 'pptx') {
    text = await extractPptx(buffer)
  } else if (kind === 'xlsx') {
    text = await extractXlsx(buffer)
  } else if (kind === 'doc') {
    throw new Error('旧版 .doc 暂不支持，请另存为 .docx 或 PDF 后再上传')
  } else if (kind === 'ppt') {
    throw new Error('旧版 .ppt 暂不支持，请另存为 .pptx 或 PDF 后再上传')
  } else if (kind === 'xls') {
    throw new Error('旧版 .xls 暂不支持，请另存为 .xlsx 或 CSV 后再上传')
  } else if (kind === 'html') {
    // 直接丢原始 HTML 给模型，等于把 <style> 里的 CSS 和 <script> 里的 JS 也喂进去
    text = htmlToText(buffer.toString('utf8'), { keepTitle: true })
  } else if (kind === 'image') {
    throw new Error('图片请直接作为图片附件上传')
  } else {
    throw new Error(`暂不支持的文件类型：${ext || file.mime || '未知'}。${SUPPORTED_HINT}`)
  }

  text = text.replace(/\u0000/g, '').trim()
  const truncated = text.length > MAX_CHARS
  if (truncated) text = text.slice(0, MAX_CHARS)
  return { text, chars: text.length, truncated, kind }
}

/* ——— 网页入库：把一个 URL 抓下来变成文本 ——— */

const URL_TIMEOUT_MS = 20_000
const URL_MAX_BYTES = 8 * 1024 * 1024
const URL_MAX_REDIRECTS = 3

/**
 * 边读边计数，避免一个超大响应把内存打爆。
 * 只看 Content-Length 不可靠——很多服务器不给，或者给的是压缩前的长度。
 */
async function readBodyLimited(response, maxBytes) {
  const reader = response.body?.getReader()
  if (!reader) return Buffer.alloc(0)
  const chunks = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > maxBytes) {
      try {
        await reader.cancel()
      } catch {
        /* ignore */
      }
      throw new Error(`网页内容超过 ${Math.round(maxBytes / 1024 / 1024)}MB 上限，无法入库`)
    }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks)
}

/**
 * 手动跟随重定向，每一跳都过 SSRF 校验。
 *
 * 为什么不用 `redirect: 'follow'`：那样只会校验初始 URL，
 * 攻击者可以让公网地址 302 到 127.0.0.1 / 169.254.169.254，把内网内容读进来。
 */
async function fetchFollowingSafely(startUrl, { signal } = {}) {
  let current = String(startUrl).trim()
  for (let hop = 0; hop <= URL_MAX_REDIRECTS; hop += 1) {
    await assertSafeBaseUrl(current)
    const res = await fetch(current, {
      redirect: 'manual',
      signal: signal || AbortSignal.timeout(URL_TIMEOUT_MS),
      headers: {
        // 有些站点不给 UA 直接 403
        'User-Agent': 'Mozilla/5.0 (compatible; FlyChat/1.0; +https://github.com/)',
        Accept: 'text/html,application/xhtml+xml,application/pdf,text/plain;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
    })

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location')
      if (!location) throw new Error(`重定向缺少 Location（HTTP ${res.status}）`)
      current = new URL(location, current).toString()
      continue
    }
    return { response: res, finalUrl: current }
  }
  throw new Error('重定向次数过多')
}

/**
 * 抓一个网页（或直链文件）并抽取文本。
 *
 * 支持：HTML（转纯文本）、PDF、以及 txt/json/xml/csv 这类纯文本。
 * @returns {Promise<{ text: string, title?: string, finalUrl: string, mime: string, kind: string }>}
 */
export async function extractUrl(url, { signal } = {}) {
  const { response, finalUrl } = await fetchFollowingSafely(url, { signal })
  if (!response.ok) {
    throw new Error(`抓取失败：HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`)
  }

  const mime = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
  const buffer = await readBodyLimited(response, URL_MAX_BYTES)

  // 按内容类型决定怎么解析；拿不到类型就按扩展名猜
  const extFromUrl = (() => {
    try {
      const p = new URL(finalUrl).pathname
      const m = p.match(/\.([a-z0-9]{1,5})$/i)
      return m ? m[1].toLowerCase() : ''
    } catch {
      return ''
    }
  })()

  let text = ''
  let kind = 'html'
  if (mime === 'application/pdf' || extFromUrl === 'pdf') {
    kind = 'pdf'
    text = await extractPdf(buffer)
  } else if (mime === 'text/html' || mime === 'application/xhtml+xml' || (!mime && !extFromUrl)) {
    kind = 'html'
    const raw = buffer.toString('utf8')
    text = htmlToText(raw, { keepTitle: true })
  } else if (mime.startsWith('text/') || mime === 'application/json' || mime === 'application/xml') {
    kind = mime === 'text/csv' ? 'table' : 'text'
    const raw = buffer.toString('utf8').replace(/^\uFEFF/, '')
    if (looksBinary(raw)) throw new Error('这个链接指向的是二进制内容，无法作为文本入库')
    text = kind === 'table' ? tableToMarkdown(raw, 'csv') : raw
  } else {
    throw new Error(`这个链接的内容类型（${mime || '未知'}）暂不支持入库`)
  }

  text = String(text || '').replace(/\u0000/g, '').trim()
  if (!text) throw new Error('这个网页没有可提取的正文（可能是纯前端渲染的页面）')

  const truncated = text.length > MAX_CHARS
  if (truncated) text = text.slice(0, MAX_CHARS)

  return {
    text,
    title: extractHtmlTitle(buffer.toString('utf8')),
    finalUrl,
    mime: mime || 'text/html',
    kind,
    chars: text.length,
    truncated,
  }
}
