# FlyChat

自托管的一体化 AI 对话平台。**一个 Node 进程 + 一个 SQLite 文件**：前端是 React 单页应用，后端是统一的流式代理，
把 OpenAI / DeepSeek / Anthropic Claude / Google Gemini / Kimi / 智谱 GLM / 通义千问 / 豆包 / 硅基流动 / Groq /
OpenRouter / Ollama 以及任意 OpenAI 兼容网关抹平成一套接口，并在其上提供知识库（RAG）、Agent 工具调用、MCP 扩展、
多用户与成本硬上限。这些能力还会以 **OpenAI 兼容 API（`/v1`）** 再暴露一次——任何支持自定义 OpenAI 接口的客户端
（Chatbox、Cherry Studio、各类 SDK）都能直接把 FlyChat 当上游用。

零原生依赖：不需要 Python、不需要外部向量库、不需要独立数据库进程，`npm install && npm run dev` 即可跑起来。

| 想深入看 | 去哪 |
|---|---|
| 完整接口清单、SSE 协议、RAG / Agent / MCP 行为、多用户、部署与存储细节 | [docs/BACKEND.md](docs/BACKEND.md) |
| 与 Open WebUI / LibreChat / AnythingLLM / LobeChat 的对比调研与路线图 | [docs/ROADMAP.md](docs/ROADMAP.md) |

## 快速开始

要求：**Node.js ≥ 22.5**（后端使用内置 `node:sqlite`）。低于该版本时服务端持久化会自动降级关闭——
聊天仍然可用，但会话同步、知识库、分享、多用户等依赖存储的功能不可用。

```bash
# 1. 安装依赖
npm install

# 2. 配置密钥（可选：也可以完全不填，改在网页「设置 → 模型服务」里添加）
cp server/.env.example server/.env

# 3. 一键启动前后端（前端 :5173，后端 :3001）
npm run dev
```

打开 http://localhost:5173 ，在「设置」里选服务商和模型即可开始对话。

生产部署用单端口模式，后端同时提供前端静态文件与 `/api`、`/v1`：

```bash
npm run build        # 前端构建到 dist/
npm start            # 访问 http://127.0.0.1:3001
npm run preview      # 或本地预览生产包（:4173，已代理 /api）
```

### Docker

```bash
cp server/.env.example .env      # 可选：把 Key 放到项目根给 compose 读取
docker compose up -d --build     # 默认只绑 127.0.0.1:3001，公网访问交给前面的 nginx/caddy
```

- 镜像分两阶段构建，运行阶段只带 `dist/` 与运行期依赖，**非 root 运行**；
- 数据卷 `flychat-data` 挂到 `/data`（数据库、自定义服务商配置、模型目录覆盖），容器重建不丢数据；
- 内置 healthcheck，编排系统可据此做重启策略；
- 暴露到公网前务必设置 `FLYCHAT_ACCESS_TOKEN` 或开启 `MULTI_USER`，并由反向代理负责 HTTPS。

### 没有任何 API Key 也能跑通全流程

```bash
npm run mock:flash -- --register   # 终端 1：本地闪测模型（固定 :8790）并自动注册到后端
npm run dev                        # 终端 2：前后端
```

刷新页面，在「设置 → 常规与模型」里选「闪测模型」即可。
（不要用 Windows shell 里的 curl 内联中文 JSON 注册——本地代码页会把中文名毁成乱码；
`--register` 走 Node fetch 发标准 UTF-8，没有这个问题。）

### 免费真模型

**智谱 GLM**：在 `server/.env` 填 `GLM_API_KEY=...` 即可，`glm-4-flash`（文本，免费）与
`glm-4v-flash`（**视界/图片理解，免费**）已内置在默认模型列表中。

## 功能特性

### 模型接入

- **12 家内置服务商 + 任意自定义**：三类适配器（OpenAI 兼容 / Anthropic Messages / Gemini generateContent），
  切换模型只需在设置页点选；
- **两种配置方式自动合并**：网页「设置 → 模型服务」里增删改服务商、在线改模型列表、一键连通性自检、
  拉取上游模型清单，改完即生效不用重启；`server/.env` 的 `*_API_KEY` / `*_BASE_URL` 适合写死固定提供商。
  模型列表优先级：**网页覆盖 > `*_MODELS` 环境变量 > 内置默认**；
