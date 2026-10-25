# 后端说明

> 面向要部署、要改后端、要接前端的人。前端说明见 `README.md`。

## 1. 设计目标

| 目标 | 落地方式 |
|---|---|
| 上游协议差异不外泄 | `providers/` 三个适配器统一成一套 SSE 事件 |
| 上游抖动不打扰用户 | 首字节前自动重试 + 熔断 + 并发闸门 |
| 超长对话不炸 | 模型目录提供上下文窗口 → `lib/tokens.js` 自动裁剪 |
| 数据可迁移 | SQLite 持久化 + Markdown/JSON 导出 |
| 敢暴露到公网 | 可选访问令牌、SSRF 防护、限流、结构化日志 |
| 可排查 | `/api/health`、`/api/metrics`、请求 ID、脱敏日志 |

## 2. 目录结构

```
server/
  index.js            进程入口：初始化存储 → 建 app → 监听 → 优雅退出
  app.js              Express 装配：请求 ID、安全头、CORS、鉴权、限流、错误处理
  config.js           所有环境变量的唯一入口 + 启动告警
  catalog/models.js   模型目录：上下文窗口、最大输出、能力、价格（可被 data/model-catalog.json 覆盖）
  lib/
    tokens.js         token 估算 + 上下文预算 + 中段截断
    resilience.js     重试 / 熔断 / 并发信号量
    compact.js        摘要式上下文压缩（小模型总结 + 缓存 + 降级）
    task-model.js     子任务专用模型选择（标题 / 摘要 / 追问建议）
    ssrf.js           Base URL 安全校验（含 DNS 解析结果检查）
    sse-response.js   服务端 SSE 通道（含心跳）
    atomic.js         原子写 + 损坏文件留档
    logger.js         结构化日志 + 敏感字段脱敏
    metrics.js        进程内计数器与延迟分位
    errors.js         AppError / UpstreamError / asyncHandler
  providers/
    registry.js       内置服务商注册表 + 合并网页配置
    store.js          自定义服务商与模型覆盖的持久化
    stream.js         统一流式入口：闸门 → 熔断 → 重试 → 适配器
    openai-compat.js  OpenAI / DeepSeek / Kimi / GLM / Qwen / 豆包 / 硅基流动 / Groq / OpenRouter / Ollama
    anthropic.js      Claude Messages API
    gemini.js         Gemini generateContent
    sse.js            上游 SSE 解析 + 错误归一
    format.js         内部消息 → 各协议 content 的公共助手
  rag/               知识库：切块、向量化、检索、编排
    jobs.js          异步入库流水线（进度 / 并发 / 重试 / 重启复位）
  tools/             内置工具（function calling）
  agent/
    loop.js          服务端 agent 循环（模型 → 工具 → 结果 → 继续）
  mcp/               MCP 客户端（自研 JSON-RPC 子集，零新依赖）
    protocol.js      JSON-RPC 编解码 + 工具命名空间
    client.js        stdio / Streamable HTTP 两种传输
    registry.js      mcp_servers 表读写
    manager.js       连接池 + 工具装载与调用
  search/
    index.js          搜索后端抽象（Tavily / Brave / Serper / SearXNG，自动降级）
    tavily.js         Tavily 实现
  store/
    db.js             node:sqlite 初始化、迁移、事务、降级
    conversations.js  会话与消息仓库
    usage.js          用量记账与聚合
  routes/
    chat.js           /api/chat、/api/complete、/api/title
    rag.js            知识库与文档
    openai-api.js     /v1 OpenAI 兼容网关
    providers.js      服务商 CRUD、连通性自检、上游模型清单
    models.js         模型目录
    conversations.js  会话 CRUD、批量消息、导出
    system.js         health / metrics / config / usage / search
    extract.js        文档文本抽取
  test/               node:test 测试套件（自带假上游，不需要真 Key）
```

