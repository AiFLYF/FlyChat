# FlyChat

一个使用 React 开发的一站式 AI 聊天平台。支持 OpenAI / DeepSeek / Anthropic Claude / Google Gemini / Kimi / 智谱 GLM / OpenRouter / Ollama 等多家模型，具备流式输出、思考过程、多模态上传、联网搜索、多模型对比、Markdown/公式/图表渲染与多会话管理。

## 功能特性

### 对话
- **多提供商适配**：OpenAI 兼容（OpenAI / DeepSeek / Kimi / GLM / OpenRouter / Ollama）、Anthropic Claude、Google Gemini 三类适配器，切换模型只需在设置页点选
- **流式对话**：SSE 逐字输出，可随时停止生成、一键重新生成
- **思考过程**：自动识别并折叠展示 DeepSeek-R1 / Claude thinking / Gemini thought 的推理内容；也可手动开启「深度思考」引导模型先推理再作答
- **消息级操作**：复制、编辑用户消息并重新发送、删除单条消息、重新生成
- **多模型对比**：同一提问并行发送给多个模型，并排比较回答
- **自动标题**：首轮问答结束后由模型生成简短会话标题（失败自动降级为截断文本）
- **上下文开关**：可随时关闭某会话的历史上下文携带，或清空上下文重开

### 输入与多模态
- **图片上传**：以 Vision 方式传给支持视觉的模型（支持粘贴 / 拖拽）
- **文档上传**：PDF / DOCX / TXT / Markdown / CSV / JSON 等，后端抽取文本后注入上下文
- **联网搜索**：接入 Tavily，回答附带引用来源列表
- **提示词库**：保存常用提示词，输入框一键插入
- **助手（面具）**：预设系统提示词 + 模型 + 温度，新建对话时直接选用
- **草稿保存**：按会话保存输入草稿，切换会话不丢失

### 呈现
- **Markdown 渲染**：GFM 表格、代码高亮（明暗双主题）、代码块折叠 / 行号 / 复制 / 下载
- **数学公式**：KaTeX 行内与块级公式
- **Mermaid 图表**：流程图、时序图、甘特图等按需懒加载渲染
- **Token 用量**：展示每次回答的 token 统计

### 会话管理
- **多会话**：新建 / 重命名 / 删除（可撤销）/ 置顶 / 拖拽排序
- **搜索**：按标题与消息内容搜索历史会话
- **导出**：单会话导出 Markdown / JSON / 图片，全部数据可备份与恢复
- **本地持久化**：会话存浏览器 IndexedDB，无 5MB 限制，无需数据库
- **界面**：亮 / 暗 / 跟随系统三种主题，全中文界面
- **长会话性能**：消息区分段渲染，默认只加载最近 40 条，更早的按需「加载更早」

### 模型配置（两种方式）
服务商与模型既可以写在服务端 `.env`，也可以完全在网页里维护，两者会自动合并：

- **网页配置（推荐）**：设置 → 「模型服务」里直接添加 / 编辑 / 删除服务商，支持在线修改任意服务商的模型列表、一键连通性自检，改完即生效、无需重启后端
- **服务端配置**：`server/.env` 的 `*_API_KEY` / `*_BASE_URL`，适合写死固定的提供商
- **模型列表优先级**：网页覆盖 > `*_MODELS` 环境变量 > 内置默认

自定义服务商配置（含 API Key）保存在 `server/data/custom-providers.json`，已加入 `.gitignore`。

### 健壮性与可访问性
- **错误边界**：任意组件渲染出错都会兜底为可恢复界面（保留错误信息 + 重试 / 刷新），不会白屏
- **键盘可用**：所有浮层支持点击外部与 Esc 关闭，会话项可 Tab 聚焦并 Enter 激活
- **焦点管理**：弹窗打开时焦点移入面板、关闭后归还触发元素，Tab 在弹窗内循环
- **对比度**：正文三级色阶均满足 WCAG AA（≥ 4.5:1），焦点环 ≥ 3:1
- **减少动效**：跟随系统 `prefers-reduced-motion`，关闭所有入场/退场动画与颜色渐变
- **敏感信息**：`/api/providers` 只返回 `hasKey` 布尔值，永不回传 API Key

