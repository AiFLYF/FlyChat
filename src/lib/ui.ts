/**
 * 可复用的样式片段（class 字符串常量）。
 *
 * 改动原因：此前「输入框 / 下拉面板 / 菜单项 / 图标按钮 / 标签胶囊」的
 * 一长串 class 在 Sidebar、ModelSelector、PromptPicker、ChatWindow、
 * SettingsModal、MarkdownRenderer 里各写了一遍，改一处要同步六处。
 * 统一收在这里后，视觉调整只需改这一份常量。
 *
 * 说明：这里刻意只放 class 片段（不是组件），因为它们多数是
 * 「外层容器自己控制布局 + 内层套用外观」的组合场景，做成组件反而要透传一堆 props。
 */

/**
 * 表单输入：文本框 / 数字框 / 搜索框 通用外观。
 *
 * 焦点态刻意「不改描边色」：全局 :focus-visible 已经给了 2px 实色环，
 * 若再叠 focus:border-accent，1px 描边 + 2px 环会糊成 3px 厚蓝边（视觉很重）。
 * 保持中性描边 + 单圈蓝环 = 行业标准的 focus ring 观感。
 */
export const FIELD =
  'r-sm w-full border border-rule bg-canvas px-3 py-1.5 text-[13px] text-ink-1 outline-none ' +
  'transition-ui placeholder:text-ink-3 disabled-x'

/** 搜索框：左侧带图标时用，左侧内边距留出图标位 */
export const SEARCH_FIELD =
  'r-sm w-full border border-rule bg-canvas py-1.5 pl-7 pr-2 text-[13px] text-ink-1 outline-none ' +
  'transition-ui placeholder:text-ink-3 disabled-x'

/** 浮层面板：下拉菜单 / 弹出层通用（圆角、描边、投影、入场动画已内联） */
export const PANEL = 'border border-rule bg-panel shadow-3'

/** 面板里的可点击行 */
export const MENU_ITEM =
  'flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] text-ink-2 transition-ui ' +
  'hover:bg-hover hover:text-ink-1 disabled-x'

/** 图标按钮：统一热区与圆角，避免各处 h-6/h-7/h-8 混用 */
export const ICON_BTN =
  'r-sm flex shrink-0 items-center justify-center text-ink-3 transition-ui press ' +
  'hover:bg-hover hover:text-ink-1 disabled-x'

/** 小号图标按钮（侧边栏会话行内操作，6×6） */
export const ICON_BTN_SM =
  'flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-ink-3 transition-ui ' +
  'hover:bg-panel hover:text-ink-1 disabled-x'

/** 次要操作按钮（描边式） */
export const BUTTON_GHOST =
  'r-sm flex items-center gap-1.5 border border-rule px-3 py-1.5 text-[13px] text-ink-2 ' +
  'transition-ui press hover:bg-hover hover:text-ink-1 disabled-x'

/** 主要操作按钮（实心强调色） */
export const BUTTON_PRIMARY =
  'r-sm flex items-center gap-1.5 bg-accent px-3 py-1.5 text-[13px] font-medium text-on-accent ' +
  'transition-ui press hover:bg-accent-hover disabled-x'

/** 空状态文案容器：居中、次要色、行高舒适 */
export const EMPTY_HINT = 'px-3 py-6 text-center text-xs leading-5 text-ink-3'

/** 分组小标题 */
export const GROUP_LABEL = 'px-2 pb-1 text-[11px] font-medium tracking-wide text-ink-3'
