import { FileText, X } from 'lucide-react'
import { formatBytes } from '../lib/files'
import type { Attachment } from '../types'

/**
 * 附件行的公共布局：三处（图片、文档、待发送附件）原本各写一遍
 * 「mb-2 flex flex-wrap gap-2」，集中成常量后改间距只需动一处。
 */
const ROW = 'mb-2 flex flex-wrap gap-2'

/** 消息中的图片：缩略图，点击看大图 */
function MessageImages({ images }: { images: Attachment[] }) {
  if (!images.length) return null
  return (
    <div className={ROW}>
      {images.map((a) => (
        <a
          key={a.id}
          href={a.dataUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="block overflow-hidden rounded-xl border border-rule transition-shadow duration-200 ease-out hover:shadow-2"
        >
          <img
            src={a.thumbnail || a.dataUrl}
            alt={a.name}
            loading="lazy"
            className="max-h-52 max-w-[240px] object-cover transition-transform duration-300 ease-out hover:scale-[1.02]"
          />
        </a>
      ))}
    </div>
  )
}

/** 消息中的文档：文件条 */
function MessageFiles({ files }: { files: Attachment[] }) {
  if (!files.length) return null
  return (
    <div className={ROW}>
      {files.map((a) => (
        <div
          key={a.id}
          className="flex items-center gap-2 rounded-lg border border-rule bg-panel px-2.5 py-1.5 transition-ui hover-lift hover:border-rule-strong"
          title={a.name}
        >
          <FileText size={14} className="shrink-0 text-ink-3" aria-hidden />
          <span className="max-w-[180px] truncate text-xs text-ink-2">{a.name}</span>
          <span className="tnum shrink-0 text-[11px] text-ink-3">
            {a.text ? `${a.text.length} 字` : formatBytes(a.size)}
          </span>
        </div>
      ))}
    </div>
  )
}

/** 消息里展示的附件 */
export function MessageAttachments({ attachments }: { attachments?: Attachment[] }) {
  if (!attachments?.length) return null
  const images = attachments.filter((a) => a.type === 'image')
  const files = attachments.filter((a) => a.type === 'file')
  return (
    <>
      <MessageImages images={images} />
      <MessageFiles files={files} />
    </>
  )
}

/** 输入框上方的待发送附件（可移除） */
export function ComposerAttachments({
  attachments,
  onRemove,
}: {
  attachments: Attachment[]
  onRemove: (id: string) => void
}) {
  if (!attachments.length) return null
  return (
    <div className={ROW}>
      {attachments.map((a) => (
        <div
          key={a.id}
          className="anim-scale-in group/att relative flex items-center gap-2 rounded-lg border border-rule bg-panel py-1.5 pl-2 pr-6"
        >
          {a.type === 'image' ? (
            <img src={a.thumbnail || a.dataUrl} alt={a.name} className="h-8 w-8 rounded object-cover" />
          ) : (
            <FileText size={16} className="text-ink-3" aria-hidden />
          )}
          <div className="min-w-0">
            <p className="max-w-[160px] truncate text-xs text-ink-1">{a.name}</p>
            <p className="tnum text-[11px] text-ink-3">
              {a.type === 'file' && a.text ? `${a.text.length} 字` : formatBytes(a.size)}
            </p>
          </div>
          <button
            onClick={() => onRemove(a.id)}
            className="r-sm absolute right-1 top-1 flex h-5 w-5 items-center justify-center text-ink-3 transition-ui press hover:bg-hover hover:text-danger"
            aria-label={`移除附件 ${a.name}`}
          >
            <X size={12} />
          </button>
        </div>
      ))}
    </div>
  )
}