- **模型目录**：每个模型带上下文窗口、最大输出、能力标记与价格，用于自动裁剪和成本估算；
- **上游弹性**：首字节前自动重试、连续失败熔断、单服务商并发闸门、`FALLBACK_MODELS` 降级链
  （主模型不可用时自动换备用模型并下发 `model_switch` 事件）；
- **错误归一化**：上游的鉴权失败、余额不足、限流、模型不存在、超窗、内容审核统一翻译成可读文案与错误码。

### 对话

- **流式输出**：SSE 逐字返回，可随时停止、一键重新生成；
- **思考过程**：自动识别并折叠 DeepSeek-R1 / Claude thinking / Gemini thought 的推理内容，也可手动开启「深度思考」；
- **消息树**：编辑用户消息后重新回答不会覆盖原答案，同一父节点下自动成为 variants，可左右轮播对比；
  上下文只取当前激活分支；
- **多模型对比**：同一提问并行发给多个模型，并排看结果；
- **长对话不失忆**：按模型上下文窗口自动裁剪，裁剪前先用便宜小模型把被丢弃的历史总结成摘要（带缓存，可关）；
- **上下文开关**：可随时关闭某会话的历史携带，或清空上下文重开；
- **自动标题**：首轮结束后由小模型生成简短标题（失败降级为截断文本）；
- **用量与花费**：每次回答展示 token 统计与估算成本，全局有用量面板（按天/按模型）。

### 输入与多模态

- **图片**：粘贴 / 拖拽上传，以 Vision 方式传给支持视觉的模型；
- **文档**：PDF / DOCX / TXT / Markdown / CSV / JSON 等，后端抽取文本后注入上下文；
- **语音**：浏览器原生语音输入与朗读，无需额外依赖；
- **图像生成**：模型可通过工具调用产图，结果直接在对话流里展示；
- **提示词库 / 助手（面具）**：保存常用提示词一键插入；助手 = 系统提示词 + 模型 + 参数的组合，新建对话直接选用；
- **草稿保存**：按会话保存输入内容，切换会话不丢失。

### 联网搜索

接入 Tavily / Brave / Serper / 自建 SearXNG（多家可用时自动降级），回答附带可点击的引用来源列表，
也可以只搜不聊（`POST /api/search`）。

### Agent 工具调用

服务端执行 function calling，最多 4 步循环，工具调用与结果在对话里实时可见：

| 工具 | 作用 |
|---|---|
| `web_search` | 联网检索并产出引用 |
| `fetch_url` | 抓取网页正文（逐跳 SSRF 校验、跟跳转、2MB 上限） |
| `current_time` | 当前时间与时区 |
| `generate_image` | 生成图片（默认不启用，需在设置里打开） |

### MCP 扩展

自研 JSON-RPC 子集实现 MCP 客户端（**没有引入官方 SDK，零新依赖**），支持 stdio 与 Streamable HTTP 两种传输；
工具按服务器命名空间隔离，带信任模型（未信任的服务器只能调只读工具）、单工具禁用、连通性探测；
配置为管理员权限，普通用户看不到命令与参数。

### 知识库（RAG）

- 多个知识库工作区，支持上传文件、粘贴文本、贴网页 URL 三种来源；
- 入库全异步：上传立即返回 202，后台流水线带阶段/进度/重试，进程重启不丢任务；
- 检索是中文友好的混合打分（向量语义 + 关键词 + 硬短语 + 标题命中）再做 MMR 去冗余，
  回答附带来源片段，也可单独调用 `POST /api/retrieve` 调试打分；
- 零原生依赖：向量以 BLOB 存在 SQLite 里，不需要 Chroma / LanceDB 之类的外部服务。

### 多用户与权限

- `MULTI_USER=true` 开启：首次打开进入「创建管理员」页（不预置默认账号），之后是登录页；
- 密码 scrypt 加盐哈希，会话是 HttpOnly + SameSite cookie（库里只存令牌 sha256），支持个人访问令牌（PAT，`fcp_` 前缀，明文只显示一次）；
- admin / user 两档角色：服务商写操作、MCP 配置、预算设置、用户管理归管理员；
- 会话、文件夹、标签、分享、用量、知识库工作区全部按用户隔离，越权访问返回 404 而不是 403；
- 不开多用户时行为与以前完全一致：可选 `FLYCHAT_ACCESS_TOKEN` 单令牌保护，不鉴权也能纯本机自用。

### 成本控制

