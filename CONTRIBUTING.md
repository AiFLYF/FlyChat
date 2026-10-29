# 贡献指南

谢谢愿意花时间改进 FlyChat。无论是报一个能复现的 bug、提一个说清场景的需求，还是提交代码，都很有价值。

## 开始之前

- 先搜一遍 [Issues](https://github.com/AiFLYF/FlyChat/issues)，同样的问题可能已经在讨论；
- **安全漏洞不要开公开 issue**，按 [SECURITY.md](SECURITY.md) 走私密渠道；
- 较大的改动（新增协议适配器、调整存储结构、改动 `/v1` 网关行为）建议先开 issue 对齐方向，避免做完才发现方向不对。

## 分支模型

| 分支 | 用途 | 合并来源 |
|---|---|---|
| `main` | 发布分支，随版本打 tag | `release/*`、`hotfix/*` |
| `develop` | 开发主干，日常 PR 的目标分支 | `feature/*`、`release/*`、`hotfix/*` |
| `feature/<名字>` | 新功能与普通修复，从 `develop` 切出 | 完成后合回 `develop` |
| `release/<版本>` | 发版准备 | 合到 `main` 与 `develop` |
| `hotfix/<名字>` | 线上紧急修复，从 `main` 切出 | 合到 `main` 与 `develop` |

```bash
git switch develop && git pull --ff-only
git switch -c feature/my-change
```

请**不要**直接向 `main` / `develop` 推送，也不要在 PR 里附带无关的格式化或重构。

## 本地开发

要求 Node.js ≥ 22.5（后端依赖内置 `node:sqlite`）。

```bash
npm install
cp server/.env.example server/.env   # 可选，也可以稍后在网页里配置服务商
npm run dev                          # 前端 :5173，后端 :3001
```

一个 Key 都没有也能联调：另开一个终端跑 `npm run mock:flash -- --register`，它会在 `:8790` 起一个
假上游并自动注册成「闪测模型」，流式输出、思考过程、工具调用都能走通（详见 README）。

## 提交前门禁

```bash
npx tsc -b --pretty false   # 类型检查，strict + noUnusedLocals/noUnusedParameters
npm test                    # 后端测试，自带假上游，不花钱
npm run build               # 构建前端
```

改了界面再跑一次 `npm run smoke`（Playwright UI 冒烟：越界、顶栏高度、进出场动画、键盘可达、
reduced-motion 降级），并在 PR 里附改动前后的截图。

**测试失败时请修代码，不要改断言来迁就实现。** 若断言本身确实写错了，在 PR 描述里说明理由。

## 提交信息

`type(scope): 描述`

- `type`：`feat` / `fix` / `docs` / `refactor` / `test` / `chore`
- 中文祈使句，一行不超过 50 字符；
- 正文写**为什么**这么改，而不是重复 diff 里已经看得到的**做了什么**；
- 一个提交只做一件事，半成品不要提交。

## 代码约定

- **颜色**：不写硬编码色值，只用 `src/index.css` 里的语义令牌（换主题、对比度都依赖这一层）；
- **样式复用**：重复出现的样式串抽到 `src/lib/ui.ts`，通用组件放 `src/components/ui/`；
- **浮层**：关闭统一用 `useDismiss`，退场动画用 `usePresence`（调用方必须常驻渲染，否则退场帧会被提前卸载）；
- **注释**：默认不写，只在「为什么」不明显时补一句；不复述代码在做什么；
- **密钥**：任何情况下都不要把 API Key、令牌、密码写进代码、测试或截图。

## 新增模型服务商

1. 在 `server/providers/` 下按现有适配器的接口实现新协议（如果只是 OpenAI 兼容网关，直接走 `openai-compat`，不用写代码）；
2. 在 `server/test/helpers/mock-upstream.js` 里补上对应的假响应，让测试不依赖真 Key；
3. 补端到端用例（流式、错误归一化、重试与降级各一条）；
4. 在 `server/catalog/models.js` 补模型元信息（上下文窗口、能力标记、价格），否则自动裁剪与成本估算拿不到数据。

## Pull Request

- 一个 PR 解决一个问题，标题写清楚改了什么；
- 描述里写动机、关键取舍、测试结果；界面改动附截图；
- 确认没把 `server/.env`、`server/data/`、`node_modules/`、`dist/` 带进来；
- 合并前保持上述本地门禁全绿。

## 行为准则

对事不对人，尊重不同经验水平的贡献者。不发布他人的隐私信息与密钥，不提交与项目无关的内容。