## 3. 接口清单

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/chat` | 流式对话（SSE），主接口（走预算硬检查） |
| POST | `/api/complete` | 非流式补全（摘要、改写等短任务，走预算硬检查） |
| POST | `/api/title` | 生成会话标题（走预算硬检查） |
| GET | `/api/providers` | 已配置服务商（**永不返回 Key**） |
| GET | `/api/providers/all` | 全部服务商（含未配置） |
| POST | `/api/providers/custom` | 新增/修改自定义服务商（校验 Base URL） |
| GET/DELETE | `/api/providers/custom/:id` | 详情（不含 Key）/ 删除 |
| PUT | `/api/providers/:id/models` | 覆盖模型列表 |
| POST | `/api/providers/:id/test` | 连通性自检 |
| GET | `/api/providers/:id/remote-models` | 拉取上游模型清单 |
| GET | `/api/models` | 模型目录（上下文窗口/能力/价格） |
| GET | `/api/models/:provider/*` | 单个模型详情（模型名可含斜杠） |
| GET/POST | `/api/conversations` | 列表（`?q=` 搜索）/ 创建 |
| GET/PATCH/DELETE | `/api/conversations/:id` | 详情 / 改名置顶 / 删除 |
| PUT | `/api/conversations/:id/messages` | 批量写入消息（`replace` 控制覆盖） |
| GET | `/api/conversations/:id/export?format=md\|json` | 导出单个会话 |
| GET | `/api/export` | 全量导出（换机/迁移） |
| POST | `/api/import` | 导入（`mode=merge\|replace`，replace 需 `confirm`） |
| POST | `/api/extract` | 文档抽取纯文本 |
| POST | `/api/search` | 只搜不聊 |
| GET | `/api/auth/me` | 当前登录态（含 `multiUser` / `needsSetup`） |
| POST | `/api/auth/setup` | 创建第一个管理员（仅在库里没有任何用户时可用） |
| POST | `/api/auth/login` | 登录，写 HttpOnly 会话 cookie |
| POST | `/api/auth/logout` | 退出登录 |
| POST | `/api/auth/token` | 生成个人访问令牌（PAT），明文只返回一次 |
| DELETE | `/api/auth/token` | 吊销令牌 |
| POST | `/api/auth/password` | 改自己的密码（会踢掉所有会话） |
| PATCH | `/api/auth/profile` | 改自己的显示名 |
| GET/POST | `/api/users` | 用户列表 / 新建（管理员） |
| PATCH/DELETE | `/api/users/:id` | 改角色/禁用/重置密码 / 删除（管理员） |
| POST | `/api/conversations/claim-orphans` | 认领无归属的历史会话（管理员） |
| POST | `/api/images/generations` | 生成图片（OpenAI 兼容形状） |
| GET | `/api/images/status` | 有没有可用的图像模型 |
| POST | `/v1/images/generations` | 同上，给第三方客户端用 |
| GET | `/api/tasks` | 小任务类型与改写风格列表 |
| POST | `/api/tasks/:kind` | 小任务：`title` / `summary` / `suggest` / `rewrite` |
| GET/POST | `/api/folders` | 文件夹列表（带会话数）/ 新建 |
| PATCH/DELETE | `/api/folders/:id` | 改名 / 删除（**里面的会话不删，只回到未分类**） |
| POST | `/api/folders/:id/move` | 批量移入；`id` 传 `none` 表示移出 |
| GET | `/api/tags` | 所有标签及其数量（侧栏标签云） |
| GET/POST | `/api/presets` | 预设列表 / 新建（带 `id` 即修改） |
| GET/PUT | `/api/presets/:id` | 读 / 改单个预设 |
| DELETE | `/api/presets/:id` | 删除 |
| POST | `/api/presets/:id/duplicate` | 复制一份 |
| GET/POST | `/api/mcp/servers` | MCP server 列表 / 新增修改 |
| DELETE | `/api/mcp/servers/:id` | 删除 |
| POST | `/api/mcp/servers/:id/enable` | 启用/停用 |
| POST | `/api/mcp/servers/:id/trust` | 信任开关（不开只能调只读工具） |
| POST | `/api/mcp/servers/:id/tools/:name/disable` | 单工具禁用 |
| POST | `/api/mcp/servers/:id/probe` | 连通性探测（拉回工具列表） |
| GET | `/api/mcp/tools` | 当前生效的 MCP 工具定义 |
| POST | `/api/share` | 创建分享快照（可设密码/有效期） |
| GET | `/api/share/:id` | 公开读取分享（无需令牌） |
| GET | `/api/shares` | 分享列表 |
| DELETE | `/api/share/:id` | 取消分享 |
| POST | `/api/audio/transcriptions` | 语音转文字（JSON 传 base64，服务端转 multipart） |
| POST | `/api/audio/speech` | 文字转语音（返回音频流） |
| GET | `/api/knowledge/status` | 知识库是否可用、向量化模型、文档数 |
| GET/POST | `/api/workspaces` | 知识库列表 / 新建 |
| DELETE | `/api/workspaces/:id` | 删除知识库（默认库不可删） |
| GET/POST | `/api/documents` | 文档列表 / 上传（文件 / 粘贴文本 / 网页 URL，立即 202） |
| GET | `/api/documents/:id` | 单个文档的处理进度（status/stage/progress） |
| POST | `/api/documents/:id/retry` | 失败重试（重新入队） |
| DELETE | `/api/documents/:id` | 删除文档及其切块 |
| POST | `/api/retrieve` | 单独检索（调试/搜索框用） |
| GET/PUT | `/api/budget` | 成本上限查询 / 设置（0 = 不限制） |
| GET | `/api/usage` | 用量与花费聚合（按天/按模型） |
| GET | `/v1/models` | OpenAI 兼容：模型列表 |
| POST | `/v1/chat/completions` | OpenAI 兼容：补全（流式/非流式/tools 透传） |
| GET | `/api/health` | 健康检查（存储、服务商、搜索、熔断） |
| GET | `/api/metrics` | 请求数、延迟分位、内存 |
| GET | `/api/config` | 前端启动用的能力开关 |

## 4. `/api/chat` SSE 事件协议

前端按 `data: {json}\n\n` 逐行解析。**顺序保证**：`meta` 在最前，`done` 在最后，`usage` 一定在 `done` 之前。

| 事件 | 字段 | 说明 |
|---|---|---|
| `meta` | `requestId, provider, model, modelKnown, contextWindow, maxOutput, context{estimatedInputTokens,budget,trimmed,dropped,truncated}` | 本次请求的预算与是否裁剪 |
| `notice` | `message` | 非致命提示（历史被裁剪、搜索失败等） |
| `citations` | `citations[{index,title,url,content}]` | 联网来源 |
| `reasoning` | `content` | 思考过程增量 |
| `delta` | `content` | 正文增量 |
| `usage` | `usage{prompt,completion,total}, costUsd, estimated` | 用量与估算花费 |
| `tool_call` | `id, name, arguments` | 模型要调用工具（服务端即将执行） |
| `tool_result` | `id, name, ok, preview` | 工具执行结果摘要 |
| `sources` | `sources[{index,title,documentId,heading,snippet,score}]` | 知识库检索命中的来源 |
| `model_switch` | `from, to, reason` | 主模型不可用，已自动降级 |
| `error` | `message, code` | 致命错误（此时不会再有 `done`） |
| `done` | — | 正常结束 |

请求体（除原有字段外的可选新增）：

```jsonc
{
  "provider": "deepseek",
  "model": "deepseek-chat",
  "messages": [{ "role": "user", "content": "你好" }],
  "system": "……",
  "temperature": 0.7,
  "topP": 1,
  "maxTokens": 4096,
  "webSearch": false,
  "think": false,
  "conversationId": "c-123"   // 新增：用于用量记账
}
```

## 5. 关键行为

### 5.0 工具调用（agent 模式）

请求体加 `"tools": true`（或传工具名数组 `"tools": ["web_search"]`）即启用：

```jsonc
{ "provider": "deepseek", "model": "deepseek-chat", "tools": true, "messages": [...] }
```

- 服务端把工具定义转成各家协议格式（OpenAI `tools` / Anthropic `input_schema` / Gemini `functionDeclarations`）。
- 模型返回工具调用 → **服务端执行** → 结果回填进对话 → 继续生成，最多 4 轮。
- 前端只看到一条普通 SSE 流，额外收到 `tool_call` / `tool_result` 事件，进度用 `notice` 展示。
- 内置工具：`web_search`（复用搜索后端）、`fetch_url`（读网页正文，**逐跳 SSRF 校验**——
  手动跟随重定向且每一跳都过 DNS 级校验，并拒绝回环/内网；抓取对象来自模型输出，
  页面内容可能诱导模型，按最严口径设防）、`current_time`。
- 防护：同参数重复调用会被拦截；步数用尽后强制「不再调工具，直接作答」；响应体边读边限额（2MB），超限即断。
- 模型不支持工具时自动降级为普通对话并提示，不会报错。

### 5.05 知识库（RAG）

```
上传 → 落盘 + 入队（202）→ 后台流水线：抽文本 → 切块 → 向量化 → SQLite(BLOB) 入库
提问 → 查询向量化 → 向量 + 关键词混合检索 → 注入 system → 回传 sources 事件
```

- **三种来源**，任选其一：
  - `dataUrl`：文件（base64）
  - `text`：直接粘贴的文本
  - `url`：网页链接，后台抓取后抽取正文（走 SSRF 校验，**每一跳重定向都校验**）
- **上传是异步的**（`rag/jobs.js`）。接口只做三件事：建行、源文件落盘到
  `server/data/uploads/<docId>`（网页来源则只记 URL）、入队，然后立刻返回 `202`。
  真正的重活在后台 worker 里跑。
  - 进度写回 `documents` 表：`status`（`pending|processing|ready|failed`）、
    `stage`（中文阶段文案）、`progress`（0–100）、`attempts`、`error`。
  - 前端轮询 `GET /api/documents/:id` 拿进度；失败可 `POST /api/documents/:id/retry`。
  - **并发受控**：`INGEST_CONCURRENCY`（默认 2，上限 8），避免一下打满 embedding 配额。
  - **进程重启不丢任务**：源文件还在盘上，启动时 `resetStaleJobs()` 把卡在
    `processing/pending` 的行复位成 `failed`（带「服务重启导致任务中断」原因），用户点重试即可。
    不复位的话这些行永远卡住，既点不了重试也删不掉语义。
  - **落盘失败不留孤儿行**：`createDocument` 之后若写盘失败，立刻 `deleteDocument`，
    否则会留下一条永远 pending 的记录，且它的 hash 已占位，用户改好文件重传也会被判成重复。
- **零原生依赖**：向量存 SQLite BLOB，检索时在 Node 里做全量余弦扫描。
  个人/小团队规模（几万块）几十毫秒；规模再大时把 `rag/store.js#search` 换成外部向量库即可，接口不变。
- **切块**：按 Markdown 标题与段落边界切，每块带「文档 / 章节」抬头，相邻块留重叠。
- **混合检索（四路信号 + MMR）**：
  `0.62 × 余弦 + 0.20 × 关键词覆盖 + 0.14 × 硬词命中 + 0.04 × 章节命中`，
  关键词大面积命中（>0.6）时再给 `+0.06` 保底。

  | 信号 | 解决什么 |
  |---|---|
  | 余弦 | 语义相近 |
  | 关键词覆盖（中文 2 字滑窗 + 英文分词） | 用词对得上但语义向量没抓到 |
  | **硬词命中**：型号/编号（`a100`、`gpt-4o`、`max_tokens`）、全大写缩写（`HNSW`、`SQL`）、驼峰（`Float32Array`）、长中文词 | 纯向量在这类词上最容易失手——这正是 AnythingLLM #4338 的抱怨 |
  | **章节命中**：块抬头写着「选型」，问「怎么选」时它就该靠前 | 结构信息被浪费 |
  | **MMR 去重**（`lambda=0.72`） | 同一段话被切成 3 块时，纯按分数取 topK 会把名额全给它 |

  注意：判断「硬词」必须**在 lowercase 之前**做——`HNSW` 一旦降成 `hnsw` 就再也分不出是不是缩写。

- **按文档限定检索**：`documentIds: [...]`，在 SQL 层过滤（命中少量文档时不必把整库向量读进内存）。
  `/api/chat` 也支持这个字段，对应「只在这几份文档里找答案」。
- **调试视图**：`POST /api/retrieve { debug: true }` 会额外返回每条候选的
  `vectorScore / keywordScore / phraseScore / headingScore / score`、
  `picked`（是否进了最终结果）、`belowThreshold`（是否被阈值淘汰），
  以及 `timings{embedMs, searchMs, totalMs}`。这直接回答「为什么这条没被召回」。
- **去重**：按**完整内容** sha256 判重（不是前缀——两份 PDF 文件头相同会被误判），
  同一份文档重复上传不会重复入库。
- **隔离**：`workspace` 级隔离，检索只在本库内进行。
- **降级**：向量化服务不可用时自动退回纯关键词检索，功能不中断。
- **总览数字不混**：`/api/knowledge/status` 的 `documents` 只算 `ready`，
  另外单独给 `processing` 与 `failed`，避免「12 篇文档」里混着 5 篇失败的让人以为检索坏了。

**支持的文件格式**（`extract.js`）：

| 类型 | 说明 |
|---|---|
| PDF | `pdf-parse` |
| DOCX | `mammoth` |
| PPTX | 解 zip 取 `<a:t>` 文本节点，按页输出（`## 第 N 页`） |
| XLSX | 解 zip 读 sharedStrings + 各工作表，每张表转成 Markdown 表格 |
| CSV / TSV | 分隔符嗅探 + RFC 4180 子集解析，转 Markdown 表格 |
| HTML | **先去标签再入库**（`lib/html.js`），不会把 `<style>`/`<script>` 喂给模型 |
| 纯文本 | txt / md / json / yaml / xml 与常见代码文件 |
| 旧版 .doc/.ppt/.xls | 明确提示「另存为 …后再上传」，而不是一句「不支持」 |

**网页入库**（`extractUrl`）：

- 抓取前过 SSRF 校验，**重定向手动逐跳跟随并逐跳校验**——
  用 `redirect: 'follow'` 只校验初始 URL，攻击者可以 302 到 `169.254.169.254` 读云元数据。
- 边读边计数，超过 8MB 直接中断，防止一个超大响应打爆内存。
- 按 `Content-Type` 分派解析器（HTML / PDF / 纯文本 / CSV）；拿不到类型就按扩展名猜。
- 按**提交的 URL** 判重（不是重定向后的最终地址），同一个链接不会重复入库。

配置：`EMBEDDING_PROVIDER`（选哪个服务商）+ `EMBEDDING_MODEL`（默认 `text-embedding-3-small`，
Ollama 下默认 `nomic-embed-text`）。不配则自动选第一个 OpenAI 兼容服务商。
`INGEST_CONCURRENCY` 控制入库并发。

### 5.06 消息树（分叉 / 编辑重生成）

`schema v4` 起每条消息带 `parent_id`，会话带 `leaf_message_id`。

- `GET /api/conversations/:id` 额外返回 `activePath`（根→叶的 id 链）、`leafMessageId`、`tree`（是否树形），
  每条消息带 `parentId` / `variantCount` / `variantIndex` / `hasChildren`。
- **兄弟节点 = variants**：同一个 `parentId` 下的多条消息构成可轮播的多个版本，
  正好对应前端的 `variants` + `currentVariantIndex`。
- `POST /api/chat` 传 `parentId` 时，服务端只取「根 → parentId」这条链作为上下文，
  不会把其他分支的内容带进去。
- `/api/chat` 传 `conversationId` + `parentId` 即可，不用再传整段历史（传了也会按 id 去重）。
- 切换分支：`PATCH /api/conversations/:id { leafMessageId }`。
- 导出只含当前激活分支。
- **向后兼容**：没有 `parentId` 的老对话 `tree:false`、`variantCount` 全为 1，顺序不变。

### 5.07 成本上限（硬预算）

`budgets` 表存日/月上限（美元，0 = 不限制）。**请求前**检查当日/本月已花费，
超限返回 `429 {code: daily_budget_exceeded | monthly_budget_exceeded}`，
`/api/chat` 与 `/v1/chat/completions` 都会被拦住；到 80% 时发一条 `notice` 软提示。

接口：`GET /api/budget`（含已花费与百分比）、`PUT /api/budget {dailyUsd, monthlyUsd}`。

### 5.08 MCP 客户端（零依赖）

`server/mcp/` 自己实现了 MCP 协议的 JSON-RPC 子集，**没有引 `@modelcontextprotocol/sdk`**
（那个包装了一串传递依赖，会让镜像明显变大）。支持两种传输：

- `stdio`：`spawn(command, args, {env})`，换行分隔的 JSON-RPC
- `http`（Streamable HTTP）：POST + `Accept: application/json, text/event-stream`，带 `mcp-session-id`

关键设计：

- **工具命名空间**：`mcp__<server>-<id4>__<tool>`。OpenAI/Anthropic 要求工具名只含 `[a-zA-Z0-9_-]`，
  中文 server 名必须转写；只转写会撞车（两个「我的 Server」都变成 server），所以拼一段 id 短哈希。
- **信任模型**：未信任的 server 只能调 `readOnlyHint: true` 的工具；可写工具必须先开「信任」。
  未标注 annotation 的工具一律按可写处理（保守）。
- **单工具禁用**：`disabledTools` 粒度到单个工具。
- **连接池**：按 server 缓存客户端，TTL 5 分钟，配置一改立即失效。
- **server 挂了不拖垮对话**：装载失败只跳过该server的工具，`/api/chat` 照常完成。
- **密钥不回传**：`env` / `headers` 在 API 响应里只给 key 名。
- **管理权（多用户模式）**：注册 / 删除 / 启停 / 信任 / 探测全部要求 **admin**——
  stdio 配置本质是「在服务器上执行任意命令」，普通用户不能碰；
  列表与工具定义读取保持登录即可。

请求体加 `"tools": true` 时，MCP 工具会和内置工具一起进 agent 循环。

### 5.09 摘要式上下文压缩

超过模型上下文窗口时，原来只是「丢最早的 N 条」，用户会感觉助手失忆。现在：

1. `planContext` 算出必须丢弃的消息；
2. `lib/compact.js` 用一个**便宜的小模型**把那段历史总结成 ≤4000 字摘要；
3. 摘要以「【早期对话摘要】」包裹块注入 system，原文丢弃；
4. 前端收到 `notice`（"已把较早的 29 条消息总结为摘要…"）与 `meta.compaction`。

- **缓存**：按「被丢弃消息的 id 集合」做 key，第二次请求命中缓存，不再花钱。
- **摘要模型选择**：`SUMMARY_MODEL=provider:model` > 已配置服务商里名字带 mini/flash/haiku 的便宜模型 > 第一个已配置服务商。
- **失败降级**：摘要调用失败只降级为纯裁剪并发 notice，**绝不让对话失败**。
- 开关：`CONTEXT_COMPACT=false` 关闭，退回直接丢弃。

### 5.095 子任务专用模型

标题、摘要、追问建议这类「小活」如果复用主模型，会同时贵、慢、还占主模型并发额度
（LobeChat #17902 的原话就是「子代理吃主模型额度」）。所以 `lib/task-model.js` 统一管理：

| 任务 | 环境变量 | 用在 |
|---|---|---|
| 摘要 | `SUMMARY_MODEL` | 上下文压缩（5.09） |
| 标题 | `TITLE_MODEL` | `POST /api/title` 未指定模型时 |
| 追问建议 | `SUGGEST_MODEL` | 预留 |

选择顺序：环境变量显式指定 → 已配置服务商里带 `mini/flash/haiku/nano/turbo/lite/...` 的模型
（并尽量避开主服务商）→ 第一个已配置服务商的首个模型。

- 写法支持 `服务商ID:模型名` 或只写模型名（会在已配置服务商里找持有它的那个）。
- **显式配置写错不致命**：服务商没配 / 模型不存在时退回自动挑选，标题功能不会因此挂掉。
- `/api/title` 的响应多一个 `dedicatedModel`：`true` 表示这次用的是子任务模型而不是调用方指定的模型。

### 5.096 预设（Preset）

一个预设 = **模型 + 采样参数 + 系统提示 + 绑定知识库 + 绑定工具/MCP 组合**，可一键切换。

```jsonc
{
  "id": "preset-1a2b3c",
  "name": "代码助手",
  "description": "专注写代码", "icon": "⌨️",
  "provider": "deepseek", "model": "deepseek-chat",
  "systemPrompt": "你是一个严谨的工程师…",
  "params": {
    "temperature": 0.2, "topP": 1, "maxTokens": 4096,
    "think": false, "webSearch": false, "agent": true,
    "tools": true,              // true = 全部内置工具；也可给 ["web_search","fetch_url"]
    "topK": 6,                  // 知识库召回条数
    "mcpMode": "selected"       // 'all' = 用全部已启用 server；'selected' = 只用 mcpServers
  },
  "workspaceId": "default",
  "mcpServers": ["mcp-xxxx"]
}
```

**核心设计：预设是默认值，不是枷锁。**
请求里显式传的字段一律覆盖预设值——用户选了「代码助手」之后临时换个模型、把温度调高、关掉联网，
这些都要生效。`/api/chat` 传 `presetId` 即可，服务端自己摊平：

```
body = applyPreset(body, preset)   // lib/preset.js
```

之所以在服务端做，而不是让前端拼好再发：
1. `/v1` 的第三方客户端也能用预设（`model: "preset:<id>"`），不用改客户端；
2. 预设定义只有一份，不会出现「前端按 A 版本拼、后端按 B 版本存」的漂移。

几个容易踩的点（都有测试覆盖）：

- **系统提示不叠加**：请求里带了 `system` 就完全以请求为准，否则预设的提示会被拼两遍。
- **`knowledge: false` 优先**：即使预设绑了知识库，显式关掉这一轮就不检索。
- **`mcpMode: 'selected'`** 才按 `mcpServers` 过滤；`'all'` 或不配表示用全部已启用 server。
  这直接对应 LibreChat #7387「modelSpec 没法固定一组 MCP server」。
- **参数白名单**：`params` 只保留认识的键并夹紧取值范围（`temperature` 0–2、`topP` 0–1），
  预设是长期存在的配置，不能存进脏值。

`/v1` 里预设会被当成一个「模型」暴露：

```jsonc
GET /v1/models → { data: [ ..., { id: "preset:preset-1a2b3c", owned_by: "preset" } ] }
POST /v1/chat/completions { "model": "preset:preset-1a2b3c", ... }
```

这样 Cherry Studio / Cursor 这类客户端里能直接选「我的代码助手」，
预设里的系统提示与参数会一起生效。预设没绑模型时 `/v1` 会明确报 `preset_incomplete`，
而不是随便挑一个模型糊弄过去。

### 5.0962 小任务接口（`/api/tasks/:kind`）

标题、摘要、追问建议、改写选中段落——入参出参各不相同，但骨架完全一样：
**选一个便宜的模型 → 跑一次短请求 → 解析结果 → 记用量**。所以抽成一层（`lib/tasks.js`），
每个任务只描述三件事：系统提示、用户消息怎么拼、输出怎么解析。

```jsonc
GET  /api/tasks → { kinds:["title","summary","suggest","rewrite"], tones:[{key,instruction}] }

POST /api/tasks/title    { text? | messages?, maxChars? }   → { title }
POST /api/tasks/summary  { text? | messages? }              → { summary }
POST /api/tasks/suggest  { text? | messages? }              → { suggestions: string[] }  // 最多 3 条
POST /api/tasks/rewrite  { text, tone, instruction? }        → { text }
```

`tone` 可选：`concise` / `formal` / `casual` / `expand` / `polish` / `translate` / `translate_zh`。

共同行为：

- **默认走子任务专用模型**（`TITLE_MODEL` / `SUMMARY_MODEL` / `SUGGEST_MODEL`，未配则自动挑
  名字带 `mini/flash/haiku` 的便宜模型）；传了 `provider` + `model` 就尊重调用方，
  响应里 `dedicatedModel` 标明用的是哪种。
- **一起走预算检查与用量记账**：单次几十 token，但前端每轮都调一次的话累积成本不小，
  不记账就会在报表里完全隐形。
- **客户端断开就中断上游**（`res.on('close')` → abort），别让用户已经关掉的面板继续烧 token。
- `POST /api/title` 保留为兼容别名，内部已经改成同一个实现——两份实现迟早会漂移。

解析上的两个细节（都有测试）：

- `“标题”。` 这种「引号里还包着句号」要先剥标点再剥引号，并且**跑两轮**，
  否则会留下一个孤零零的右引号。
- `suggest` 会去掉 `1.` / `- ` 这类编号前缀，并过滤掉过长过短的行。

### 5.0965 会话文件夹与标签

两种整理方式并存，因为它们解决的不是同一个问题：

- **文件夹**：一个会话只属于一个地方，适合「项目 / 客户」这种硬分类；
- **标签**：一个会话可以贴多个，适合「待跟进 / 重要 / 参考」这种横切关注点。

```
GET  /api/folders                     → { items:[{id,name,icon,count,...}] }
POST /api/folders                     { name, icon?, sortIndex? }
PATCH/DELETE /api/folders/:id
POST /api/folders/:id/move            { conversationIds:[...] }   // id 传 none = 移出
GET  /api/tags                        → { items:[{name,count}] }
```

会话侧的字段与过滤：

```jsonc
PATCH /api/conversations/:id { "folderId": "folder-xxx" | null, "tags": ["重要"] }
GET /api/conversations?folderId=folder-xxx    // 只看某个文件夹
GET /api/conversations?unfiled=1              // 只看未分类
GET /api/conversations?tag=重要               // 按标签
```

几个刻意的设计：

- **删除文件夹绝不删会话**：里面的会话 `folder_id` 置空回到「未分类」，响应里的 `moved`
  告诉前端移出了几个。顺手删掉几十个会话是最容易让人失去信任的操作。
- **标签在入口清洗**：去空白、去重（大小写不敏感）、单个最长 24 字、最多 12 个，
  逗号会被换成空格（避免「a,b」变成一个怪标签）。
- **标签过滤不做子串误伤**：`tags` 是 JSON 数组字符串，SQL 里先 `LIKE` 粗筛，
  再在内存里精确比对，所以「重要」不会匹配到「不重要」。
- **`total` 与过滤条件一致**：否则分页会显示成「1 / 50」这种对不上的数。
- **文件夹按用户隔离**（多用户模式下）：`folders.user_id`，只能把会话放进自己的文件夹。

### 5.097 多用户与角色

**默认关闭。** `MULTI_USER` 不开时行为和以前完全一致：不鉴权、会话不隔离。
打开后所有 `/api` 与 `/v1` 都要求登录，`/api/health`、`/api/config`、`/api/metrics`、
分享读取、以及 `/api/auth/{me,setup,login,logout}` 仍然公开。

```
首次打开 → POST /api/auth/setup 建管理员 → 自动登录（HttpOnly cookie）
之后     → POST /api/auth/login
```

- **不预置默认账号**：有 `admin/admin` 默认口令的自托管产品是安全事件的头号来源。
- **密码用 scrypt**（Node 内置），不引 bcrypt/argon2 —— 那两个要编译原生模块。
- **会话表只存 token 的 sha256**：数据库泄露也拿不到可用的登录态。
- **cookie**：`HttpOnly` + `SameSite=Lax` + `Path=/`，生产环境且非本机时加 `Secure`。
- **失败不区分原因**：「用户不存在」和「密码错」返回同一个 `invalid_credentials`，
  且两条路径都做一次哈希，避免通过耗时或文案枚举账号。
- **角色**：`admin` / `user`。`/api/users` 只有管理员能碰；
  不能把最后一个管理员降级、禁用或删除（`last_admin`）。
- **实例级管理权同样是 admin**（多用户模式）：MCP server 写操作、自定义服务商与
  模型覆盖、预算设置（`PUT /api/budget`）——它们影响全实例且涉及内网地址 / 命令执行 / 花费。
- **分享归属**：`shares.user_id`（schema 迁移自动补列）。按 `conversationId` 创建分享时
  校验会话归属，不能把别人的会话做成公开链接；分享列表只返回自己创建的（admin 看全部），
  删除别人的分享返回 404。老数据里的无主分享归管理员可见。
- **改密码 / 禁用用户 → 立刻踢掉该用户所有会话**（`sessions` 按 user_id 删除）。

会话归属：

- `conversations.user_id`，写入时由服务端盖章（**不信任请求体里的 userId**）。
- 读/写/删/导出/导入全部带归属校验；不是自己的会话一律 **404 而不是 403**，
  避免被用来探测「这个 id 存在不存在」。
- `/api/chat` 用 `parentId` 取上下文时会校验归属——否则猜一个 conversationId
  就能把别人的历史当上下文送进模型。
- 「清空全部会话」在多用户模式下只清自己的。

无主会话（`user_id IS NULL`）：

从单用户升级上来时老会话没有归属。`setup` 会把它们**自动认领给第一个管理员**；
如果后来又出现了无主会话（比如中途关过 `MULTI_USER`），管理员可调
`POST /api/conversations/claim-orphans`。严格归属校验意味着无主会话默认对谁都不可见——
**宁可看不见，也不越权**，启动日志会提示存在多少条。

`/api/config` 新增 `authMode: 'single'|'multi'` 与 `needsSetup`，前端据此决定
进主界面 / 创建管理员页 / 登录页。

### 5.098 分享页的社交预览（OG 标签）

前端是 SPA，`/s/:id` 默认回 `index.html`，里面只有一个 `<title>FlyChat</title>`。
微信、Slack、Twitter、飞书这些抓取器**不执行 JS**，只读 HTML 里的 meta——
于是分享出去的链接永远是一张白卡片。

做法是**注入 meta** 而不是服务端渲染整页：

```
GET /s/:id
→ 读 dist/index.html，替换 <title>、在 </head> 前插入 og/twitter 标签，原样返回
```

浏览器拿到的仍然是完整的 SPA，所以前端不用改任何东西；抓取器拿到了它要的 meta。

- **标题** = 会话标题；**摘要** = 首条用户提问（去掉 Markdown 痕迹，截断 150 字）。
- **必须转义**：标题来自用户输入，直接拼进 HTML 就是 XSS。`escapeHtml` 覆盖 `& < > " '`。
- **密码保护的分享不泄露任何内容**：meta 用通用文案 + `noindex`，
  `peekShare()` 连 messages 都不返回（「读出来再不用」和「根本不读」在安全上是两回事）。
- **找不到 / 已过期时返回 200 而不是 404**：让 SPA 自己展示错误页；
  抓取器看到 404 反而会把链接缓存成「坏了」。
- 注入失败（文件读不到、模板变了）只打日志并退回原始 `index.html`，不影响用户打开页面。
- 没有 `og:image`：生成图片要引入图像库，与「零原生依赖」冲突；没有图卡片也能显示标题与摘要。

### 5.099 个人访问令牌（PAT）

多用户模式下 `/v1` 只认 cookie，而 Cherry Studio / Cursor / 各家 SDK 走不了浏览器登录流程——
没有 PAT，开启多用户等于把网关关掉。

```
POST   /api/auth/token   → { token: "fcp_...", baseUrl: "https://host/v1", hint }
DELETE /api/auth/token   → { ok: true }
```

- 令牌格式 `fcp_` + 32 字节随机；**只存 sha256**，明文只在签发那一次返回。
  `fcp_` 前缀是为了万一被贴到公开仓库时 secret scanning 能认出来。
- **一个用户同时只有一个令牌**：重复签发会作废旧令牌。这是有意的——
  多令牌会带来「到底哪个在泄漏」说不清的问题，而单人自用不需要多令牌。
- 使用方式：`Authorization: Bearer fcp_...`，`/api` 与 `/v1` 都认。
- 与登录会话的区别：会话 30 天有效、跟着浏览器；PAT 长期有效、可单独吊销。
- 禁用用户 → 令牌立即失效（`userByApiToken` 里检查 `disabled`）。
- `/api/auth/me` 返回 `hasApiToken` 与 `authVia: 'cookie' | 'token'`，便于排查客户端问题。

⚠️ **一个容易漏的坑**：`authRoutes` 挂在全局登录守卫**之前**，
所以 `/api/auth/token` 必须自己挂 `requireUser`，否则未登录请求会一路走到业务逻辑里
（最初就漏了这层，测试断言 `401 !== 400` 抓到的）。

### 5.0995 图像生成

两条入口，一套实现：

```
POST /api/images/generations   { prompt, n?, size?, provider?, model? }
POST /v1/images/generations    同上（第三方客户端接这个）
→ { created, data: [{ url } | { b64_json }], provider, model, tookMs }

GET  /api/images/status        → { available, provider, model } | { available:false, reason }
```

- **只支持 OpenAI 兼容的 `/images/generations`**（DALL·E、gpt-image-1、硅基流动 FLUX、
  智谱 CogView、通义万相、火山 Seedream 都走这个协议）。SD WebUI 的 `/sdapi/v1/txt2img`
  协议不同，没做——猜 base_url 形状太脆弱。
- **服务商怎么选**：请求里显式指定 > 工具调用时的「当前对话服务商」 > `IMAGE_PROVIDER` >
  按模型名自动探测（`dall-e|gpt-image|flux|sdxl|cogview|wanx|seedream|kolors|imagen|...`）> 报错。
  不瞎猜：一个都没有就返回 `image_unavailable` 并告诉用户怎么配。
- **4xx 原样透传，5xx 归一成 502**。401/429 是用户能处理的事（换 Key、等一会儿），
  而且状态码决定错误文案是否对外暴露（`AppError` 里 `expose = status < 500`）。
- **走预算检查**：图像比对话贵得多，超支直接 429。
- `n` 夹在 1–4，`size` 必须匹配 `数字x数字`，prompt 上限 4000 字。

#### 工具调用：`generate_image`

`tools` 里注册了 `generate_image`，但**不进默认工具集**——一次出图比一次对话贵得多，
不能因为「开了工具」就默默开始花钱。

```jsonc
POST /api/chat { ..., "agent": true, "imageGeneration": true }
// 或者显式列出来（预设绑定走这条）：{ "tools": ["generate_image"] }
```

开关的三个来源：请求的 `imageGeneration: true`、`tools` 数组里显式包含、
预设 `params.imageGeneration`。

**图片不进模型上下文**——这是这块最关键的设计：

```
工具生成图片 → ctx.emitImages(images) → SSE { type:'image', images:[{url|dataUrl,revisedPrompt}], prompt, model }
             ↘ 返回给模型：{ ok, count, model, tookMs, note:'图片已直接展示给用户' }
```

上游可能返回 base64，一张图几百 KB，塞进 prompt 既烧钱又没用（agent 循环里
工具结果会被 `JSON.stringify(...).slice(0, 20000)` 截断，base64 会把真正有用的信息挤掉）。
所以图片走单独的 SSE 事件，模型只拿到元信息，并被告知「不要复述链接」。

### 5.10 上游错误归一化

`classifyUpstreamError(status, detail)` 把各家的五花八门错误映射成一套可执行错误码：

| code | 触发条件 | 是否值得重试/降级 |
|---|---|---|
| `auth_failed` | 401 / 403 | ❌ |
| `quota_exceeded` | 429 + 欠费关键词 | ❌（该换服务商） |
| `rate_limited` | 429 | ✅ |
| `model_not_found` | 404 + model | ❌ |
| `context_overflow` | 400 + 上下文超长 | ❌ 但**可修**（该裁历史） |
| `content_filtered` | 400 + 安全拦截 | ❌ |
| `server_error` | 5xx | ✅ |
| `timeout` | 408 | ✅ |

错误文案统一成「`服务商 API 错误 (状态码) · 该怎么处理: 原文`」，用户看完知道该换 Key 还是减历史。
重试与降级只对 `transient: true` 的错误生效。

### 5.11 模型降级链

```
主模型重试耗尽 → 换 FALLBACK_MODELS 里的下一个 → …（只在还没输出任何字节时切换）
```

`FALLBACK_MODELS="deepseek:deepseek-chat,openai:gpt-4o-mini"`。切换时前端会收到
`notice` 与 `model_switch` 事件；成本记账会记到实际生效的模型上。

### 5.115 `/v1` 的错误形状

`/v1` 下的所有错误（含 4xx / 5xx）都返回 OpenAI 的形状：

```jsonc
{ "error": { "message": "…", "type": "invalid_request_error|authentication_error|rate_limit_error|server_error", "code": "model_not_found" } }
```

`/api` 那套 `{error:"…", code}` 不行——各家 SDK 都按 `error.message` 取错误文案，
拿不到就只显示一句「unknown error」，用户根本没法排查。
这个转换在 `app.js` 里挂在 `/v1` 前缀的专用错误中间件上，位置必须在通用错误中间件之前。

### 5.1 上下文预算

1. 从模型目录取 `contextWindow` 与 `maxOutput`（未知模型按名字里的 `8k/32k/128k/1m` 推断，兜底 32k）。
2. `budget = contextWindow - maxOutput - 5% 安全余量`。
3. 超预算时**从最早的消息开始丢**，至少保留 `CONTEXT_MIN_KEEP` 条（默认 4）。
4. 单条消息本身就超预算时做**中段截断**（保留头尾，中间插入省略标记）。
5. 裁剪后通过 `notice` 告知用户，并在 `meta.context` 里给出统计。

### 5.2 重试与熔断

- 只有「还没向客户端吐过任何字节」的失败才重试（否则会出现重复内容）。
- 可重试：`408/409/425/429/5xx` 与 `ECONNRESET/ETIMEDOUT/ECONNREFUSED/EAI_AGAIN`。
- 尊重上游 `Retry-After`，退避带 20% 抖动。
- 同一服务商连续失败 `BREAKER_THRESHOLD` 次后熔断 `BREAKER_COOLDOWN_MS`，期间直接返回 503 与剩余秒数。
- 每个服务商并发上限 `UPSTREAM_CONCURRENCY`，超出排队而不是打爆上游。

### 5.3 安全

- **SSRF**：自定义 Base URL 只允许 http/https，禁止用户名密码、链路本地与云元数据地址；
  默认允许回环/内网（Ollama 场景），`STRICT_SSRF=1` 可全禁；保存时会做 DNS 解析校验。
- **鉴权**：设置 `FLYCHAT_ACCESS_TOKEN` 后，除 `/api/health`、`/api/config`、`/api/metrics` 外都需要令牌（定长比较）。
- **限流**：写操作按 IP 滑动窗口限流（`RATE_MAX` / `RATE_WINDOW_MS`）。
- **脱敏**：日志里 `apiKey/authorization/token/secret/password/cookie` 一律 `[redacted]`。
- **原子写**：配置文件先写临时文件再 rename，损坏文件自动留档。

### 5.4 存储

- `node:sqlite`（Node 22.5+ 内置，无需编译）。
- 表：`conversations` / `messages` / `usage_events` / `meta`，WAL 模式。
- 拿不到 SQLite 时：`/api/conversations` 返回 503 并说明原因，**聊天功能不受影响**。
- 数据库文件默认 `server/data/flychat.db`（已在 `.gitignore` 中）。

## 6. 部署

### 单端口（推荐）

```bash
npm install
npm run build          # 产出 dist/
npm start              # 同时提供前端静态文件与 /api
```

访问 `http://127.0.0.1:3001`。生产环境建议：

```bash
FLYCHAT_ACCESS_TOKEN=<随机长字符串> \
CORS_ORIGINS=https://chat.example.com \
TRUST_PROXY=1 \
LOG_FORMAT=json \
npm start
```

### nginx 反代要点

```nginx
location /api/chat {
  proxy_pass http://127.0.0.1:3001;
  proxy_http_version 1.1;
  proxy_set_header Connection '';
  proxy_buffering off;          # 必须：否则流式会变成一次性吐出
  proxy_read_timeout 600s;
}
location / {
  proxy_pass http://127.0.0.1:3001;
}
```

### Docker

```bash
# 可选：把 Key 放到项目根的 .env 给 compose 读取
cp server/.env.example .env

docker compose up -d --build
```

- 镜像分两阶段：构建阶段编译前端，运行阶段只带 `dist/` 与运行期依赖，非 root 运行。
- 数据卷 `flychat-data` 挂到 `/data`，容器重建不丢会话与配置。
- 暴露到公网时：在 `.env` 里设置 `FLYCHAT_ACCESS_TOKEN`，并让 nginx/caddy 负责 HTTPS。
- 已内置 healthcheck，编排系统可以据此做重启策略。

## 7. 测试

```bash
npm test                     # 233 项，自带假上游，不需要真 Key
npm run smoke:api            # 对着运行中的服务做 13 项接口冒烟（默认 127.0.0.1:3001）
node scripts/smoke-api.mjs http://127.0.0.1:3011
```

- 单元/集成测试自带假上游（`test/helpers/mock-upstream.js`），**不需要真实 API Key，不产生费用**。
- 覆盖：SSE 分片解析、重试策略、熔断、上下文裁剪、SSRF、鉴权、服务商 CRUD、会话 CRUD、
  分享、语音、端到端流式、用量记账。
- `smoke-api.mjs` 用于部署后验证：只检查「接口通、结构对、错误处理合理」，不发真实模型请求。
- 加新适配器时，先在 `mock-upstream.js` 里补对应协议的假响应，再写端到端用例。

## 8. 已知限制

- 单租户：没有多用户注册/登录体系。需要多租户请在前面加一层网关或自行扩展 `store/`。
- 服务端会话存储是**可选增强**：前端默认仍以 IndexedDB 为主存储，接入方式见
  `.multi-agent-collab/inbox/Q-2026-10-18-01.md` 的接口说明。
- 旧版 `.doc` 不支持（请另存为 `.docx` / PDF）。
- `node:sqlite` 在 Node 22 仍标记 experimental，但 API 已稳定；升级 Node 时留意变更。