所有计费路径（聊天、非流式补全、小任务、搜索、图像、语音）都先过预算检查并记账：
可设日/月美元硬上限，超限直接 429，达到 80% 时在回答里插入软提示。

### 预设（Preset）

把「模型 + 参数 + 系统提示词 + 知识库 + MCP」打包成可复用条目，前端一键切换；
在 `/v1` 里以 `preset:<id>` 的形式暴露成模型名，第三方客户端可以直接选用。

### 分享

生成只读快照链接 `/s/:id`，可设访问密码与有效期（密码不出现在 URL 里），
页面注入 OG / Twitter 标签，发到微信、Slack、飞书会有标题与摘要预览；也可以导出成长图。

### 会话管理

- 文件夹（可拖拽、可嵌套排序）、标签、置顶、星标、重命名、删除可撤销；
- 按标题与消息内容搜索历史；
- 单会话导出 Markdown / JSON / 图片；全量导出与导入（`merge` / `replace`）用于换机迁移；
- **数据存哪**：会话默认存在浏览器 IndexedDB（离线可用、无 5MB 限制），同时同步一份到服务端 SQLite
  用于跨设备、分享与知识库；服务端存储不可用时自动退回纯本地模式。

### 呈现

- Markdown（GFM 表格）、代码高亮（明暗双主题）、代码块折叠 / 行号 / 复制 / 下载；
- KaTeX 行内与块级公式；Mermaid 图表按需懒加载（`securityLevel: strict`）；
- Artifacts 工作区：模型产出的网页/代码可在侧边预览，支持预览与源码双视图、桌面/平板/手机视口、全屏、下载；
- 不渲染模型输出里的原始 HTML（未启用 `rehype-raw`），Mermaid 也走严格模式。

### 界面与可访问性

- **空态即主输入框**：进入应用时问候语下方居中呈现大号输入框，开始对话后落到底部，两者共用同一个 `Composer`；
- **中性色阶层**：柔灰画布 + 纯白卡面，靠层次与柔和投影建立纵深，用户气泡用中性灰，避免满屏蓝；
- **功能胶囊**：附件 / 提示词 / 深度思考 / 联网搜索做成圆角胶囊嵌在输入框内；
- 亮 / 暗 / 跟随系统三种主题，全中文界面；消息区分段渲染，默认只加载最近 40 条，更早的按需加载；
- **错误边界**：任意组件渲染出错都兜底为可恢复界面，不白屏；
- **键盘可用**：浮层支持点击外部与 Esc 关闭，会话项可 Tab 聚焦并 Enter 激活，弹窗内焦点循环、关闭后归还触发元素；
- **对比度**：正文三级色阶满足 WCAG AA（≥ 4.5:1），焦点环 ≥ 3:1；
- **减少动效**：跟随系统 `prefers-reduced-motion`，关闭入场/退场动画与颜色渐变；
- **敏感信息**：`/api/providers` 只返回 `hasKey` 布尔值，永不回传 API Key。

### 快捷键

| 按键 | 作用 |
|---|---|
| `Enter` | 发送消息 |
| `Shift + Enter` | 换行 |
| `Ctrl / ⌘ + K` | 呼出快捷指令面板 |
| `/` | 聚焦输入框 |
| `Ctrl + Enter` | 编辑消息时保存并重新发送 |
| `Ctrl + B` | 显示 / 隐藏侧边栏 |
| `Ctrl + Shift + O` | 新建对话 |
| `Esc` | 关闭弹窗与浮层 |
| `?` | 打开快捷键说明 |

## 配置说明

完整清单见 [server/.env.example](server/.env.example)（每一项都有注释），下面只列最常改的：

