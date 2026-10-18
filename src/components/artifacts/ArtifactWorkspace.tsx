import { useState, useRef, useMemo } from 'react'
import {
  Code2,
  Copy,
  Download,
  Eye,
  Maximize2,
  Minimize2,
  Monitor,
  RotateCw,
  Smartphone,
  Tablet,
  X,
  Check,
  Layers,
  Sparkles,
} from 'lucide-react'
import { useArtifactStore } from '../../store/artifact'

export default function ArtifactWorkspace() {
  const open = useArtifactStore((s) => s.open)
  const activeArtifact = useArtifactStore((s) => s.activeArtifact)
  const artifacts = useArtifactStore((s) => s.artifacts)
  const closeArtifact = useArtifactStore((s) => s.closeArtifact)
  const viewMode = useArtifactStore((s) => s.viewMode)
  const setViewMode = useArtifactStore((s) => s.setViewMode)
  const viewport = useArtifactStore((s) => s.viewport)
  const setViewport = useArtifactStore((s) => s.setViewport)
  const isFullscreen = useArtifactStore((s) => s.isFullscreen)
  const toggleFullscreen = useArtifactStore((s) => s.toggleFullscreen)
  const openArtifact = useArtifactStore((s) => s.openArtifact)

  const [reloadKey, setReloadKey] = useState(0)
  const [copied, setCopied] = useState(false)
  const iframeRef = useRef<HTMLIFrameElement>(null)

  const handleCopy = async () => {
    if (!activeArtifact) return
    try {
      await navigator.clipboard.writeText(activeArtifact.content)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // ignore
    }
  }

  const handleDownload = () => {
    if (!activeArtifact) return
    const isSvg = activeArtifact.type === 'svg' || activeArtifact.content.trim().startsWith('<svg')
    const filename = `${activeArtifact.title || 'artifact'}.${isSvg ? 'svg' : 'html'}`
    const mime = isSvg ? 'image/svg+xml' : 'text/html'
    const blob = new Blob([activeArtifact.content], { type: mime })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
  }

  // 构建安全沙箱 HTML 内容，注入 Tailwind CSS CDN 与现代排版环境
  const sandboxSrcDoc = useMemo(() => {
    if (!activeArtifact) return ''
    const content = activeArtifact.content.trim()
    if (activeArtifact.type === 'svg' || content.startsWith('<svg')) {
      return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { margin: 0; padding: 2rem; display: flex; align-items: center; justify-content: center; min-height: 100vh; background: #0f1117; font-family: system-ui, sans-serif; }
    svg { max-width: 100%; height: auto; filter: drop-shadow(0 10px 25px rgba(0,0,0,0.5)); }
  </style>
</head>
<body>
  ${content}
</body>
</html>`
    }

    if (content.startsWith('<!DOCTYPE html>') || content.startsWith('<html')) {
      return content
    }

    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    body { margin: 0; padding: 1.5rem; font-family: system-ui, -apple-system, sans-serif; background: #ffffff; color: #1e293b; }
    @media (prefers-color-scheme: dark) {
      body { background: #0f172a; color: #f8fafc; }
    }
  </style>
</head>
<body>
  ${content}
</body>
</html>`
  }, [activeArtifact])

  if (!open || !activeArtifact) return null

  return (
    <div
      className={`flex flex-col border-l border-rule bg-panel shadow-2 transition-all duration-300 z-30 ${
        isFullscreen
          ? 'fixed inset-0 z-50 w-screen h-screen'
          : 'relative w-full md:w-[480px] lg:w-[580px] xl:w-[680px] shrink-0 h-full'
      }`}
    >
      {/* 顶栏控制条 */}
      <header className="flex h-13 shrink-0 items-center justify-between border-b border-rule bg-canvas/80 px-3 backdrop-blur-md">
        <div className="flex min-w-0 items-center gap-2">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
            <Sparkles size={15} />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-xs font-semibold text-ink-1">
                {activeArtifact.title || '交互式构件 (Artifact)'}
              </span>
              <span className="rounded bg-accent/10 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-accent">
                {activeArtifact.type}
              </span>
            </div>
            <p className="hidden text-[10px] text-ink-3 sm:block truncate">
              Claude-Style 实时响应式安全沙箱
            </p>
          </div>
        </div>

        {/* 视口与模式切换 */}
        <div className="flex items-center gap-1">
          {/* 模式切换：预览 / 代码 */}
          <div className="flex rounded-lg border border-rule bg-panel p-0.5">
            <button
              onClick={() => setViewMode('preview')}
              className={`press flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-ui ${
                viewMode === 'preview'
                  ? 'bg-accent text-on-accent shadow-sm'
                  : 'text-ink-3 hover:text-ink-1'
              }`}
            >
              <Eye size={12} />
              <span className="hidden sm:inline">预览</span>
            </button>
            <button
              onClick={() => setViewMode('code')}
              className={`press flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-ui ${
                viewMode === 'code'
                  ? 'bg-accent text-on-accent shadow-sm'
                  : 'text-ink-3 hover:text-ink-1'
              }`}
            >
              <Code2 size={12} />
              <span className="hidden sm:inline">代码</span>
            </button>
          </div>

          {/* 视口切换（仅预览模式有效） */}
          {viewMode === 'preview' && (
            <div className="hidden items-center rounded-lg border border-rule bg-panel p-0.5 sm:flex">
              <button
                onClick={() => setViewport('desktop')}
                title="电脑端 (100%)"
                className={`press rounded-md p-1.5 transition-ui ${
                  viewport === 'desktop' ? 'bg-hover text-accent' : 'text-ink-3 hover:text-ink-1'
                }`}
              >
                <Monitor size={13} />
              </button>
              <button
                onClick={() => setViewport('tablet')}
                title="平板端 (768px)"
                className={`press rounded-md p-1.5 transition-ui ${
                  viewport === 'tablet' ? 'bg-hover text-accent' : 'text-ink-3 hover:text-ink-1'
                }`}
              >
                <Tablet size={13} />
              </button>
              <button
                onClick={() => setViewport('mobile')}
                title="移动端 (375px)"
                className={`press rounded-md p-1.5 transition-ui ${
                  viewport === 'mobile' ? 'bg-hover text-accent' : 'text-ink-3 hover:text-ink-1'
                }`}
              >
                <Smartphone size={13} />
              </button>
            </div>
          )}

          {/* 工具图标按钮 */}
          <div className="flex items-center gap-0.5 border-l border-rule pl-1">
            <button
              onClick={() => setReloadKey((k) => k + 1)}
              title="重新加载沙箱"
              className="press rounded-lg p-1.5 text-ink-3 transition-ui hover:bg-hover hover:text-ink-1"
            >
              <RotateCw size={14} />
            </button>
            <button
              onClick={handleCopy}
              title="复制代码"
              className="press rounded-lg p-1.5 text-ink-3 transition-ui hover:bg-hover hover:text-ink-1"
            >
              {copied ? <Check size={14} className="text-emerald-500" /> : <Copy size={14} />}
            </button>
            <button
              onClick={handleDownload}
              title="下载文件"
              className="press rounded-lg p-1.5 text-ink-3 transition-ui hover:bg-hover hover:text-ink-1"
            >
              <Download size={14} />
            </button>
            <button
              onClick={toggleFullscreen}
              title={isFullscreen ? '退出全屏' : '全屏预览'}
              className="press rounded-lg p-1.5 text-ink-3 transition-ui hover:bg-hover hover:text-ink-1"
            >
              {isFullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            </button>
            <button
              onClick={closeArtifact}
              title="关闭工作台"
              className="press rounded-lg p-1.5 text-ink-3 transition-ui hover:bg-hover hover:text-ink-1"
            >
              <X size={15} />
            </button>
          </div>
        </div>
      </header>

      {/* 多构件历史 Tab 条（如果有多个构件） */}
      {artifacts.length > 1 && (
        <div className="flex gap-1 overflow-x-auto border-b border-rule bg-panel/50 px-3 py-1.5 no-scrollbar">
          <span className="flex items-center gap-1 text-[10px] font-medium text-ink-3 pl-1 pr-1.5">
            <Layers size={11} />
            <span>历史构件:</span>
          </span>
          {artifacts.map((art) => (
            <button
              key={art.id}
              onClick={() => openArtifact(art)}
              className={`press flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] whitespace-nowrap transition-all ${
                art.id === activeArtifact.id
                  ? 'bg-accent/10 font-semibold text-accent border border-accent/20'
                  : 'text-ink-3 hover:bg-hover hover:text-ink-1'
              }`}
            >
              <span className="truncate max-w-[120px]">{art.title}</span>
            </button>
          ))}
        </div>
      )}

      {/* 主展示区 */}
      <div className="relative flex-1 overflow-hidden bg-canvas/40 flex items-center justify-center p-2 sm:p-4">
        {viewMode === 'preview' ? (
          <div
            className={`transition-all duration-300 h-full flex items-center justify-center ${
              viewport === 'mobile'
                ? 'w-[375px] max-w-full'
                : viewport === 'tablet'
                ? 'w-[768px] max-w-full'
                : 'w-full'
            }`}
          >
            <div
              className={`relative h-full w-full overflow-hidden border border-rule/80 bg-white dark:bg-slate-950 shadow-2 transition-all ${
                viewport !== 'desktop' ? 'rounded-2xl ring-4 ring-black/5 dark:ring-white/5' : 'rounded-xl'
              }`}
            >
              <iframe
                key={reloadKey}
                ref={iframeRef}
                srcDoc={sandboxSrcDoc}
                title="Artifact Preview Sandbox"
                sandbox="allow-scripts allow-modals"
                className="h-full w-full border-0"
              />
            </div>
          </div>
        ) : (
          <div className="h-full w-full overflow-auto rounded-xl border border-rule/80 bg-panel p-4 shadow-1">
            <pre className="font-mono text-xs leading-relaxed text-ink-1 whitespace-pre-wrap break-all">
              <code>{activeArtifact.content}</code>
            </pre>
          </div>
        )}
      </div>
    </div>
  )
}
