/**
 * 分享页的社交预览元信息（Open Graph / Twitter Card）。
 *
 * 为什么需要：前端是 SPA，`/s/:id` 默认回 index.html，里面只有一个 `<title>FlyChat</title>`。
 * 微信、Slack、Twitter、飞书这些抓取器**不执行 JS**，只能读 HTML 里的 meta——
 * 于是分享出去的链接永远是一张白卡片。这是「分享」这个功能最后一段没走通的路。
 *
 * 做法是「注入 meta」而不是「服务端渲染整页」：
 * 抓取器只要 meta，浏览器要的是 SPA。注入的改动面小得多，
 * 也不会和前端正在改的分享页 UI 打架。
 */

/** HTML 转义：分享标题来自用户输入，直接拼进 HTML 就是 XSS */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** 把 Markdown 痕迹去掉，只留适合做摘要的纯文本 */
function plainText(content) {
  return String(content || '')
    .replace(/```[\s\S]*?```/g, ' [代码] ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' [图片] ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^[#>\-*+\s]+/gm, '')
    .replace(/[*_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 截断到指定长度，尽量在标点处断开 */
function truncate(text, max = 150) {
  const s = String(text || '')
  if (s.length <= max) return s
  const cut = s.slice(0, max)
  const lastBreak = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('，'), cut.lastIndexOf(' '), cut.lastIndexOf('.'))
  return `${(lastBreak > max * 0.6 ? cut.slice(0, lastBreak) : cut).trim()}…`
}

/**
 * 从分享内容里推出标题与摘要。
 *
 * 密码保护 / 已过期的分享**不能泄露正文**——这两种情况只给通用文案。
 */
export function buildShareMeta(share) {
  const messages = Array.isArray(share?.messages) ? share.messages : []
  const firstUser = messages.find((m) => m?.role === 'user' && String(m.content || '').trim())
  const firstAssistant = messages.find((m) => m?.role === 'assistant' && String(m.content || '').trim())

  const locked = !!share?.hasPassword
  const title = share?.title ? String(share.title).slice(0, 80) : '一段对话'

  if (locked) {
    return {
      title: '一段加密分享的对话',
      description: '这条分享需要密码才能查看。',
      noindex: true,
    }
  }

  // 摘要优先用首条用户提问（它最能说明「这段对话在聊什么」），
  // 没有再退回助手的第一段回答
  const source = plainText(firstUser?.content) || plainText(firstAssistant?.content)
  const count = messages.length
  const description = source
    ? truncate(source, 150)
    : `共 ${count} 条消息的 AI 对话`

  return { title, description, noindex: false, messageCount: count, model: share?.model || null }
}

/** 生成要注入 <head> 的 meta 标签串（已经过 HTML 转义） */
export function renderMetaTags(meta, { url, siteName = 'FlyChat' } = {}) {
  const tags = []
  const push = (attr, key, value) => {
    if (value === undefined || value === null || value === '') return
    tags.push(`<meta ${attr}="${key}" content="${escapeHtml(value)}" />`)
  }

  push('property', 'og:type', 'article')
  push('property', 'og:site_name', siteName)
  push('property', 'og:title', meta.title)
  push('property', 'og:description', meta.description)
  push('property', 'og:locale', 'zh_CN')
  if (url) push('property', 'og:url', url)

  push('name', 'twitter:card', 'summary')
  push('name', 'twitter:title', meta.title)
  push('name', 'twitter:description', meta.description)

  // 微信不认 twitter card，但认 description + 首图；没有图也能显示标题与摘要
  push('name', 'description', meta.description)
  if (meta.noindex) tags.push('<meta name="robots" content="noindex, nofollow" />')

  return tags.join('\n    ')
}

/**
 * 把 meta 注入到已有的 HTML 里。
 *
 * 只替换 `<title>` 并在 `</head>` 前插入——不重排整个文档，
 * 这样前端改 index.html 时不会和这里打架。
 */
export function injectMeta(html, meta, options = {}) {
  const safeTitle = escapeHtml(meta.title)
  const tags = renderMetaTags(meta, options)
  let out = String(html)

  if (/<title>[\s\S]*?<\/title>/i.test(out)) {
    out = out.replace(/<title>[\s\S]*?<\/title>/i, `<title>${safeTitle}</title>`)
  } else {
    out = out.replace(/<\/head>/i, `  <title>${safeTitle}</title>\n  </head>`)
  }

  if (tags) {
    out = out.replace(/<\/head>/i, `    ${tags}\n  </head>`)
  }
  return out
}