### 快捷键

| 按键 | 作用 |
|---|---|
| `Enter` | 发送消息 |
| `Shift + Enter` | 换行 |
| `/` 或 `Ctrl + K` | 聚焦输入框 |
| `Ctrl + Enter` | 编辑消息时保存并重新发送 |
| `Ctrl + B` | 显示 / 隐藏侧边栏 |
| `Ctrl + Shift + O` | 新建对话 |
| `Esc` | 关闭弹窗与浮层 |
| `?` | 打开快捷键说明 |

### 界面设计

参考 Claude / ChatGPT / DeepSeek 的交互范式重构：

- **空态即主输入框**：进入应用时问候语下方直接居中呈现大号输入框（`variant="hero"`），开始对话后输入框落到底部（`inline`），两者共用同一个 `Composer` 组件
- **中性色阶层**：柔灰画布 + 纯白卡面，靠「层」与「柔和投影」建立纵深，而非描边堆叠；用户气泡用中性灰，避免满屏蓝
- **功能胶囊**：附件 / 提示词 / 深度思考 / 联网搜索做成圆角胶囊嵌在输入框内，右下角圆形发送按钮
- **侧边栏**：搜索框 + 深色主按钮「新对话」，会话按置顶 / 今天 / 昨天 / 更早分组
- **明暗双主题代码高亮**：自绘 `--code-*` 令牌，随主题切换（GitHub Light / Dark 风格）

## 技术栈

