import { Component, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

/**
 * 渲染错误边界。
 *
 * 改动原因：此前任何组件抛错都会让整个应用白屏，用户只能刷新且看不到原因。
 * 这里兜底成一个可恢复的界面：保留错误信息 + 「重试」（重置边界）+ 「刷新页面」。
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    // 保留控制台输出，便于定位问题
    console.error('[ErrorBoundary]', error, info?.componentStack)
  }

  private reset = () => this.setState({ error: null })

  render() {
    const { error } = this.state
    if (!error) return this.props.children

    return (
      <div
        role="alert"
        className="flex h-screen flex-col items-center justify-center gap-3 bg-canvas px-6 text-center"
      >
        <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-panel text-ink-2 shadow-1">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden>
            <path d="M12 2 3 7v6c0 5 3.8 8.4 9 9 5.2-.6 9-4 9-9V7l-9-5z" opacity=".25" />
            <path d="M12 2 3 7v6c0 5 3.8 8.4 9 9 5.2-.6 9-4 9-9V7l-9-5zm0 2.3 7 3.9V13c0 3.9-2.8 6.5-7 7.2-4.2-.7-7-3.3-7-7.2V8.2l7-3.9z" />
            <path d="M11 8h2v5h-2zm0 6h2v2h-2z" />
          </svg>
        </div>
        <h1 className="text-lg font-semibold tracking-tight text-ink-1">界面出错了</h1>
        <p className="max-w-md text-sm leading-6 text-ink-2">
          FlyChat 的某个模块渲染失败。你的对话记录保存在浏览器本地，不会因此丢失。
        </p>
        <p className="max-w-md rounded-lg bg-panel px-3 py-2 font-mono text-[11px] leading-5 text-ink-3">
          {error.message || String(error)}
        </p>
        <div className="mt-2 flex gap-2">
          <button
            onClick={this.reset}
            className="r-sm press bg-accent px-3.5 py-2 text-[13px] font-medium text-on-accent transition-ui hover:bg-accent-hover"
          >
            重试
          </button>
          <button
            onClick={() => window.location.reload()}
            className="r-sm press border border-rule px-3.5 py-2 text-[13px] text-ink-2 transition-ui hover:bg-hover hover:text-ink-1"
          >
            刷新页面
          </button>
        </div>
      </div>
    )
  }
}
