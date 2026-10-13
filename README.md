# FlyChat

一个使用 React 开发的一站式 AI 聊天平台。支持 OpenAI / DeepSeek / Anthropic Claude / Google Gemini 等多家模型，流式输出、多会话管理、Markdown 渲染与暗色模式开箱即用。

## 功能特性

- **多提供商适配**：内置 OpenAI 兼容（OpenAI / DeepSeek / Kimi / GLM 等）、Anthropic Claude、Google Gemini 三类适配器，切换模型只需在设置页点选
- **流式对话**：SSE 逐字输出，可随时停止生成、一键重新生成
- **多会话管理**：侧边栏新建 / 重命名 / 删除会话，首条消息自动作为标题
- **Markdown 渲染**：GFM 表格、代码高亮、代码块一键复制
- **密钥安全**：API Key 只保存在服务端 `.env`，前端完全不接触
- **本地持久化**：会话记录存浏览器 localStorage，无需数据库
- **界面**：亮 / 暗 / 跟随系统三种主题，全中文界面，对话可导出为 Markdown

## 技术栈

| 层 | 技术 |
|---|---|
| 前端 | React 18 + TypeScript + Vite + Tailwind CSS v4 + zustand |
| 后端 | Node.js + Express（统一 SSE 流式代理） |
| 参考 | [chatgpt-web](https://github.com/Chanzhaoyu/chatgpt-web) · [NextChat](https://github.com/ChatGPTNextWeb/NextChat) · [cherry-studio](https://github.com/CherryHQ/cherry-studio) |

## 项目结构

```
flyweb/
├── src/                  # React 前端
│   ├── components/       # Sidebar / ChatWindow / MessageItem / ChatInput / SettingsModal
│   ├── store/            # zustand 状态 + localStorage 持久化
│   ├── api/              # 流式聊天客户端（解析 SSE）
│   └── types.ts
├── server/               # Express 后端代理
│   ├── index.js          # 路由 + 提供商注册表
│   ├── providers/        # openai-compat / anthropic / gemini 三类适配器 + SSE 解析
│   └── .env              # 密钥配置（不进 Git）
└── index.html
```

## 快速开始

要求：Node.js ≥ 18

```bash
# 1. 安装依赖
npm install

# 2. 配置密钥：复制模板并填入至少一个提供商的 API Key
cp server/.env.example server/.env

# 3. 一键启动前后端（前端 :5173，后端 :3001）
npm run dev
```

打开 http://localhost:5173 ，在「设置」中选择提供商和模型即可开始对话。

### 生产部署

```bash
npm run build        # 前端构建到 dist/
npm start            # 启动后端（:3001）
```

将 `dist/` 作为静态站点部署，后端提供 `/api` 接口即可。

## 配置说明（server/.env）

```ini
# OpenAI 兼容接口（改 BASE_URL 即可接入 DeepSeek / Kimi / GLM 等任何兼容服务）
OPENAI_API_KEY=sk-xxx
OPENAI_BASE_URL=https://api.openai.com/v1

# Anthropic（支持自定义网关）
ANTHROPIC_API_KEY=sk-xxx
ANTHROPIC_BASE_URL=https://api.anthropic.com/v1
# 可选：覆盖前端展示的模型列表（逗号分隔）
# ANTHROPIC_MODELS=claude-sonnet-4-5-20250929

# Google Gemini
GEMINI_API_KEY=xxx
```

只有配置了 Key 的提供商才会出现在前端设置页。

### 添加新的 OpenAI 兼容服务商

编辑 `server/index.js` 中的 `PROVIDERS` 注册表，新增一条记录即可：

```js
{
  id: 'kimi', name: 'Kimi', type: 'openai-compat',
  apiKeyEnv: 'KIMI_API_KEY',
  baseUrlEnv: 'KIMI_BASE_URL',
  defaultBaseUrl: 'https://api.moonshot.cn/v1',
  models: ['moonshot-v1-8k', 'moonshot-v1-32k'],
}
```

然后在 `.env` 中配置 `KIMI_API_KEY` 并重启后端。

## 环境变量速查

| 变量 | 说明 |
|---|---|
| `PORT` | 后端端口，默认 3001 |
| `*_API_KEY` | 各提供商密钥（决定前端可见的提供商） |
| `*_BASE_URL` | 自定义接口地址（自建网关 / 反代） |
| `*_MODELS` | 可选，覆盖前端模型列表（逗号分隔） |

## License

MIT
