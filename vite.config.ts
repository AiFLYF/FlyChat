import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const apiProxy = {
  '/api': {
    target: 'http://localhost:3001',
    changeOrigin: true,
  },
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: apiProxy,
  },
  // preview（预览 dist）同样代理到后端，方便本地验证生产包
  preview: {
    port: 4173,
    proxy: apiProxy,
  },
  build: {
    // 不自动清空 dist：某些受限环境对批量删除有限制。
    // 需要干净产物时先执行 `npm run clean`。
    emptyOutDir: false,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom'],
          // katex 必须与 markdown 同组：rehype-katex 与 hast 工具互相引用，
          // 拆成两个 chunk 会形成跨 chunk 循环初始化，生产环境直接
          // `Cannot access 'v1' before initialization` 白屏（dev 不触发）。
          markdown: ['react-markdown', 'remark-gfm', 'remark-math', 'rehype-highlight', 'katex', 'rehype-katex'],
        },
      },
    },
  },
})
