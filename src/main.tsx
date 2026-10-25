import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import ErrorBoundary from './components/ErrorBoundary'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {/* 任意组件渲染出错时兜底为可恢复界面，而不是整页白屏 */}
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
)
