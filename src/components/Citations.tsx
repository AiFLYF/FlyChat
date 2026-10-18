import { ExternalLink, Globe } from 'lucide-react'
import type { Citation } from '../types'

/** 从 URL 中取出展示用二级域名 */
function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url.replace(/^https?:\/\//, '').split('/')[0]
  }
}

/** 获取 Google Favicon 服务地址 */
function faviconOf(url: string): string {
  try {
    const domain = new URL(url).hostname
    return `https://www.google.com/s2/favicons?domain=${domain}&sz=32`
  } catch {
    return ''
  }
}

/**
 * SOTA 级联网搜索引用来源（Perplexity / Claude 风格横向卡片流）
 * 包含站点 Favicon、清晰域名标识、序号标签、悬浮摘要卡片与外部打开图标。
 */
export default function Citations({ citations }: { citations?: Citation[] }) {
  if (!citations?.length) return null

  return (
    <div className="anim-fade-in mt-3.5 border-t border-rule/70 pt-3">
      <div className="mb-2 flex items-center justify-between text-[11px] font-medium text-ink-3">
        <span className="flex items-center gap-1.5">
          <Globe size={12} className="text-accent" />
          <span>参考来源 ({citations.length})</span>
        </span>
      </div>

      {/* 横向滚动胶囊卡片流 */}
      <div className="flex gap-2 overflow-x-auto pb-1.5 pt-0.5 no-scrollbar">
        {citations.map((c, i) => {
          const domain = domainOf(c.url)
          const iconUrl = faviconOf(c.url)

          return (
            <div key={c.index || i} className="group/cite relative shrink-0">
              <a
                href={c.url}
                target="_blank"
                rel="noopener noreferrer"
                className="press flex h-8 items-center gap-2 rounded-xl border border-rule/80 bg-panel px-2.5 text-xs text-ink-2 shadow-sm transition-all hover:border-accent/50 hover:bg-hover hover:text-ink-1 hover:shadow-1"
                title={`${c.title} (${domain})`}
              >
                {/* 序号 */}
                <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-canvas text-[10px] font-semibold text-ink-3">
                  {c.index}
                </span>

                {/* Favicon */}
                {iconUrl && (
                  <img
                    src={iconUrl}
                    alt=""
                    aria-hidden
                    className="h-3.5 w-3.5 shrink-0 rounded-sm object-contain"
                    onError={(e) => {
                      ;(e.currentTarget as HTMLElement).style.display = 'none'
                    }}
                  />
                )}

                {/* 标题与域名 */}
                <span className="max-w-[130px] truncate text-[11px] font-medium text-ink-1 sm:max-w-[160px]">
                  {c.title}
                </span>

                <ExternalLink size={10} className="shrink-0 text-ink-3 group-hover/cite:text-accent" />
              </a>

              {/* 悬浮丰富摘要浮层 */}
              {c.content && (
                <div
                  aria-hidden
                  className="pointer-events-none absolute bottom-full left-0 z-40 mb-2 hidden w-72 rounded-xl border border-rule bg-panel p-3 text-left text-xs shadow-3 backdrop-blur-md group-hover/cite:block group-focus-within/cite:block sm:w-80"
                >
                  <div className="mb-1.5 flex items-center gap-1.5 font-medium text-ink-1">
                    {iconUrl && (
                      <img
                        src={iconUrl}
                        alt=""
                        className="h-3.5 w-3.5 rounded-sm object-contain"
                        onError={(e) => {
                          ;(e.currentTarget as HTMLElement).style.display = 'none'
                        }}
                      />
                    )}
                    <span className="truncate">{c.title}</span>
                  </div>
                  <div className="mb-2 text-[10px] text-ink-3">{domain}</div>
                  <p className="line-clamp-4 leading-relaxed text-ink-2/90 text-[11px]">
                    {c.content}
                  </p>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
