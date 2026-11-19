/**
 * Human-facing `/instructions` copy and the locale that selects it.
 *
 * Only command results are localized. Model-visible text stays English: the
 * `<system-reminder>` frames from `render.ts` and the custom-root notice are
 * part of the prompt format shared with the shipped loader, and translating
 * them would make one policy produce different model input per UI language.
 *
 * `auto` follows the reader, not the machine that happens to host the process.
 * The Host locale service is browser-side only, so the closest Host-visible
 * facts are the explicit DSH language preference (stored on the `locale`
 * profile row) and the operating-system language that a browser on this machine
 * would start from. An unsupported DSH language (the Web client ships eight)
 * falls back to English rather than to a third locale.
 *
 * @module dsh-instructions-policy/i18n
 */

import type { ConfigEditorLike } from './types.ts'

/** Language of one command result. */
export type CommandLocale = 'zh' | 'en'

/** Row setting that selects the command-result language. */
export type LocaleMode = 'auto' | CommandLocale

/** Every accepted `locale` row value. */
export const LOCALE_MODES: readonly LocaleMode[] = ['auto', 'zh', 'en']

/** Package name of the shipped locale plugin, the owner of the DSH language preference. */
const LOCALE_PLUGIN = '@deepseek-ai/dsh-client-locale'

/** Entry id of the locale row in the shipped Web bundle, used when the package moves. */
const LOCALE_ENTRY_ID = 'locale'

/** Inputs that resolve {@link LocaleMode} `auto`. */
export interface LocaleSources {
  /** Profile configuration service; supplies the explicit DSH language preference. */
  readonly configEditor?: ConfigEditorLike
  /** Operating-system language tag; tests pass a fixed value instead of this machine's. */
  readonly systemLocale?: string
}

/** Every string one `/instructions` result can carry, in one language. */
export interface Messages {
  /** First line of every result. */
  readonly title: string
  readonly rootLabel: string
  /** `policy.root` value `default`. */
  readonly rootDefault: string
  /** `policy.root` value `off`. */
  readonly rootOff: string
  /** `policy.root` value `custom`, naming the replacement file. */
  readonly rootCustom: (name: string) => string
  readonly globalLabel: string
  readonly nestedLabel: string
  readonly on: string
  readonly off: string
  readonly lockedNotice: string
  readonly changeHint: string
  /** `project root:` line, resolved rather than symbolic. */
  readonly projectRoot: (path: string) => string
  /** `files:` line; an empty list reports that nothing is loaded. */
  readonly files: (paths: readonly string[]) => string
  /** `not loaded (budget):` line for discovered files the renderer dropped. */
  readonly notLoaded: (paths: readonly string[]) => string
  readonly budgetDisabled: string
  readonly rootFileProblemLabel: string
  readonly problemMissing: string
  readonly problemOutside: string
  readonly detailsUnavailable: (reason: string) => string
  readonly lockedError: string
  readonly usageNested: string
  readonly usageGlobal: string
  readonly usageRoot: string
  readonly usageCustomRoot: string
  readonly usageAttach: string
  readonly usageShow: string
  readonly unsupportedType: string
  readonly exceedsSource: string
  readonly lengthMismatch: string
  readonly notText: string
  readonly empty: string
  readonly importUnavailable: string
  readonly importFailed: (reason: string) => string
}

