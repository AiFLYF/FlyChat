# 安全策略

## 支持的版本

FlyChat 目前处于 `0.x`，安全修复只进入最新版本。升级前请先备份 `server/data/`。

## 上报漏洞

请使用 GitHub 的私密漏洞报告：仓库页 **Security → Advisories → Report a vulnerability**。
不要在公开 issue、PR 或讨论区披露细节、PoC 或受影响的部署地址。

报告中请尽量包含：

- 受影响的版本或 commit；
- 复现步骤与前置条件（是否开启多用户、是否配置了反代等）；
- 影响面（读到他人会话？拿到服务端 Key？绕过鉴权？）；
- 如果有修复思路，一并写上会加快处理。

我们会在 7 天内给出第一次回复；确认问题后会和你约定修复与披露的时间。
修复发布后再公开细节，credit 会写进发布说明（除非你希望匿名）。

## 部署者安全清单

FlyChat 默认按「本机自用」设计，暴露到公网前请逐项确认：

| 项目 | 要求 |
|---|---|
| 访问控制 | 设置 `FLYCHAT_ACCESS_TOKEN`，或开启 `MULTI_USER` 并创建管理员 |
| HTTPS | 由 nginx / caddy 终止 TLS；`HOST` 保持 `127.0.0.1` |
| 真实 IP | 反代后设置 `TRUST_PROXY=1`，否则限流会把所有请求算在反代头上 |
| 来源限制 | `CORS_ORIGINS` 只填实际前端域名 |
| 内网防护 | 纯公网部署可设 `STRICT_SSRF=1`，禁止服务商 Base URL 与网页抓取指向内网 |
| 成本 | 用 `PUT /api/budget` 设置日/月硬上限，避免 Key 被刷爆 |
| 数据 | `server/data/`（数据库与含 Key 的 `custom-providers.json`）不要提交、不要公开备份 |

SSE 需要反代关闭缓冲（`proxy_buffering off`），否则流式输出会被攒成一次性返回。

## 已有的安全设计

了解这些边界有助于判断问题影响：

- **密钥不出服务端**：`/api/providers` 只返回 `hasKey` 布尔值，前端永远拿不到 Key；
- **SSRF 校验**：自定义服务商 Base URL 保存时检查协议、凭据、云元数据地址、字面量 IP 与 DNS 解析结果；
  Agent 抓取网页时逐跳再校验，默认拒绝内网；
- **鉴权**：单用户模式为 timing-safe 比较的访问令牌；多用户模式是 scrypt 密码 +
  HttpOnly SameSite cookie（库里只存令牌 sha256）+ 个人访问令牌（PAT）；
- **隔离**：多用户下会话、文件夹、分享、知识库、用量按用户隔离，越权访问返回 404；
- **限流**：写接口有内存态限流，默认 240 次/分钟；
- **输出安全**：模型输出不渲染原始 HTML（未启用 `rehype-raw`），Mermaid 走 `securityLevel: strict`，
  Artifacts 预览在 iframe 沙箱里运行；
- **响应头**：`X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`、`Referrer-Policy: no-referrer`、
  同源 `Cross-Origin-Resource-Policy`。

## 不在范围内

- 需要攻击者已经拿到管理员权限或服务器 shell 的问题；
- 依赖项本身的已知漏洞（请直接向对应上游报告，同时欢迎提 issue 提醒升级）；
- 配置不当导致的暴露（例如关闭了令牌却直接映射公网端口）——但我们乐意改进默认值与提示。