| 变量 | 说明 |
|---|---|
| `PORT` / `HOST` | 监听端口（默认 3001）与地址（默认 127.0.0.1，局域网访问改 0.0.0.0 并务必配令牌） |
| `*_API_KEY` / `*_BASE_URL` | 各服务商密钥与接口地址（自建网关、反代、本地 Ollama 都走这里） |
| `*_MODELS` | 覆盖某服务商的模型列表（逗号分隔） |
| `FLYCHAT_ACCESS_TOKEN` | 单用户模式的访问令牌；暴露公网时**必须**设置 |
| `MULTI_USER` / `SESSION_DAYS` | 开启多用户注册登录与按用户隔离；登录态有效期（天） |
| `CORS_ORIGINS` / `TRUST_PROXY` | 允许的前端来源；部署在 nginx/Cloudflare 后设为 1 才能拿到真实 IP（限流依赖） |
| `TAVILY_API_KEY` / `BRAVE_API_KEY` / `SERPER_API_KEY` / `SEARXNG_URL` | 联网搜索后端，配了任意一个前端才出现「联网搜索」开关 |
| `EMBEDDING_PROVIDER` / `EMBEDDING_MODEL` | 知识库向量化用的服务商与模型（需要一个支持 `/embeddings` 的 OpenAI 兼容服务商） |
| `FALLBACK_MODELS` | 降级链，例：`deepseek:deepseek-chat,openai:gpt-4o-mini` |
| `CONTEXT_BUDGET` / `CONTEXT_COMPACT` / `SUMMARY_MODEL` | 上下文裁剪与摘要压缩开关及所用小模型 |
| `TITLE_MODEL` / `SUGGEST_MODEL` | 标题、追问建议等小任务的专用模型（不配会自动挑便宜的） |
| `STRICT_SSRF` | 严格模式：禁止把 Base URL 指向回环/内网（默认允许，因为 Ollama 是常见用法） |
| `FLYCHAT_STORAGE` / `FLYCHAT_DATA_DIR` | 服务端存储 `auto`/`sqlite`/`off`；数据目录（默认 `./server/data`） |
| `LOG_LEVEL` / `LOG_FORMAT` | 日志级别与格式（容器采集用 `json`） |

自定义服务商配置（含 API Key）保存在 `server/data/custom-providers.json`，数据库在 `server/data/flychat.db`，
两者都已在 `.gitignore` 中，Key 只存在服务端、不会下发给浏览器。

### 暴露到公网前的检查清单