| 层 | 技术 |
|---|---|
| 前端 | React 18 + TypeScript + Vite + Tailwind CSS v4 + zustand + IndexedDB |
| 渲染 | react-markdown + remark-gfm/math + rehype-highlight/katex + mermaid |
| 后端 | Node.js + Express（统一 SSE 流式代理，抹平各家协议差异） |
| 文档解析 | mammoth（docx）、pdf-parse（pdf） |
| 参考 | [chatgpt-web](https://github.com/Chanzhaoyu/chatgpt-web) · [NextChat](https://github.com/ChatGPTNextWeb/NextChat) · [cherry-studio](https://github.com/CherryHQ/cherry-studio) · [open-webui](https://github.com/open-webui/open-webui) |

## 项目结构

```
flyweb/
├── src/                      # React 前端
│   ├── components/
│   │   ├── ui/               # Switch / Modal / Menu / Slider / Spinner 通用组件
│   │   ├── Sidebar / ChatWindow / MessageItem / Composer /
│   │   ├── SettingsModal / ProviderManager / ShortcutsPanel /
│   │   ├── MarkdownRenderer / ModelSelector / ReasoningBlock /
│   │   ├── Citations / Attachments / PromptPicker / ErrorBoundary
│   │   └── openPanels.ts     # 弹窗开关（设置 / 快捷键）
│   ├── store/                # zustand 状态（chat 持久化到 IndexedDB，composer 草稿）
│   ├── api/                  # 流式聊天客户端 + 服务商管理接口
│   ├── lib/                  # ui（样式常量）/ date / motion / useDismiss / usePresence /
│   │                         # IndexedDB 适配、文件处理、下载与图片导出
│   └── types.ts
├── server/                   # Express 后端代理
│   ├── index.js              # 路由 + 内置提供商注册表 + 联网搜索编排
│   ├── providers/            # openai-compat / anthropic / gemini 适配器 + SSE 解析
│   │   └── store.js          # 网页配置的服务商持久化（data/ 目录）
│   ├── search/               # Tavily 联网搜索
│   ├── extract.js            # 文档文本抽取（pdf / docx / 纯文本）
│   ├── data/                 # custom-providers.json（含 Key，不进 Git）
│   └── .env                  # 密钥配置（不进 Git）
├── scripts/
│   ├── clean.mjs             # 构建前逐文件清理 dist
│   └── smoke-ui.mjs          # Playwright 冒烟（动画 / 越界 / 键盘 / 降级断言）
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

### 没有任何 API Key 也能跑通全流程

```bash
npm run mock:flash -- --register   # 终端 1：本地闪测模型（固定 :8790）并自动注册到后端
npm run dev                        # 终端 2：前后端
```

刷新页面，在「设置 → 常规与模型」里选「闪测模型」即可。
（不要用 Windows shell 里的 curl 内联中文 JSON 注册——本地代码页会把中文名毁成乱码；
`--register` 走 Node fetch 发标准 UTF-8，没有这个问题。）

### 免费真模型（推荐）

- **智谱 GLM**：在 `server/.env` 填 `GLM_API_KEY=...` 即可，`glm-4-flash`（文本，免费）与
  `glm-4v-flash`（**视界/图片理解，免费**）已内置在默认模型列表中。

### 生产部署

```bash
npm run build        # 前端构建到 dist/
npm start            # 启动后端（:3001），前端可用任意静态服务器托管
npm run preview      # 本地预览生产包（:4173，已代理 /api）
```

## 配置说明（server/.env）

```ini
# OpenAI 兼容接口（改 BASE_URL 即可接入 DeepSeek / Kimi / GLM 等任何兼容服务）
OPENAI_API_KEY=sk-xxx
OPENAI_BASE_URL=https://api.openai.com/v1

# DeepSeek
DEEPSEEK_API_KEY=sk-xxx

# Anthropic（支持自定义网关）
ANTHROPIC_API_KEY=sk-xxx
# ANTHROPIC_BASE_URL=https://api.anthropic.com/v1
# 可选：覆盖前端展示的模型列表（逗号分隔）
# ANTHROPIC_MODELS=claude-sonnet-4-5-20250929

# Google Gemini
GEMINI_API_KEY=xxx

# Kimi / GLM / OpenRouter
KIMI_API_KEY=
GLM_API_KEY=
OPENROUTER_API_KEY=

# Ollama 本地模型（无需 Key）
# OLLAMA_BASE_URL=http://localhost:11434/v1

# 联网搜索（Tavily，https://tavily.com 申请）
TAVILY_API_KEY=

# 服务端口
PORT=3001
```

只有配置了 Key 的提供商才会出现在前端设置页；配置了 `TAVILY_API_KEY` 才会出现「联网」开关。

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

然后 `.env` 中配置 `KIMI_API_KEY` 并重启后端。

> 如果只是想临时接一个自建网关或换模型，更推荐直接在「设置 → 模型服务」里添加，无需改代码、无需重启。

## 接口一览

| 方法与路径 | 说明 |
|---|---|
| `POST /api/chat` | 流式聊天代理（SSE） |
| `GET /api/providers` | 已配置的服务商列表（只回 `hasKey`，不回传 Key） |
| `POST /api/providers/custom` | 新增 / 修改自定义服务商（不传 `id` 即新增；`apiKey` 留空表示保留原密钥） |
| `DELETE /api/providers/custom/:id` | 删除自定义服务商 |
| `PUT /api/providers/:id/models` | 覆盖任意服务商（含内置）的模型列表 |
| `POST /api/providers/:id/test` | 连通性自检 |
| `POST /api/extract` | 文档文本抽取 |
| `GET /api/health` | 健康检查 |

## 环境变量速查

| 变量 | 说明 |
|---|---|
| `PORT` | 后端端口，默认 3001 |
| `*_API_KEY` | 各提供商密钥（决定前端可见的提供商） |
| `*_BASE_URL` | 自定义接口地址（自建网关 / 反代 / 本地 Ollama） |
| `*_MODELS` | 可选，覆盖前端模型列表（逗号分隔） |
| `TAVILY_API_KEY` | 联网搜索密钥（可选） |
| `TAVILY_BASE_URL` | 可选，覆盖 Tavily 接口地址 |

## 后端 SSE 事件协议

`POST /api/chat` 返回统一事件流，前端据此渲染：

| 事件 | 说明 |
|---|---|
| `{"type":"citations","citations":[...]}` | 联网搜索来源（回答前下发） |
| `{"type":"reasoning","content":"..."}` | 思考过程增量 |
| `{"type":"delta","content":"..."}` | 正文增量 |
| `{"type":"usage","usage":{...}}` | token 用量 |
| `{"type":"notice","message":"..."}` | 非致命提示（如搜索失败） |
| `{"type":"error","message":"..."}` | 致命错误 |
| `{"type":"done"}` | 结束 |

## License

MIT
