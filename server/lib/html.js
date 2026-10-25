/**
 * HTML → 纯文本。
 *
 * 为什么不引 readability / cheerio：
 * - 我们要的只是「把网页正文喂给模型/知识库」，不是像素级还原；
 * - 这两个库都带一串依赖，而本项目坚持「零多余依赖、单进程部署」。
 *
 * 这里做的是**结构性**清理：先干掉脚本/样式/导航等噪声块，
 * 再把块级标签转成换行、标题转成 Markdown 标记，最后解实体、压空白。
 * 比 `replace(/<[^>]+>/g,'')` 好得多——那种做法会把 `<style>` 里的 CSS
 * 和 `<script>` 里的 JS 一起当成正文喂给模型。
 */

/** 完全丢掉的标签（内容也一起丢） */
const DROP_BLOCKS = [
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'canvas',
  'iframe',
  'nav',
  'footer',
  'aside',
  'form',
  'button',
  'select',
]

const NAMED_ENTITIES = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  hellip: '…',
  mdash: '—',
  ndash: '–',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
  middot: '·',
  bull: '•',
  times: '×',
  divide: '÷',
  copy: '©',
  reg: '®',
  trade: '™',
  deg: '°',
  plusmn: '±',
  laquo: '«',
  raquo: '»',
  yen: '¥',
  euro: '€',
  pound: '£',
}

function decodeEntities(text) {
  return String(text)
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => {
      const code = parseInt(hex, 16)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''
    })
    .replace(/&#(\d+);/g, (_m, dec) => {
      const code = Number(dec)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''
    })
    .replace(/&([a-z][a-z0-9]*);/gi, (match, name) => {
      const key = String(name).toLowerCase()
      return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, key) ? NAMED_ENTITIES[key] : match
    })
}

/** 取 <title>；没有就返回空串 */
export function extractHtmlTitle(html) {
  const m = String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  if (!m) return ''
  return decodeEntities(m[1].replace(/\s+/g, ' ')).trim().slice(0, 200)
}

/** 整个 <head> 都不要（title 已经在 stripHead 之前单独取过了） */
function stripHead(html) {
  return String(html).replace(/<head[^>]*>[\s\S]*?<\/head>/i, ' ')
}

/**
 * @param {string} html
 * @param {{ keepTitle?: boolean }} [options] `keepTitle` 为 true 时把页面标题作为一级标题放在最前面
 */
export function htmlToText(html, { keepTitle = false } = {}) {
  let text = String(html || '')
  const title = keepTitle ? extractHtmlTitle(text) : ''
  text = stripHead(text)

  for (const tag of DROP_BLOCKS) {
    text = text.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi'), ' ')
  }
  text = text.replace(/<!--[\s\S]*?-->/g, ' ')

  // 标题保留层级信息：知识库切块时会用到「章节名」
  for (let level = 1; level <= 6; level += 1) {
    text = text.replace(
      new RegExp(`<h${level}\\b[^>]*>([\\s\\S]*?)<\\/h${level}>`, 'gi'),
      (_m, inner) => `\n\n${'#'.repeat(level)} ${inner}\n\n`
    )
  }

  text = text
    .replace(/<\/(p|div|section|article|main|li|tr|blockquote|pre|table|ul|ol|dl|dd|dt|figure)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '- ')
    .replace(/<t[dh]\b[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')

  text = decodeEntities(text)
    // 表格/列表转出来的行内会有一堆连续空格
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  if (title) return `# ${title}\n\n${text}`
  return text
}