1. 设置 `FLYCHAT_ACCESS_TOKEN`，或开启 `MULTI_USER` 并创建管理员；
2. `HOST` 保持 127.0.0.1，由 nginx / caddy 反代并负责 HTTPS（SSE 需要 `proxy_buffering off`，
   配置片段见 [docs/BACKEND.md](docs/BACKEND.md#nginx-反代要点)）；
3. 设置 `CORS_ORIGINS` 为实际前端域名，`TRUST_PROXY=1`；
4. 纯公网部署可加 `STRICT_SSRF=1`，禁止自定义服务商与知识库入库指向内网；
5. 用 `GET /api/budget` 设置成本硬上限，避免 Key 被刷爆。

## 接口一览

后端有两套入口：自有 `/api/*`（前端用，能力最全）与 OpenAI 兼容 `/v1/*`（第三方客户端用）。
完整清单见 [docs/BACKEND.md 第 3 节](docs/BACKEND.md#3-接口清单)，这里只列主干：

| 分组 | 接口 |
|---|---|
| 对话 | `POST /api/chat`（SSE）、`POST /api/complete`、`POST /api/title`、`POST /api/tasks/:kind` |
| 服务商与模型 | `GET /api/providers`、`POST /api/providers/custom`、`PUT /api/providers/:id/models`、`POST /api/providers/:id/test`、`GET /api/models` |
| 会话 | `GET/POST /api/conversations`、`PATCH/DELETE /api/conversations/:id`、`PUT /api/conversations/:id/messages`、`GET /api/export`、`POST /api/import` |
| 文件夹与标签 | `GET/POST /api/folders`、`POST /api/folders/:id/move`、`GET /api/tags` |
| 知识库 | `GET/POST /api/workspaces`、`GET/POST /api/documents`、`GET /api/documents/:id`、`POST /api/documents/:id/retry`、`POST /api/retrieve` |
| Agent 与 MCP | `GET/POST /api/mcp/servers`、`POST /api/mcp/servers/:id/probe`、`GET /api/mcp/tools` |
| 多用户 | `POST /api/auth/setup`、`POST /api/auth/login`、`POST /api/auth/logout`、`GET /api/auth/me`、`POST/DELETE /api/auth/token`、`GET/POST /api/users` |
| 预设 | `GET/POST /api/presets`、`PUT/DELETE /api/presets/:id`、`POST /api/presets/:id/duplicate` |
| 分享 | `POST /api/share`、`GET /api/share/:id`（公开）、`GET /api/shares`、`DELETE /api/share/:id` |
| 成本 | `GET/PUT /api/budget`、`GET /api/usage`、`GET /api/usage/recent` |
| 多模态 | `POST /api/extract`、`POST /api/images/generations`、`POST /api/audio/transcriptions`、`POST /api/audio/speech` |
| 运维 | `GET /api/health`、`GET /api/metrics`、`GET /api/config` |
| OpenAI 兼容 | `GET /v1/models`、`POST /v1/chat/completions`、`POST /v1/images/generations` |

### 当作 OpenAI 用

```bash
curl http://127.0.0.1:3001/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $FLYCHAT_ACCESS_TOKEN" \
  -d '{
    "model": "deepseek:deepseek-chat",
    "messages": [{"role": "user", "content": "你好"}],
    "stream": true
  }
```

`model` 支持 `服务商:模型名`、`服务商/模型名`、裸模型名（自动找持有它的服务商），以及 `preset:<id>`（用预设）。
错误返回是 OpenAI 标准形状 `{"error":{"message","type","code"}}`，官方 SDK 能直接读到文案。

### SSE 事件协议

`POST /api/chat` 返回统一事件流，**顺序保证**：`meta` 在最前，`done` 在最后，`usage` 一定在 `done` 之前。

| 事件 | 说明 |
|---|---|
| `meta` | 本次请求的服务商、模型、上下文窗口与预算裁剪情况 |
| `notice` | 非致命提示（历史被裁剪、搜索失败、已降级等） |
| `citations` | 联网搜索来源（回答前下发） |
| `sources` | 知识库检索命中的来源片段 |
| `reasoning` | 思考过程增量 |
| `delta` | 正文增量 |
| `tool_call` / `tool_result` | 模型请求调用工具 / 工具执行结果摘要 |
| `image` | 工具生成的图片 |
| `model_switch` | 主模型不可用，已自动降级（`from` / `to` / `reason`） |
| `usage` | token 用量与估算花费 |
| `error` | 致命错误（此后不会再有 `done`） |
| `done` | 正常结束 |

## 项目结构

```
flyweb/
├── src/                          # React 前端
│   ├── components/
│   │   ├── ChatWindow / Sidebar / MessageItem / Composer / ModelSelector
│   │   ├── MarkdownRenderer / ReasoningBlock / Citations / ToolCallsBlock /
│   │   │   KnowledgeSourcesBlock / Attachments / CommandPalette / ShareCardModal / UsageModal
│   │   ├── SettingsModal / ProviderManager / ApiGatewaySettings / PromptPicker /
│   │   │   AssistantMarketModal / ShortcutsPanel / ErrorBoundary
│   │   ├── artifacts/            # Artifacts 预览工作区
│   │   ├── auth/                 # 登录与用户管理
│   │   ├── knowledge/            # 知识库管理
│   │   ├── mcp/                  # MCP 服务器配置
│   │   ├── presets/              # 预设选择与管理
│   │   └── ui/                   # Modal / Menu / Switch / Slider / Spinner / Toast 通用件
│   ├── store/                    # zustand：chat（持久化 IndexedDB）/ auth / knowledge /
│   │                             #         preset / artifact / composer
│   ├── api/client.ts             # SSE 解析 + 全部后端接口封装
│   ├── lib/                      # db（IndexedDB 适配）/ ui（样式常量）/ motion / date / files /
│   │                             # download / exportImage / speech / useDismiss / usePresence / useFocusTrap
│   └── types.ts
├── server/                       # Express 后端
│   ├── index.js                  # 进程入口：初始化存储 → 建 app → 监听 → 优雅退出
│   ├── app.js                    # 请求 ID、安全头、CORS、鉴权、限流、静态托管、错误处理
│   ├── config.js                 # 所有环境变量的唯一入口 + 启动告警
│   ├── catalog/models.js         # 模型目录（上下文窗口 / 能力 / 价格）
│   ├── routes/                   # chat / conversations / folders / providers / models / rag /
│   │                             # mcp / presets / share / auth / users / images / audio /
│   │                             # tasks / extract / system / openai-api
│   ├── providers/                # registry / store / stream + openai-compat / anthropic / gemini 适配器
│   ├── agent/loop.js             # 服务端 agent 循环
│   ├── tools/index.js            # 内置工具（web_search / fetch_url / current_time / generate_image）
│   ├── mcp/                      # MCP 客户端：protocol / client / registry / manager
│   ├── rag/                      # 知识库：chunk / embeddings / store / jobs / index
│   ├── search/                   # 搜索后端抽象（Tavily / Brave / Serper / SearXNG）
│   ├── images/                   # 图像生成
│   ├── store/                    # db（node:sqlite）/ conversations / users / shares / presets /
│   │                             # folders / usage / budget / summary
│   ├── lib/                      # tokens / resilience / compact / task-model / preset / ssrf /
│   │                             # auth / sse-response / logger / metrics / errors / og / html / atomic
│   ├── test/                     # node:test 测试套件（自带假上游，不需要真 Key）
│   └── data/                     # flychat.db、custom-providers.json（不进 Git）
├── scripts/                      # clean / smoke-api / smoke-ui / mock-flash / e2e / audit-ui
├── docs/                         # BACKEND.md（后端权威说明）、ROADMAP.md（调研与路线图）
├── Dockerfile / docker-compose.yml
└── index.html
```

## 开发与测试

```bash
npx tsc -b --pretty false   # 类型检查（strict，开了 noUnusedLocals/Parameters）
npm run build               # 构建前端
npm test                    # 后端 264 项测试，自带假上游，不需要真 Key、不产生费用
npm run smoke:api           # 对运行中的服务做接口冒烟（默认 127.0.0.1:3001）
npm run smoke               # Playwright UI 冒烟：越界 / 顶栏高度 / 动画 / 键盘可达 / reduced-motion
npm run test:e2e            # 端到端套件（需要本机 Chrome）
npm run mock:flash          # 本地假模型，联调不花钱
```

测试覆盖 SSE 分片解析、重试与熔断、上下文裁剪与摘要压缩、SSRF、鉴权与多用户、消息树、
服务商 CRUD、会话 CRUD、文件夹、分享、预设、知识库与检索、MCP、图像、语音、用量与预算、
OpenAI 兼容网关、数据库迁移。加新适配器时，先在 `server/test/helpers/mock-upstream.js` 里补对应协议的假响应，再写端到端用例。

代码约定：不写硬编码色值，只用 `src/index.css` 里的语义令牌；重复样式串抽到 `src/lib/ui.ts`；
通用组件放 `src/components/ui/`；浮层关闭用 `useDismiss`，退场动画用 `usePresence`（调用方需常驻渲染）。

## 安全说明

- **密钥只在服务端**：前端永远拿不到 API Key，`/api/providers` 只回 `hasKey`；自定义服务商的 Base URL
  保存时做 SSRF 校验（协议、凭据、云元数据地址、字面量 IP、DNS 解析结果），Agent 抓取网页时**逐跳**再校验一次并默认拒绝内网；
- **鉴权**：单用户模式支持 `FLYCHAT_ACCESS_TOKEN`（timing-safe 比较）；多用户模式是 scrypt 密码 +
  HttpOnly SameSite 会话 cookie（库里只存 sha256）+ PAT；
- **限流**：写接口有内存态限流（默认 240 次/分），部署在反代后需 `TRUST_PROXY=1` 才能按真实 IP 限；
- **响应头**：`X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`、`Referrer-Policy: no-referrer`、
  同源 `Cross-Origin-Resource-Policy`；CORS 只放行同源、localhost 与 `CORS_ORIGINS` 白名单；
- **分享**：快照链接可设密码与有效期，密码不出现在 URL；公开读取接口只回快照内容；
- **存储降级**：拿不到 SQLite 时相关接口返回 503 并说明原因，聊天功能不受影响。

## 技术栈

| 层 | 技术 |
|---|---|
| 前端 | React 18 + TypeScript（strict）+ Vite 6 + Tailwind CSS v4 + zustand 5 + IndexedDB（idb-keyval） |
| 渲染 | react-markdown + remark-gfm/math + rehype-highlight/katex + mermaid + KaTeX |
| 后端 | Node.js ≥ 22.5 + Express 4（ESM），统一 SSE 流式代理抹平各家协议差异 |
| 存储 | 内置 `node:sqlite`（WAL），无原生依赖、无外部数据库 |
| 文档解析 | mammoth（docx）、pdf-parse（pdf） |
| 测试 | `node:test`（自带假上游）+ Playwright 冒烟 / E2E |
| 部署 | Docker 多阶段构建（node:22-alpine，非 root）+ docker-compose |

## License

MIT

---

交互范式参考：[chatgpt-web](https://github.com/Chanzhaoyu/chatgpt-web) ·
[NextChat](https://github.com/ChatGPTNextWeb/NextChat) ·
[cherry-studio](https://github.com/CherryHQ/cherry-studio) ·
[open-webui](https://github.com/open-webui/open-webui)
