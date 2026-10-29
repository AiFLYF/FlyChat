# 变更日志

本项目的所有重要变更都会记录在这里。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。
`0.x` 阶段仍可能在不升主版本号的情况下调整接口。

## [0.1.0] - 2026-10-29

首个公开版本。

### 新增

- **统一模型接入**：12 家内置服务商（OpenAI、DeepSeek、Anthropic、Gemini、Kimi、智谱 GLM、通义千问、
  豆包、硅基流动、Groq、OpenRouter、Ollama）+ 任意 OpenAI 兼容网关，全部收敛成一套 SSE 事件流；
  支持网页端增删改服务商、在线改模型列表、连通性自检、拉取上游模型清单。
- **上游弹性**：首字节前自动重试、连续失败熔断、单服务商并发闸门、`FALLBACK_MODELS` 降级链
  （降级时下发 `model_switch` 事件），上游错误统一归一化为可读文案与错误码。
- **对话能力**：流式输出与随时停止、思考过程折叠、消息树 variants、多模型并排对比、
  自动标题、上下文按窗口自动裁剪并摘要压缩、追问建议（suggestions）。
- **多模态输入**：图片粘贴/拖拽走 Vision，PDF/DOCX/TXT/Markdown/CSV/JSON 抽取文本注入上下文，
  浏览器原生语音输入与朗读，工具调用产图。
- **知识库（RAG）**：多工作区、异步入库流水线（带阶段/进度/重试，重启不丢任务）、
  中文友好的混合打分 + MMR 去冗余、来源片段回填对话；向量以 BLOB 存进 SQLite，无外部向量库。
- **Agent 与 MCP**：服务端 function calling 循环（`web_search` / `fetch_url` / `current_time` / `generate_image`，
  抓取逐跳做 SSRF 校验）；自研 MCP 客户端，支持 stdio 与 Streamable HTTP，带信任模型与单工具禁用。
- **多用户与权限**：管理员/普通用户两档角色，scrypt 密码、HttpOnly SameSite 会话 cookie、
  个人访问令牌（PAT），会话/文件夹/分享/知识库/用量按用户隔离。
- **成本控制**：日/月美元硬上限，超限 429，80% 时插入软提示；每次回答展示 token 与估算成本，
  全局用量面板按天/按模型聚合。
- **会话管理**：文件夹（可拖拽嵌套）、标签、置顶、星标、可撤销删除、全文搜索、
  单会话导出（Markdown/JSON/图片）与全量导入导出（`merge`/`replace`）。
- **预设与分享**：把「模型 + 参数 + 系统提示词 + 知识库 + MCP」打包成预设，并在 `/v1` 里以 `preset:<id>` 暴露；
  只读分享快照支持访问密码与有效期，注入 OG 标签，可导出长图。
- **渲染**：GFM 表格、代码高亮与折叠/行号/复制/下载、KaTeX 公式、Mermaid 懒加载、
  Artifacts 预览工作区（iframe 沙箱，桌面/平板/手机视口）。
- **OpenAI 兼容网关**：`/v1/models`、`/v1/chat/completions`、`/v1/images/generations`，
  错误形状与官方一致，可直接作为 Chatbox / Cherry Studio / 各类 SDK 的上游。
- **部署**：单端口生产模式、多阶段 Docker 构建（非 root、内置 healthcheck）、docker-compose 数据卷。

### 修复

- 测试用假上游在随机端口上偶发连不通：`listen(0)` 可能分到 fetch 规范屏蔽的端口（如 6667、3659），
  请求在建立 TCP 连接前就被拒绝；现在会跳过这些端口重新分配，并补了两条回归测试。
- 假上游显式指定屏蔽端口时，改为直接报出原因，而不是绑上一个永远连不上的端口。

### 安全

- API Key 只存服务端，接口只回 `hasKey`；自定义服务商 Base URL 与网页抓取均做 SSRF 校验；
- 写接口限流、安全响应头、模型输出不渲染原始 HTML、Mermaid 严格模式、Artifacts 沙箱隔离；
- 分享快照的密码不出现在 URL 中，库里只存哈希。