/** Command-result copy keyed by locale. */
export const MESSAGES: Record<CommandLocale, Messages> = {
  en: {
    title: 'Instructions policy',
    rootLabel: 'root',
    rootDefault: 'default',
    rootOff: 'off',
    rootCustom: name => `custom (${name})`,
    globalLabel: 'user-global',
    nestedLabel: 'subdirectory discovery',
    on: 'on',
    off: 'off',
    lockedNotice: 'root, file, and the user-global switch are locked after the first turn.',
    changeHint: 'Use /instructions root|global|nested to change this session.',
    projectRoot: path => `project root: ${path}`,
    files: paths => paths.length === 0 ? 'files: none' : `files: ${paths.join(', ')}`,
    notLoaded: paths => `not loaded (budget): ${paths.join(', ')}`,
    budgetDisabled: 'budget: disabled (maxBytes: 0)',
    rootFileProblemLabel: 'root file problem',
    problemMissing: 'missing',
    problemOutside: 'outside the project root',
    detailsUnavailable: reason => `details unavailable: ${reason}`,
    lockedError: 'The instruction root and user-global switch are locked after the first turn; only nested discovery stays switchable.',
    usageNested: 'Usage: /instructions nested on|off',
    usageGlobal: 'Usage: /instructions global on|off',
    usageRoot: 'Usage: /instructions root default | /instructions root custom <path>',
    usageCustomRoot: 'Usage: /instructions root custom <path>',
    usageAttach: 'Usage: /instructions root attach <attachmentId> <bytes> <name>',
    usageShow: 'Usage: /instructions [show] | root default|custom <path> | global on|off | nested on|off',
    unsupportedType: 'unsupported file type: only .md, .markdown, and .txt are accepted',
    exceedsSource: 'attachment exceeds maxSourceBytes',
    lengthMismatch: 'attachment length does not match the uploaded size',
    notText: 'attachment is not a text file',
    empty: 'attachment is empty',
    importUnavailable: 'attachment import is unavailable on this host',
    importFailed: reason => `attachment import failed: ${reason}`,
  },
  zh: {
    title: '指令策略',
    // The layer is the *file* that stands in for the project root; the resolved
    // directory has its own line, so the two labels must not collide.
    rootLabel: '根文件',
    rootDefault: '默认',
    rootOff: '关闭',
    rootCustom: name => `自定义 (${name})`,
    globalLabel: '用户级',
    nestedLabel: '子目录追加',
    on: '开',
    off: '关',
    lockedNotice: '首个回合后，项目根、项目根文件与用户级开关已锁定。',
    changeHint: '用 /instructions root|global|nested 修改本任务。',
    projectRoot: path => `项目根: ${path}`,
    files: paths => paths.length === 0 ? '已加载: 无' : `已加载: ${paths.join(', ')}`,
    notLoaded: paths => `因预算未加载: ${paths.join(', ')}`,
    budgetDisabled: '预算: 已关闭 (maxBytes: 0)',
    rootFileProblemLabel: '根文件问题',
    problemMissing: '不存在',
    problemOutside: '在项目根之外',
    detailsUnavailable: reason => `详情不可用: ${reason}`,
    lockedError: '首个回合后，项目根与用户级开关已锁定；只有子目录追加还能继续切换。',
    usageNested: '用法: /instructions nested on|off',
    usageGlobal: '用法: /instructions global on|off',
    usageRoot: '用法: /instructions root default | /instructions root custom <path>',
    usageCustomRoot: '用法: /instructions root custom <path>',
    usageAttach: '用法: /instructions root attach <attachmentId> <bytes> <name>',
    usageShow: '用法: /instructions [show] | root default|custom <path> | global on|off | nested on|off',
    unsupportedType: '不支持的文件类型：仅接受 .md、.markdown、.txt',
    exceedsSource: '附件超过 maxSourceBytes',
    lengthMismatch: '附件长度与上传大小不一致',
    notText: '附件不是文本文件',
    empty: '附件为空',
    importUnavailable: '当前主机不支持附件导入',
    importFailed: reason => `附件导入失败: ${reason}`,
  },
}

/**
 * Read the copy for one locale.
 * @param locale - resolved command-result language.
 * @returns the message set for that language.
 */
export function messagesFor(locale: CommandLocale): Messages {
  return MESSAGES[locale]
}

/**
 * Map one language tag onto a shipped command-result language.
 * @param tag - BCP 47 tag, possibly with an `_` separator or a region suffix.
 * @returns the shipped language, or undefined for a language this plugin does not translate.
 */
function matchLocale(tag: string): CommandLocale | undefined {
  const primary = tag.trim().toLowerCase().replaceAll('_', '-').split('-')[0]
  if (primary === 'zh') return 'zh'
  if (primary === 'en') return 'en'
  return undefined
}

/**
 * Read the explicit DSH language preference from the profile.
 *
 * The preference is the locale row's own `config.preference` (a volatile field
 * the settings form writes into the profile patch), so this reads the running
 * composition instead of re-parsing files. Any failure degrades to "no
 * preference": an unavailable profile service must not decide the language.
 * @param editor - profile configuration service, when the profile provides it.
 * @returns the stored preference, or undefined when the reader never chose one.
 */
function localePreference(editor: ConfigEditorLike | undefined): string | undefined {
  let entries
  try {
    entries = editor?.entries?.() ?? []
  } catch {
    return undefined
  }
  for (const entry of entries) {
    if (entry.options.name !== LOCALE_PLUGIN && entry.options.id !== LOCALE_ENTRY_ID) continue
    const config = entry.options.config
    if (typeof config !== 'object' || config === null) continue
    const preference: unknown = Reflect.get(config, 'preference')
    if (typeof preference === 'string' && preference.trim().length > 0) return preference
  }
  return undefined
}

/**
 * The language a browser on this machine would start from.
 * @returns the operating-system language tag (for example `zh-CN`).
 */
export function systemLocaleTag(): string {
  return Intl.DateTimeFormat().resolvedOptions().locale
}

/**
 * Resolve the language of a command result.
 *
 * `auto` asks, in order: what language did the reader pick in DSH, and what
 * language does this machine use. An explicit DSH language this plugin does not
 * translate falls back to English, because the reader already chose a language
 * deliberately and the system tag would contradict that choice.
 * @param mode - the row's `locale` value.
 * @param sources - profile configuration service and the system tag override.
 * @returns the language for the next command result.
 */
export function resolveCommandLocale(mode: LocaleMode, sources: LocaleSources = {}): CommandLocale {
  if (mode === 'zh' || mode === 'en') return mode
  const preference = localePreference(sources.configEditor)
  if (preference !== undefined) return matchLocale(preference) ?? 'en'
  return matchLocale(sources.systemLocale ?? systemLocaleTag()) ?? 'en'
}
