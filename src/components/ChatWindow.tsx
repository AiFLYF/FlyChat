// deslop-ignore-file 04 12 21 — 单一强调色；紧凑应用栏的字号层级；空态标识底板
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowDown,
  Columns3,
  Download,
  FileJson,
  FileText,
  Image as ImageIcon,
  PanelLeftOpen,
  Repeat,
  RotateCw,
  X,
} from 'lucide-react'
import { useChatStore, uid } from '../store/chat'
import { useSettingsOpen } from './openPanels'
import { useComposer } from '../store/composer'
import {
  completeOnce,
  fetchProviders,
  generateServerTitle,
  generateTaskSuggestions,
  streamChat,
  syncConversationToServer,
  type ChatMessagePayload,
} from '../api/client'
import { downloadJson, downloadText, safeFileName } from '../lib/download'
import { exportNodeAsImage } from '../lib/exportImage'
import { flushPersist, pausePersist, resumePersist } from '../lib/db'
import { staggerDelay, useParallax } from '../lib/motion'
import { useDismiss } from '../lib/useDismiss'
import { usePresence } from '../lib/usePresence'
import { MenuPanel, MenuItem } from './ui/Menu'
import MessageItem from './MessageItem'
import Composer from './Composer'
import ModelSelector from './ModelSelector'
import PresetSelector from './presets/PresetSelector'
import ShareCardModal from './ShareCardModal'
import { usePresetStore } from '../store/preset'
import { useKnowledgeStore } from '../store/knowledge'
import { BrandIcon } from './ui/BrandLogo'
import { ConstellationHero } from './ui/BrandGraphic'
import type { Attachment, Conversation, Message, MessageVariant, ProviderInfo } from '../types'

interface Target {
  provider: string
  model: string
}

/** 按时段生成问候语，让空态更有「大厂」的温度 */
function timeGreeting(): string {
  const h = new Date().getHours()
  if (h < 6) return '夜深了'
  if (h < 11) return '上午好'
  if (h < 14) return '中午好'
  if (h < 18) return '下午好'
  return '晚上好'
}

/**
 * 结构化分类提示词推荐（代码、写作、商业、推理）
 */
const CATEGORY_PROMPTS = [
  {
    category: '代码开发',
    icon: '💻',
    items: [
      { title: '实现分布式限流器', desc: '用令牌桶算法设计 Node.js / Redis 限流中间件', tag: '架构设计' },
      { title: '重构 React 性能热点', desc: '诊断长列表卡顿并给出 useMemo/虚拟滚动优化方案', tag: '前端性能' },
      { title: '编写异步并发任务队列', desc: '支持并发度控制、指数退避重试与结果汇总', tag: '算法并发' },
      { title: 'SQL 慢查询性能调优', desc: '联合索引、执行计划 (EXPLAIN) 分析与覆盖索引设计', tag: '数据库' },
    ],
  },
  {
    category: '创意策划',
    icon: '✍️',
    items: [
      { title: '撰写商业产品发布文案', desc: '富有感染力与科技未来感的极简风格文案', tag: '文案营销' },
      { title: '科幻小说世界观设定', desc: '围绕戴森球、意识上传与星际跃迁的深度大纲', tag: '世界观' },
      { title: '技术产品全网宣发排期', desc: '包含知乎、X、ProductHunt 与 GitHub 社区节奏', tag: '增长推广' },
      { title: 'TED 风格演说演讲大纲', desc: '以「人工智能对创造力的重构」为题的启发式演讲', tag: '演讲表达' },
    ],
  },
  {
    category: '商业洞察',
    icon: '📊',
    items: [
      { title: 'SaaS 产品定价策略', desc: '从免费增值到企业席位制的转化漏斗分析', tag: '商业模式' },
      { title: '竞品核心差异化分析', desc: '构建多维技术壁垒与用户体验矩阵', tag: '竞争战略' },
      { title: '出海合规与数据安全审查', desc: 'GDPR 隐私保护、支付链路与跨境数据出境准则', tag: '合规出海' },
      { title: 'B 端销售漏斗转化分析', desc: '从 MQL 到 SQL 再到最终签约的各环节流失归因', tag: '企业销售' },
    ],
  },
  {
    category: '深度推理',
    icon: '🔬',
    items: [
      { title: '推导自注意力机制', desc: '从矩阵乘法、缩放点积到多头注意力全流程详解', tag: '数学推导' },
      { title: '复杂系统根因排查法', desc: '高可用微服务雪崩故障的排查树与止血策略', tag: '稳定性' },
      { title: '博弈论经典难题推演', desc: '纳什均衡、重复囚徒困境与机制设计的数学建模', tag: '决策博弈' },
      { title: '分布式共识算法对比', desc: '深入对比 Paxos, Raft 与 PBFT 的安全边界与选主条件', tag: '分布式' },
    ],
  },
]

/** 把会话消息整理成渲染单元：相邻的同组助手回答合并为一个对比组 */
function toUnits(messages: Message[]) {
  const units: { type: 'single' | 'group'; id: string; items: { message: Message; index: number }[] }[] = []
  messages.forEach((message, index) => {
    const last = units[units.length - 1]
    if (message.groupId && last && last.type === 'group' && last.id === message.groupId) {
      last.items.push({ message, index })
      return
    }
    if (message.groupId) {
      units.push({ type: 'group', id: message.groupId, items: [{ message, index }] })
      return
    }
    units.push({ type: 'single', id: message.id, items: [{ message, index }] })
  })
  return units
}

export default function ChatWindow() {
  const conversations = useChatStore((s) => s.conversations)
  const activeId = useChatStore((s) => s.activeId)
  const settings = useChatStore((s) => s.settings)
  const sidebarOpen = useChatStore((s) => s.sidebarOpen)
  const toggleSidebar = useChatStore((s) => s.toggleSidebar)
  const createConversation = useChatStore((s) => s.createConversation)
  const addMessage = useChatStore((s) => s.addMessage)
  const appendToMessage = useChatStore((s) => s.appendToMessage)
  const appendReasoning = useChatStore((s) => s.appendReasoning)
  const updateMessage = useChatStore((s) => s.updateMessage)
  const removeMessage = useChatStore((s) => s.removeMessage)
  const removeMessagesAfter = useChatStore((s) => s.removeMessagesAfter)
  const renameConversation = useChatStore((s) => s.renameConversation)
  const setUsingContext = useChatStore((s) => s.setUsingContext)
  const toggleMessageStar = useChatStore((s) => s.toggleMessageStar)
  const switchMessageVariant = useChatStore((s) => s.switchMessageVariant)
  const appendGeneratedImages = useChatStore((s) => s.appendGeneratedImages)
  const setMessageSuggestions = useChatStore((s) => s.setMessageSuggestions)

  const setShowSettings = useSettingsOpen((s) => s.setOpen)
  const switchComposer = useComposer((s) => s.switchTo)
  // 空态建议 chips 点击后填充输入框并聚焦（fill 会递增 focusToken 触发聚焦）
  const fillComposer = useComposer((s) => s.fill)

  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const [webSearchAvailable, setWebSearchAvailable] = useState(false)
  const [streamingIds, setStreamingIds] = useState<string[]>([])
  const [notice, setNotice] = useState('')
  const [atBottom, setAtBottom] = useState(true)
  const [exportOpen, setExportOpen] = useState(false)
  const [shareTarget, setShareTarget] = useState<Message | null>(null)
  const [activeCategory, setActiveCategory] = useState<number>(0)
  const [shuffleSeed, setShuffleSeed] = useState<number>(0)
  /** 主区是否已滚动：决定顶栏是否浮起 */
  const [scrolled, setScrolled] = useState(false)

  const abortRef = useRef<AbortController[]>([])
  const bottomRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const captureRef = useRef<HTMLDivElement>(null)
  /** 空态滚动容器与视差目标 */
  const emptyScrollRef = useRef<HTMLDivElement>(null)
  const heroRef = useRef<HTMLDivElement>(null)
  /** 导出菜单：点击外部 / Esc 关闭 */
  const exportRef = useRef<HTMLDivElement>(null)

  const pinnedRef = useRef(true)
  const titledRef = useRef<Set<string>>(new Set())

  const active = conversations.find((c) => c.id === activeId) ?? null
  const streaming = streamingIds.length > 0
  /** 空态（无消息）标记 */
  const empty = !active || active.messages.length === 0

  // 空态英雄区随滚动轻微上移淡出（系统要求减少动效时自动跳过）
  useParallax(emptyScrollRef, heroRef, 200, empty)
  useDismiss(exportRef, () => setExportOpen(false), exportOpen)

  // 提示条也要有退场动画；notice 清空后保留最后一次文本供退场期间显示
  const noticePresence = usePresence(!!notice, 160)
  const lastNoticeRef = useRef('')
  useEffect(() => {
    if (notice) lastNoticeRef.current = notice
  }, [notice])

  // 获取可用提供商（输入门控与自动选型）
  useEffect(() => {
    fetchProviders()
      .then(({ providers: list, webSearch }) => {
        setProviders(list)
        setWebSearchAvailable(webSearch)
        if (list.length === 0) return
        const state = useChatStore.getState()
        const current = list.find((p) => p.id === state.settings.provider)
        const patch: Partial<typeof state.settings> = {}
        if (!current) {
          patch.provider = list[0].id
          patch.model = list[0].models[0] ?? ''
        } else if (!state.settings.model && current.models.length > 0) {
          patch.model = current.models[0]
        }
        if (Object.keys(patch).length) state.updateSettings(patch)
      })
      .catch(() => setProviders([]))
  }, [])

  // 页面卸载 / 切到后台时强制落盘挂起状态，避免流式生成期间关闭页面丢失最近的对话
  useEffect(() => {
    const flush = () => flushPersist()
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush()
    }
    window.addEventListener('beforeunload', flush)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('beforeunload', flush)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])

  // 切换会话时保存 / 恢复输入草稿
  useEffect(() => {
    switchComposer(activeId ?? 'new')
  }, [activeId, switchComposer])

  // 智能滚动：仅在停留底部附近时跟随
  useEffect(() => {
    if (!pinnedRef.current) return
    bottomRef.current?.scrollIntoView({ behavior: streaming ? 'auto' : 'smooth' })
  }, [active?.messages, activeId, streaming])

  const onScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 100
    pinnedRef.current = near
    setAtBottom(near)
    setScrolled(el.scrollTop > 8)
  }, [])

  const scrollToBottom = useCallback(() => {
    pinnedRef.current = true
    setAtBottom(true)
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [])

  const ready =
    providers.length > 0 &&
    (settings.compareEnabled
      ? settings.compareModels.length > 0
      : !!settings.provider && !!settings.model)

  const targets: Target[] = useMemo(() => {
    if (settings.compareEnabled && settings.compareModels.length > 0) {
      return settings.compareModels.map((k) => {
        const [provider, model] = k.split('::')
        return { provider, model }
      })
    }
    return [{ provider: settings.provider, model: settings.model }]
  }, [settings.compareEnabled, settings.compareModels, settings.provider, settings.model])

  const markStreaming = (id: string, on: boolean) =>
    setStreamingIds((prev) => (on ? [...prev, id] : prev.filter((x) => x !== id)))

  /** 组装发送给模型的历史（按会话的上下文开关决定是否携带历史） */
  const buildHistory = useCallback((conv: Conversation): ChatMessagePayload[] => {
    const usable = conv.messages.filter((m) => !m.error && (m.content || m.attachments?.length))
    const usingContext = conv.usingContext !== false
    const picked = usingContext ? usable : usable.slice(-1)
    return picked.map((m) => ({ role: m.role, content: m.content, attachments: m.attachments }))
  }, [])

  const runCompletion = useCallback(
    async (
      conversationId: string,
      history: ChatMessagePayload[],
      target: Target,
      groupId?: string,
      priorVariants?: MessageVariant[]
    ) => {
      const assistantId = uid()
      const startTime = Date.now()
      // 系统提示词按优先级解析：当前助手的专属指令 > 全局默认。
      // 不把助手指令写回全局 settings，避免创建助手对话后污染默认提示词。
      const state = useChatStore.getState()
      const conversation = state.conversations.find((c) => c.id === conversationId)
      const assistant = conversation?.assistantId
        ? state.assistants.find((a) => a.id === conversation.assistantId)
        : undefined
      const systemPrompt = assistant?.systemPrompt?.trim()
        ? assistant.systemPrompt
        : settings.systemPrompt
      addMessage(conversationId, {
        id: assistantId,
        role: 'assistant',
        content: '',
        createdAt: Date.now(),
        model: target.model,
        groupId,
        status: 'streaming',
        variants: priorVariants && priorVariants.length > 0 ? priorVariants : undefined,
        currentVariantIndex: priorVariants && priorVariants.length > 0 ? priorVariants.length : 0,
      })
      markStreaming(assistantId, true)
      // 流式高频写入：暂停整份 store 落盘，待流结束一次性 flush（见 finally）
      pausePersist()

      const controller = new AbortController()
      abortRef.current.push(controller)

      try {
        const activePreset = usePresetStore.getState().presets.find((p) => p.id === usePresetStore.getState().activePresetId)
        const activeWorkspaceId = useKnowledgeStore.getState().activeWorkspaceId || activePreset?.workspaceId

        await streamChat(
          {
            settings: {
              ...settings,
              provider: target.provider,
              model: target.model,
              systemPrompt,
            },
            model: target.model,
            messages: history,
            webSearch: settings.webSearch,
            thinking: settings.thinking,
            tools: settings.tools !== false,
            imageGeneration: settings.imageGeneration,
            presetId: activePreset?.id,
            workspaceId: activeWorkspaceId,
            documentIds: conversation?.documentIds,
            conversationId,
            onDelta: (text) => appendToMessage(conversationId, assistantId, text),
            onReasoning: (text) => appendReasoning(conversationId, assistantId, text),
            onCitations: (citations) => updateMessage(conversationId, assistantId, { citations }),
            onSources: (sources) => updateMessage(conversationId, assistantId, { sources }),
            onImage: (evt) => appendGeneratedImages(conversationId, assistantId, evt.images),
            onToolCall: (tc) => {
              const currentMsg = useChatStore
                .getState()
                .conversations.find((c) => c.id === conversationId)
                ?.messages.find((m) => m.id === assistantId)
              const existing = currentMsg?.toolCalls || []
              const idx = existing.findIndex((x) => x.id === tc.id)
              const updated = idx >= 0
                ? existing.map((x, i) => (i === idx ? { ...x, ...tc } : x))
                : [...existing, tc]
              updateMessage(conversationId, assistantId, { toolCalls: updated })
            },
            onToolResult: (tr) => {
              const currentMsg = useChatStore
                .getState()
                .conversations.find((c) => c.id === conversationId)
                ?.messages.find((m) => m.id === assistantId)
              const existing = currentMsg?.toolResults || []
              const idx = existing.findIndex((x) => x.id === tr.id)
              const updated = idx >= 0
                ? existing.map((x, i) => (i === idx ? { ...x, ...tr } : x))
                : [...existing, tr]
              updateMessage(conversationId, assistantId, { toolResults: updated })
            },
            onModelSwitch: (modelSwitch) => updateMessage(conversationId, assistantId, { modelSwitch }),
            onUsage: (usage) => updateMessage(conversationId, assistantId, { usage }),
            onNotice: (message) => setNotice(message),
            onMeta: (meta) => updateMessage(conversationId, assistantId, { meta }),
          },
          controller.signal
        )
        const durationMs = Date.now() - startTime
        const finishedMsg = useChatStore
          .getState()
          .conversations.find((c) => c.id === conversationId)
          ?.messages.find((m) => m.id === assistantId)
        const currentVariants = finishedMsg?.variants ? [...finishedMsg.variants] : []
        if (finishedMsg && (finishedMsg.content || finishedMsg.toolCalls?.length)) {
          currentVariants.push({
            id: 'v-' + Date.now(),
            content: finishedMsg.content,
            reasoning: finishedMsg.reasoning,
            reasoningTimeMs: durationMs,
            model: target.model,
            citations: finishedMsg.citations,
            sources: finishedMsg.sources,
            toolCalls: finishedMsg.toolCalls,
            toolResults: finishedMsg.toolResults,
            modelSwitch: finishedMsg.modelSwitch,
            usage: finishedMsg.usage,
            createdAt: Date.now(),
          })
        }
        updateMessage(conversationId, assistantId, {
          status: 'done',
          reasoningTimeMs: durationMs,
          variants: currentVariants.length > 1 ? currentVariants : undefined,
          currentVariantIndex: currentVariants.length > 1 ? currentVariants.length - 1 : 0,
        })

        // 自动拉取追问建议 (Q-2026-10-19-06)
        if (!controller.signal.aborted && finishedMsg?.content) {
          generateTaskSuggestions({
            messages: [
              ...history.map((m) => ({ role: m.role, content: m.content })),
              { role: 'assistant', content: finishedMsg.content },
            ],
          })
            .then((res) => {
              if (res.suggestions && res.suggestions.length > 0) {
                setMessageSuggestions(conversationId, assistantId, res.suggestions)
              }
            })
            .catch(() => {})
        }
      } catch (err) {
        const aborted =
          controller.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')
        const current = useChatStore
          .getState()
          .conversations.find((c) => c.id === conversationId)
          ?.messages.find((m) => m.id === assistantId)
        const partial = current?.content ?? ''
        if (aborted) {
          updateMessage(conversationId, assistantId, {
            status: 'aborted',
            content: partial || '（已停止生成）',
          })
        } else {
          const message = err instanceof Error ? err.message : String(err)
          updateMessage(conversationId, assistantId, {
            content: partial ? partial + '\n\n---\n生成中断：' + message : '请求失败：' + message,
            error: !partial,
            status: 'error',
          })
        }
      } finally {
        markStreaming(assistantId, false)
        // 流结束：恢复持久化并把最新状态写入 IndexedDB
        resumePersist()
        abortRef.current = abortRef.current.filter((c) => c !== controller)
        // 静默向服务端同步（离线优先，不阻断前台）
        const finishedConv = useChatStore.getState().conversations.find((c) => c.id === conversationId)
        if (finishedConv) void syncConversationToServer(finishedConv)
      }
    },
    [settings, addMessage, appendToMessage, appendReasoning, updateMessage]
  )

  /** 用模型给会话起一个简短标题（优先走服务端高性能 /api/title 接口，降级走客户端补全） */
  const maybeGenerateTitle = useCallback(
    async (conversationId: string) => {
      if (titledRef.current.has(conversationId)) return
      const conv = useChatStore.getState().conversations.find((c) => c.id === conversationId)
      if (!conv) return
      const firstUser = conv.messages.find((m) => m.role === 'user' && m.content)
      if (!firstUser) return
      titledRef.current.add(conversationId)

      // 1. 优先尝试服务端专用 /api/title 接口
      try {
        const serverTitle = await generateServerTitle(
          conv.messages.map((m) => ({ role: m.role, content: m.content })),
          settings.provider,
          settings.model
        )
        if (serverTitle && serverTitle !== '新对话') {
          renameConversation(conversationId, serverTitle)
          return
        }
      } catch {
        /* 服务端未响应则回退到客户端模型直连补全 */
      }

      // 2. 客户端补全降级兜底
      try {
        const raw = await completeOnce({
          settings: { provider: settings.provider, model: settings.model, temperature: 0.3 },
          messages: [
            {
              role: 'user',
              content: `请为下面这段对话起一个不超过 12 个字的简短标题，只输出标题本身，不要引号、不要标点：\n\n${firstUser.content.slice(0, 400)}`,
            },
          ],
          maxTokens: 32,
        })
        const clean = raw.replace(/["'「」『』\n\r]/g, '').trim().slice(0, 20)
        if (clean) renameConversation(conversationId, clean)
      } catch {
        /* 标题生成失败不影响主流程 */
      }
    },
    [settings.provider, settings.model, renameConversation]
  )

  const handleSend = useCallback(
    (text: string, attachments: Attachment[]) => {
      if (streaming || !ready) return
      const convId = activeId ?? createConversation()
      const message: Message = {
        id: uid(),
        role: 'user',
        content: text,
        attachments: attachments.length ? attachments : undefined,
        createdAt: Date.now(),
      }
      addMessage(convId, message)
      const conv = useChatStore.getState().conversations.find((c) => c.id === convId)
      if (!conv) return
      const history = buildHistory(conv)
      const groupId = targets.length > 1 ? uid() : undefined
      setNotice('')
      void Promise.all(targets.map((t) => runCompletion(convId, history, t, groupId)))
        .then(async () => {
          // 仅在第一轮问答成功结束后，用模型优化会话标题
          const state = useChatStore.getState()
          const conv = state.conversations.find((c) => c.id === convId)
          const assistants = conv?.messages.filter((m) => m.role === 'assistant') ?? []
          const lastAssistant = assistants[assistants.length - 1]
          const userCount = conv?.messages.filter((m) => m.role === 'user').length ?? 0
          if (userCount <= 1 && lastAssistant && !lastAssistant.error) {
            await maybeGenerateTitle(convId)
          }
        })
        .catch(() => {
          // runCompletion 已把错误写进消息；这里只防止未处理的 promise 拒绝
        })
    },
    [
      streaming,
      ready,
      activeId,
      createConversation,
      addMessage,
      buildHistory,
      targets,
      runCompletion,
      maybeGenerateTitle,
    ]
  )

  const handleStop = useCallback(() => {
    abortRef.current.forEach((c) => c.abort())
  }, [])

  /** 重新生成最后一条回答（保留原有回答作为多版本变体） */
  const handleRegenerate = useCallback(() => {
    if (!active || streaming) return
    const msgs = active.messages
    const lastUserIdx = [...msgs].map((m) => m.role).lastIndexOf('user')
    if (lastUserIdx < 0) return
    const lastUser = msgs[lastUserIdx]
    const existingAssistant = msgs.slice(lastUserIdx + 1).find((m) => m.role === 'assistant')
    const priorVariants: MessageVariant[] =
      existingAssistant?.variants && existingAssistant.variants.length > 0
        ? [...existingAssistant.variants]
        : existingAssistant && existingAssistant.content
        ? [
            {
              id: 'v-' + existingAssistant.createdAt,
              content: existingAssistant.content,
              reasoning: existingAssistant.reasoning,
              reasoningTimeMs: existingAssistant.reasoningTimeMs,
              model: existingAssistant.model,
              citations: existingAssistant.citations,
              createdAt: existingAssistant.createdAt,
              usage: existingAssistant.usage,
            },
          ]
        : []

    removeMessagesAfter(active.id, lastUser.id)
    const conv = useChatStore.getState().conversations.find((c) => c.id === active.id)
    if (!conv) return
    const history = buildHistory({ ...conv, messages: conv.messages.slice(0, lastUserIdx + 1) })
    const groupId = targets.length > 1 ? uid() : undefined
    void Promise.all(
      targets.map((t) => runCompletion(active.id, history, t, groupId, priorVariants))
    ).catch(() => {})
  }, [active, streaming, removeMessagesAfter, buildHistory, targets, runCompletion])

  /** 编辑用户消息并重新发送 */
  const handleEdit = useCallback(
    (messageId: string, newContent: string) => {
      if (!active || streaming) return
      updateMessage(active.id, messageId, { content: newContent })
      removeMessagesAfter(active.id, messageId)
      const conv = useChatStore.getState().conversations.find((c) => c.id === active.id)
      if (!conv) return
      const idx = conv.messages.findIndex((m) => m.id === messageId)
      const history = buildHistory({ ...conv, messages: conv.messages.slice(0, idx + 1) })
      const groupId = targets.length > 1 ? uid() : undefined
      void Promise.all(targets.map((t) => runCompletion(active.id, history, t, groupId))).catch(() => {})
    },
    [active, streaming, updateMessage, removeMessagesAfter, buildHistory, targets, runCompletion]
  )

  const handleDelete = useCallback(
    (messageId: string) => {
      if (!active) return
      removeMessage(active.id, messageId)
    },
    [active, removeMessage]
  )

  const handleExportMarkdown = useCallback(() => {
    if (!active) return
    const lines = [
      `# ${active.title}`,
      '',
      `> 导出自 FlyChat · ${new Date().toLocaleString('zh-CN')}`,
      '',
      ...active.messages.map(
        (m) => `**${m.role === 'user' ? '用户' : 'AI'}**：\n\n${m.content}\n\n---\n`
      ),
    ]
    downloadText(`${safeFileName(active.title)}.md`, lines.join('\n'), 'text/markdown;charset=utf-8')
  }, [active])

  const handleExportJson = useCallback(() => {
    if (!active) return
    downloadJson(`${safeFileName(active.title)}.json`, active)
  }, [active])

  const handleExportImage = useCallback(async () => {
    if (!active || !captureRef.current) return
    try {
      await exportNodeAsImage(captureRef.current, `${safeFileName(active.title)}.png`)
    } catch (e) {
      setNotice(`导出图片失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }, [active])

  const units = useMemo(() => toUnits(active?.messages ?? []), [active?.messages])

  /**
   * 长会话分段渲染。
   *
   * 此前整段会话一次性挂载所有 MessageItem：上百条消息 = 上百套 Markdown AST
   * + 代码高亮，切换会话和滚动都会明显卡顿。这里默认只渲染最近 PAGE 条，
   * 更早的用「加载更早」按钮按需追加。渲染集用 derived 值而非 state，
   * 这样新消息到达时视图不会被重置。
   */
  const MESSAGE_PAGE = 40
  const [extraPages, setExtraPages] = useState(0)
  const renderFrom = Math.max(0, units.length - MESSAGE_PAGE * (extraPages + 1))
  const renderedUnits = useMemo(() => units.slice(renderFrom), [units, renderFrom])
  const lastUnitIndex = renderedUnits.length - 1
  /** 视口附近才播放逐条入场：长会话避免上百个动画同时触发 */
  const enterFrom = Math.max(0, renderedUnits.length - 4)

  // 切换会话时回到默认分页
  useEffect(() => setExtraPages(0), [activeId])

  const heroFooter = (
    <>
      <div className="mt-2.5 flex flex-wrap items-center justify-between gap-x-2 gap-y-1.5 px-2">
        <div className="flex items-center gap-2">
          <ModelSelector providers={providers} />
          <PresetSelector placement="bottom" />
        </div>
        <div className="flex shrink-0 items-center gap-1.5 text-[11px] text-ink-3">
          {settings.tools !== false && <span className="text-accent">智能体工具</span>}
          {settings.thinking && <span className="text-accent">深度思考</span>}
          {settings.webSearch && webSearchAvailable && <span className="text-accent">联网搜索</span>}
          <span className="tnum">温度 {settings.temperature.toFixed(1)}</span>
        </div>
      </div>

      {/* 结构化分类灵感卡片 */}
      <div className="mt-5 px-1">
        <div className="flex items-center justify-between gap-1.5 mb-3">
          <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
            {CATEGORY_PROMPTS.map((cat, idx) => (
              <button
                key={cat.category}
                type="button"
                onClick={() => {
                  setActiveCategory(idx)
                  setShuffleSeed(0)
                }}
                className={`flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-xs transition-all ${
                  activeCategory === idx
                    ? 'bg-panel font-medium text-accent border border-accent/20 shadow-sm'
                    : 'text-ink-3 hover:text-ink-1 hover:bg-hover'
                }`}
              >
                <span>{cat.icon}</span>
                <span>{cat.category}</span>
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={() => setShuffleSeed((s) => s + 1)}
            title="换一批灵感"
            className="flex shrink-0 items-center gap-1 text-[11px] text-ink-3 hover:text-accent transition-colors px-1.5 py-0.5 rounded-md hover:bg-hover"
          >
            <RotateCw size={11} />
            <span className="hidden sm:inline">换一组</span>
          </button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {(() => {
            const allItems = CATEGORY_PROMPTS[activeCategory].items
            const offset = (shuffleSeed * 2) % allItems.length
            const displayItems = [allItems[offset], allItems[(offset + 1) % allItems.length]]
            return displayItems.map((item, i) => (
              <button
                key={`${item.title}-${shuffleSeed}`}
                onClick={() => fillComposer(`${item.title}\n${item.desc}`)}
                style={{ animationDelay: staggerDelay(i, 40) }}
                className="anim-fade-up group flex flex-col text-left rounded-xl border border-rule/70 bg-panel/80 p-3 hover:border-accent hover:bg-panel hover:shadow-2 transition-all relative overflow-hidden"
              >
                <div className="text-xs font-semibold text-ink-1 group-hover:text-accent transition-colors flex items-center justify-between gap-2">
                  <span className="truncate">{item.title}</span>
                  <div className="flex items-center gap-1 shrink-0">
                    {item.tag && (
                      <span className="rounded bg-hover px-1.5 py-0.5 text-[9px] font-normal text-ink-4 group-hover:text-accent group-hover:bg-accent/10 transition-colors">
                        {item.tag}
                      </span>
                    )}
                    <span className="opacity-0 group-hover:opacity-100 text-[10px] text-accent transition-opacity">
                      ↵
                    </span>
                  </div>
                </div>
                <div className="mt-1 text-[11px] leading-relaxed text-ink-3 line-clamp-2">
                  {item.desc}
                </div>
              </button>
            ))
          })()}
        </div>
      </div>
    </>
  )

  return (
    <div className="relative flex h-full min-w-0 flex-1 flex-col bg-canvas">
      {/* 顶栏：不画分隔线，只在滚动后浮起一层柔影 —— 少一条硬线，整体就没那么「线框」 */}
      <header
        className={`z-20 flex h-14 shrink-0 items-center gap-2 bg-canvas/85 px-4 transition-shadow duration-200 ease-out ${
          scrolled ? 'header-elevated' : ''
        }`}
      >
        <div className="flex min-w-0 items-center gap-2">
          {!sidebarOpen && (
            <button
              onClick={toggleSidebar}
              className="r-sm press -ml-1 flex h-8 w-8 items-center justify-center text-ink-2 transition-ui hover:bg-hover"
              aria-label="展开侧边栏"
            >
              <PanelLeftOpen size={17} />
            </button>
          )}
          <h1
            key={active?.id ?? 'brand'}
            className="anim-fade-in truncate text-[15px] font-medium text-ink-1"
          >
            {active && !empty ? active.title : 'FlyChat'}
          </h1>
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-1">
          {active && active.messages.length > 0 && (
            <>
              <button
                onClick={() => setUsingContext(active.id, active.usingContext === false)}
                // aria-pressed：让读屏知道这是「开关」而非普通按钮
                aria-pressed={active.usingContext !== false}
                className={`r-sm press flex h-8 items-center gap-1.5 px-2.5 text-xs transition-ui ${
                  active.usingContext === false
                    ? 'text-ink-3 hover:bg-hover hover:text-ink-1'
                    : 'bg-accent-soft font-medium text-accent'
                }`}
                title="开启后会携带历史消息作为上下文"
              >
                <Repeat size={13} />
                {/* 窄屏只留图标，给顶栏腾出空间 */}
                <span className="hidden sm:inline">上下文</span>
              </button>
              <div className="relative" ref={exportRef}>
                <button
                  onClick={() => setExportOpen((v) => !v)}
                  className="r-sm press flex h-8 items-center gap-1.5 px-2.5 text-xs text-ink-2 transition-ui hover:bg-hover"
                  aria-label="导出"
                  aria-haspopup="menu"
                  aria-expanded={exportOpen}
                >
                  <Download size={14} />
                  {/* 与「上下文」按钮一致：窄屏只留图标，其余屏位补文字 */}
                  <span className="hidden sm:inline">导出</span>
                </button>
                <div onMouseLeave={() => setExportOpen(false)}>
                  <MenuPanel
                    open={exportOpen}
                    position="absolute right-0 top-9 z-40 w-40"
                    origin="top-right"
                    label="导出会话"
                  >
                    <MenuItem
                      icon={<FileText size={14} />}
                      onClick={() => {
                        handleExportMarkdown()
                        setExportOpen(false)
                      }}
                    >
                      Markdown
                    </MenuItem>
                    <MenuItem
                      icon={<FileJson size={14} />}
                      onClick={() => {
                        handleExportJson()
                        setExportOpen(false)
                      }}
                    >
                      JSON
                    </MenuItem>
                    <MenuItem
                      icon={<ImageIcon size={14} />}
                      onClick={() => {
                        void handleExportImage()
                        setExportOpen(false)
                      }}
                    >
                      图片
                    </MenuItem>
                  </MenuPanel>
                </div>
              </div>
            </>
          )}
          {!empty && (
            <div className="flex items-center gap-1.5">
              <ModelSelector providers={providers} />
              <PresetSelector placement="bottom" />
            </div>
          )}
        </div>
      </header>

      {noticePresence.mounted && (
        <div
          role="status"
          className={`flex items-center gap-2 bg-panel px-4 py-2 text-xs text-ink-2 shadow-1 ${
            noticePresence.closing ? 'anim-fade-out' : 'anim-fade-down'
          }`}
        >
          {/* notice 清空后仍要显示原文，否则退场动画期间文字会先消失 */}
          <span className="flex-1">{notice || lastNoticeRef.current}</span>
          <button
            onClick={() => setNotice('')}
            className="press text-ink-3 transition-ui hover:text-ink-1"
            aria-label="关闭提示"
          >
            <X size={13} />
          </button>
        </div>
      )}

      {/* 空态：星系微粒环境光 + 问候语 + 居中大输入框 */}
      {empty ? (
        <main
          ref={emptyScrollRef}
          onScroll={onScroll}
          className="relative flex flex-1 flex-col items-center justify-center overflow-y-auto px-5 py-10 sm:px-6"
        >
          <ConstellationHero />
          <div className="relative z-10 w-full max-w-2xl">
            {/* 外层做视差（transform 由 CSS 变量驱动），内层做入场，两者互不覆盖 */}
            <div
              ref={heroRef}
              className="parallax-hero mb-7 flex flex-col items-center gap-3 text-center"
            >
              <div
                className="anim-scale-in relative mb-1 flex items-center justify-center"
                style={{ animationDelay: staggerDelay(0, 60) }}
              >
                <BrandIcon size={52} glow />
              </div>
              <div className="anim-fade-up" style={{ animationDelay: staggerDelay(1, 60) }}>
                {/* text-balance：空态标题不会截断，可安全启用平衡换行（避免中文末尾孤字） */}
                <h2 className="text-balance text-[22px] font-semibold leading-tight tracking-tight text-ink-1 sm:text-[26px]">
                  {timeGreeting()}，有什么可以帮你？
                </h2>
                <p
                  className="anim-fade-up mx-auto mt-2 max-w-md text-sm leading-6 text-ink-2"
                  style={{ animationDelay: staggerDelay(2, 60) }}
                >
                  {ready
                    ? '支持流式输出、思考过程、公式与图表、图片文档上传、联网搜索与多模型对比。'
                    : '服务端还没有配置 API Key。把 server/.env.example 复制为 server/.env，填入至少一个提供商的 Key 后重启后端。'}
                </p>
              </div>
            </div>

            <div className="anim-fade-up" style={{ animationDelay: staggerDelay(3, 60) }}>
              <Composer
                variant="hero"
                footer={heroFooter}
                onSend={handleSend}
                onStop={handleStop}
                streaming={streaming}
                disabled={!ready}
                disabledHint={
                  providers.length === 0
                    ? '请先在 server/.env 配置 API Key 并重启后端'
                    : '请先在上方选择模型'
                }
                webSearchAvailable={webSearchAvailable}
              />

              {!ready && (
                <button
                  onClick={() => setShowSettings(true)}
                  className="press hover-lift r-sm mx-auto mt-4 flex w-fit items-center gap-1.5 bg-accent px-4 py-2 text-sm font-medium text-on-accent transition-ui"
                >
                  去设置
                </button>
              )}
            </div>
          </div>
        </main>
      ) : (
        <>
          {/* 消息区 */}
          <main ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-y-auto">
            <div ref={captureRef} className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-5 sm:py-8">
              {/* key 绑定会话 id：切换会话即整块淡入，相当于路由转场 */}
              <div key={activeId ?? 'empty'} className="anim-fade-in space-y-7">
                {/* 更早的消息按需加载，避免上百条对话一次全挂载导致卡顿 */}
                {renderFrom > 0 && (
                  <button
                    onClick={() => setExtraPages((n) => n + 1)}
                    className="r-sm press mx-auto flex items-center gap-1.5 border border-rule bg-panel px-3.5 py-2 text-xs text-ink-2 shadow-1 transition-ui hover:bg-hover hover:text-ink-1"
                  >
                    加载更早的 {Math.min(renderFrom, MESSAGE_PAGE)} 条消息
                    <span className="tnum text-ink-3">（还有 {renderFrom} 条）</span>
                  </button>
                )}
                {renderedUnits.map((unit, ui) => {
                  const isLast = ui === lastUnitIndex
                  // 只让末尾若干条播放入场动画：切会话时其余内容跟着容器整块淡入
                  const enter = ui >= enterFrom
                  if (unit.type === 'group') {
                    const isStreamingGroup = unit.items.some((it) => streamingIds.includes(it.message.id))
                    return (
                      <div key={unit.id} className="r-xl overflow-hidden bg-panel shadow-1">
                        <div className="flex items-center gap-1.5 bg-hover-soft px-3.5 py-2 text-[11px] text-ink-3">
                          <Columns3 size={12} />
                          多模型对比 · {unit.items.length} 个回答
                        </div>
                        <div className="divide-y divide-[var(--rule)] bg-canvas">
                          {unit.items.map((it) => (
                            <div key={it.message.id} className="p-3.5">
                              <div className="mb-2 text-[11px] font-medium text-ink-3">
                                {it.message.model}
                              </div>
                              <MessageItem
                                message={it.message}
                                streaming={streamingIds.includes(it.message.id)}
                                isLastAssistant={isLast && !isStreamingGroup}
                                enter={enter}
                                onRegenerate={handleRegenerate}
                                onDelete={handleDelete}
                                onShare={(msg) => setShareTarget(msg)}
                                onToggleStar={(messageId) => active && toggleMessageStar(active.id, messageId)}
                                onSwitchVariant={(messageId, idx) => active && switchMessageVariant(active.id, messageId, idx)}
                                onPickSuggestion={(s) => handleSend(s, [])}
                              />
                            </div>
                          ))}
                        </div>
                      </div>
                    )
                  }
                  const m = unit.items[0].message
                  const isLastAssistant =
                    m.role === 'assistant' &&
                    !active!.messages.slice(unit.items[0].index + 1).some((x) => x.role === 'assistant')
                  return (
                    <MessageItem
                      key={m.id}
                      message={m}
                      streaming={streamingIds.includes(m.id)}
                      isLastAssistant={isLastAssistant && !streaming}
                      enter={enter}
                      onRegenerate={handleRegenerate}
                      onEdit={m.role === 'user' ? handleEdit : undefined}
                      onDelete={handleDelete}
                      onShare={(msg) => setShareTarget(msg)}
                      onToggleStar={(messageId) => active && toggleMessageStar(active.id, messageId)}
                      onSwitchVariant={(messageId, idx) => active && switchMessageVariant(active.id, messageId, idx)}
                      onPickSuggestion={(s) => handleSend(s, [])}
                    />
                  )
                })}
              </div>
              <div ref={bottomRef} className="h-1" />
            </div>
          </main>

          {/* 回到底部：外层负责居中，内层做缩放入场，避免 transform 互相覆盖 */}
          {!atBottom && (
            <div className="pointer-events-none absolute bottom-32 left-1/2 z-10 -translate-x-1/2">
              <button
                onClick={scrollToBottom}
                className="anim-scale-in pointer-events-auto r-sm flex h-9 w-9 items-center justify-center border border-rule bg-raised text-ink-2 shadow-2 transition-ui hover-lift press hover:bg-hover"
                aria-label="回到底部"
              >
                <ArrowDown size={16} />
              </button>
            </div>
          )}

          {/* 底部输入框 */}
          <div className="shrink-0 px-4 pt-2 pb-safe">
            <div className="mx-auto w-full max-w-3xl">
              <Composer
                variant="inline"
                onSend={handleSend}
                onStop={handleStop}
                streaming={streaming}
                disabled={!ready}
                disabledHint={
                  providers.length === 0
                    ? '请先在 server/.env 配置 API Key 并重启后端'
                    : '请先在上方选择模型'
                }
                webSearchAvailable={webSearchAvailable}
              />
            </div>
          </div>
        </>
      )}

      {/* 社交分享卡片弹窗 */}
      <ShareCardModal
        open={!!shareTarget}
        onClose={() => setShareTarget(null)}
        userMessage={
          shareTarget && active
            ? active.messages
                .slice(0, active.messages.findIndex((m) => m.id === shareTarget.id))
                .reverse()
                .find((m) => m.role === 'user') ?? null
            : null
        }
        assistantMessage={shareTarget}
        conversationTitle={active?.title}
      />
    </div>
  )
}
