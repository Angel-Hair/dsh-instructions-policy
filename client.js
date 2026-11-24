/**
 * Browser half: one control in the composer tool row, immediately after the
 * permission and plan controls (conversation.input.left).
 *
 * The trigger is unchanged from the shipped plugin. Everything opened from it
 * is a custom body inside the official Menu shell, so positioning, dismissal,
 * focus return, and keyboard traversal stay native while the rows can use the
 * switch, indentation, and tonal hierarchy of the redesign.
 *
 * The visual layer is a scoped stylesheet (`dsp-` classes, only --dsw-* tokens),
 * injected once per page. Writes still go through /instructions; reads still
 * come from the instructionsPolicy projection.
 */

window.__ModuleLoader__.load({
  id: 'dsh-instructions-policy',
  factory: (require) => {
    const React = require('react')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')

    const h = React.createElement
    const NS = 'instructionsPolicy'
    const PROJECTION_KEY = 'instructionsPolicy'
    const STYLE_ID = 'dsh-instructions-policy-ui'
    const DEFAULTS = { root: 'default', file: null, global: true, nested: true }

    const dictionaries = {
      zh: {
        chip: '指令策略',
        chipTitle: '指令策略',
        menuHeading: '指令策略',
        projectRootLabel: '项目根',
        projectRootNotStarted: '任务开始后解析',
        projectRootUnresolved: '未解析',
        loadedLabel: '已加载',
        noneLabel: '无',
        listSeparator: '、',
        onLabel: '开',
        offLabel: '关',
        global: '用户级',
        nested: '子目录追加',
        sectionInitial: '初始引入',
        sectionSession: '会话中',
        sectionInitialHint: '首回合后锁定',
        sectionLockedHint: '已锁定',
        sectionSessionHint: '下一步生效',
        lockedPill: '已锁定',
        rootFile: '项目根文件',
        rootFileDefaultSub: 'AGENTS.md · CLAUDE.md',
        rootFileOffSub: '已关闭 · 仅加载当前目录链',
        rootFileCustomSub: '已被 {name} 替代',
        rootFileTip: '默认读取项目根的 AGENTS.md / CLAUDE.md；关闭只跳过这一层。首回合后锁定。',
        rootFileCustomTip: '这一层当前由自定义文件替代；关闭自定义文件即可恢复。',
        customFile: '自定义文件',
        customFileSub: '从本机导入一个文件替代项目根',
        customFileImportedSub: '导入副本 · {name}',
        customFileTip: '从本机选择 .md / .markdown / .txt 文件导入为附件，替代项目根这一层；导入的是快照，原文件后续变化不会自动同步。关闭后恢复之前的设置。',
        globalSub: '~/.dsh · ~/.agents',
        globalTip: '读取 ~/.dsh/AGENTS.md 与 ~/.agents/AGENTS.md；首回合后锁定。',
        nestedSub: '读取子目录文件时追加',
        nestedTip: '读取或编辑子目录文件时追加该目录的 AGENTS.md；随时可切，下一步生效。',
        statusBusy: '应用中…',
        statusStaged: '任务尚未开始 · 选择将在任务开始时应用',
        statusDisconnected: '会话未连接 · 选择将在任务开始时应用',
        statusStale: '状态未刷新 · 请重试',
        applying: '应用中…',
        staged: '任务开始时应用',
        failed: '切换失败：{reason}',
        unsupportedFile: '仅支持 .md / .markdown / .txt',
      },
      en: {
        chip: 'Instruction policy',
        chipTitle: 'Instruction policy',
        menuHeading: 'Instruction policy',
        projectRootLabel: 'Project root',
        projectRootNotStarted: 'Resolved when the task starts',
        projectRootUnresolved: 'not resolved',
        loadedLabel: 'Loaded',
        noneLabel: 'none',
        listSeparator: ', ',
        onLabel: 'on',
        offLabel: 'off',
        global: 'User-global',
        nested: 'Subdirectory append',
        sectionInitial: 'Initial files',
        sectionSession: 'During the session',
        sectionInitialHint: 'Locked after the first turn',
        sectionLockedHint: 'Locked',
        sectionSessionHint: 'Applies next step',
        lockedPill: 'Locked',
        rootFile: 'Project-root file',
        rootFileDefaultSub: 'AGENTS.md · CLAUDE.md',
        rootFileOffSub: 'Off · only the current directory chain',
        rootFileCustomSub: 'Replaced by {name}',
        rootFileTip: 'Loads the project root\u2019s AGENTS.md / CLAUDE.md; Off skips only that layer. Locked after the first turn.',
        rootFileCustomTip: 'This layer is replaced by the custom file; turn custom off to restore it.',
        customFile: 'Custom file',
        customFileSub: 'Import a local file to replace the project root',
        customFileImportedSub: 'Imported copy · {name}',
        customFileTip: 'Choose a .md / .markdown / .txt file, import it as an attachment, and use it to replace the project-root layer; the import is a snapshot and later edits to the original file are not tracked. Turning it off restores the previous setting.',
        globalSub: '~/.dsh · ~/.agents',
        globalTip: 'Reads ~/.dsh/AGENTS.md and ~/.agents/AGENTS.md; locked after the first turn.',
        nestedSub: 'Appended when reading a subdirectory',
        nestedTip: 'Appends a directory AGENTS.md when a file inside is read or edited; switchable, applies next step.',
        statusBusy: 'Applying…',
        statusStaged: 'Task not started · applied when the task starts',
        statusDisconnected: 'Session not connected · applied when the task starts',
        statusStale: 'State did not refresh · try again',
        applying: 'Applying…',
        staged: 'Applied when the task starts',
        failed: 'Switch failed: {reason}',
        unsupportedFile: 'Only .md, .markdown, and .txt are supported',
      },
    }

    /* ------------------------------------------------------------------
       Scoped stylesheet. Every selector is dsp-prefixed; every color,
       radius, shadow, and focus ring is an official --dsw-* token so the
       control follows the Web theme (light and dark) automatically.
       ------------------------------------------------------------------ */
    const STYLES = String.raw`
      .dsp-menu-body {
        box-sizing: border-box;
        width: 292px;
        padding: 1px;
      }
      .dsp-menu-head { padding: 8px 8px 7px; }
      .dsp-menu-head-row {
        display: flex;
        align-items: center;
        gap: 8px;
        min-width: 0;
      }
      .dsp-menu-title {
        color: var(--dsw-alias-label-primary);
        font-size: 13px;
        font-weight: 600;
        letter-spacing: -.01em;
        line-height: 18px;
      }
      .dsp-lock-pill {
        display: inline-flex;
        align-items: center;
        gap: 3px;
        margin-left: auto;
        padding: 1px 6px;
        border: .5px solid var(--dsw-alias-border-l2);
        border-radius: 999px;
        color: var(--dsw-alias-label-tertiary);
        font-size: 9.5px;
        font-weight: 500;
        line-height: 14px;
        white-space: nowrap;
      }
      .dsp-lock-pill .dsp-icon { width: 9px; height: 9px; }
      .dsp-menu-path {
        display: flex;
        align-items: baseline;
        gap: 6px;
        min-width: 0;
        margin-top: 3px;
        color: var(--dsw-alias-label-tertiary);
        font-size: 10.5px;
        line-height: 15px;
      }
      .dsp-menu-path > span { flex: none; }
      .dsp-menu-path code {
        min-width: 0;
        overflow: hidden;
        color: var(--dsw-alias-label-secondary);
        font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Consolas, monospace);
        font-size: 10px;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .dsp-section {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 8px;
        padding: 8px 8px 3px;
        color: var(--dsw-alias-label-caption);
        font-size: 10px;
        font-weight: 600;
        letter-spacing: .04em;
        line-height: 14px;
      }
      .dsp-section-hint {
        color: var(--dsw-alias-label-tertiary);
        font-size: 9.5px;
        font-weight: 400;
        letter-spacing: 0;
        white-space: nowrap;
      }
      .dsp-divider {
        height: .5px;
        margin: 5px 7px;
        background: var(--dsw-alias-border-l1);
      }
      .dsp-row {
        position: relative;
        display: flex;
        align-items: center;
        gap: 12px;
        box-sizing: border-box;
        width: 100%;
        min-height: 34px;
        padding: 6px 8px;
        border: 0;
        border-radius: 10px;
        background: transparent;
        color: inherit;
        font: inherit;
        text-align: left;
        cursor: pointer;
      }
      .dsp-row:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
      .dsp-row:active:not(:disabled) { background: var(--dsw-alias-interactive-bg-active); }
      .dsp-row:focus-visible {
        outline: 2px solid color-mix(in srgb, var(--dsw-alias-state-business-primary) 65%, transparent);
        outline-offset: -1px;
      }
      .dsp-row:disabled { cursor: default; }
      .dsp-row:disabled .dsp-row-name { color: var(--dsw-alias-label-secondary); }
      .dsp-row:disabled .dsp-row-sub { color: var(--dsw-alias-label-caption); }
      .dsp-row:disabled .dsp-switch { opacity: .6; }
      .dsp-row[data-pending="true"] .dsp-switch { opacity: .55; }
      .dsp-row[data-busy="true"] .dsp-switch-thumb { animation: dsp-pulse 1.1s ease-in-out infinite; }

      /*
       * Custom-file is a child of the project-root layer, not a peer. It stays
       * in the flat list, indents, and hangs from a hairline elbow drawn with
       * borders instead of a literal └ glyph.
       */
      .dsp-row.is-child { padding-left: 38px; }
      .dsp-row.is-child::before {
        content: "";
        position: absolute;
        left: 18px;
        top: 0;
        width: 12px;
        height: 50%;
        border-left: 1px solid var(--dsw-alias-border-l3);
        border-bottom: 1px solid var(--dsw-alias-border-l3);
        border-bottom-left-radius: 6px;
        pointer-events: none;
      }

      .dsp-row-text {
        display: flex;
        flex-direction: column;
        gap: 1px;
        flex: 1 1 auto;
        min-width: 0;
      }
      .dsp-row-name {
        overflow: hidden;
        color: var(--dsw-alias-label-primary);
        font-size: 12.5px;
        font-weight: 500;
        line-height: 17px;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .dsp-row-sub {
        overflow: hidden;
        color: var(--dsw-alias-label-tertiary);
        font-size: 10.5px;
        line-height: 15px;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      /* Official Switch geometry: 36 x 20, 2px inset, 16px thumb, 16px travel. */
      .dsp-switch {
        position: relative;
        flex: 0 0 auto;
        width: 36px;
        height: 20px;
        box-sizing: border-box;
        padding: 2px;
        border-radius: 999px;
        background: var(--dsw-alias-border-l3);
        transition: background .16s ease;
      }
      .dsp-switch.is-on { background: var(--dsw-alias-state-business-primary); }
      .dsp-switch-thumb {
        display: block;
        width: 16px;
        height: 16px;
        border-radius: 50%;
        background: var(--dsw-alias-switch-thumb);
        transition: transform .16s cubic-bezier(.2, .8, .2, 1), background .16s ease;
      }
      .dsp-switch.is-on .dsp-switch-thumb {
        background: var(--dsw-alias-label-primary-foreground);
        transform: translateX(16px);
      }
      .dsp-switch.is-disabled { opacity: .6; }

      .dsp-status {
        display: flex;
        align-items: flex-start;
        gap: 6px;
        margin: 5px 6px 2px;
        padding: 6px 8px;
        border: .5px solid var(--dsw-alias-border-l1);
        border-radius: 8px;
        background: var(--dsw-alias-bg-layer-2);
        color: var(--dsw-alias-label-tertiary);
        font-size: 10.5px;
        line-height: 15px;
      }
      .dsp-status.is-error {
        border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 22%, transparent);
        background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 9%, transparent);
        color: var(--dsw-alias-state-error-primary);
      }
      .dsp-status.is-stale { color: var(--dsw-alias-label-tertiary); }
      .dsp-status-dot {
        width: 5px;
        height: 5px;
        margin-top: 5px;
        flex: none;
        border-radius: 50%;
        background: currentColor;
      }
      .dsp-status.is-busy .dsp-status-dot { animation: dsp-pulse 1s ease-in-out infinite; }

      .dsp-chip {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        min-width: 0;
        max-width: 220px;
        height: 28px;
        padding: 0 4px 0 8px;
        border: 0;
        border-radius: var(--dsw-radius-sm);
        outline: none;
        background: transparent;
        color: var(--dsw-alias-label-secondary);
        font: inherit;
        font-size: 13px;
        font-weight: 500;
        line-height: 20px;
        cursor: pointer;
      }
      .dsp-chip-wrap {
        display: inline-flex;
        align-items: center;
        gap: 4px;
      }
      .dsp-chip:hover { background: var(--dsw-alias-interactive-bg-hover); }
      .dsp-chip:focus-visible {
        outline: 2px solid var(--dsw-alias-state-business-primary);
        outline-offset: 1px;
      }
      .dsp-chip-label {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .dsp-chip .dsp-icon { flex: none; color: var(--dsw-alias-label-caption); }
      .dsp-chip svg { width: 14px; height: 14px; }

      .dsp-notice {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        max-width: 190px;
        margin-left: 4px;
        padding: 2px 8px;
        overflow: hidden;
        border: .5px solid var(--dsw-alias-border-l1);
        border-radius: 999px;
        background: var(--dsw-alias-bg-layer-2);
        color: var(--dsw-alias-label-tertiary);
        font-size: 10.5px;
        line-height: 16px;
        white-space: nowrap;
        text-overflow: ellipsis;
      }
      .dsp-notice.is-error {
        border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 24%, transparent);
        background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 9%, transparent);
        color: var(--dsw-alias-state-error-primary);
      }
      .dsp-notice-dot {
        width: 5px;
        height: 5px;
        flex: none;
        border-radius: 50%;
        background: currentColor;
      }
      .dsp-notice.is-busy .dsp-notice-dot { animation: dsp-pulse 1s ease-in-out infinite; }

      .dsp-icon { width: 15px; height: 15px; flex: none; }

      @keyframes dsp-pulse {
        0%, 100% { opacity: .35; }
        50% { opacity: 1; }
      }
      @media (prefers-reduced-motion: reduce) {
        .dsp-notice.is-busy .dsp-notice-dot,
        .dsp-status.is-busy .dsp-status-dot { animation: none; }
        .dsp-row[data-busy="true"] .dsp-switch-thumb { animation: none; }
        .dsp-switch, .dsp-switch-thumb, .dsp-notice { transition: none; }
      }
      @media (max-width: 760px) {
        .dsp-menu-body { width: min(292px, calc(100vw - 48px)); }
      }
    `

    function ensureStyles() {
      if (typeof document === 'undefined') return
      if (document.getElementById(STYLE_ID) !== null) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = STYLES
      document.head.appendChild(style)
    }

    /* ---------------- icons ---------------- */

    function svg(className, viewBox, ...children) {
      return h('svg', {
        className,
        viewBox,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.4,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
      }, ...children)
    }

    function LockIcon() {
      return svg('dsp-icon', '0 0 16 16',
        h('rect', { key: 'r', x: 3.5, y: 7, width: 9, height: 6, rx: 1.5 }),
        h('path', { key: 'p', d: 'M5.5 7V5.5a2.5 2.5 0 015 0V7' }))
    }

    /* ---------------- shared helpers ---------------- */

    function attachmentPartsOf(file) {
      if (typeof file !== 'string' || !file.startsWith('dsh-attachment:')) return undefined
      const parts = file.slice('dsh-attachment:'.length).split('#')
      if (parts.length < 3 || !parts[0] || !parts[1]) return undefined
      return { id: parts[0], bytes: parts[1], encodedName: parts.slice(2).join('#') }
    }

    function attachmentNameOf(file) {
      const parts = attachmentPartsOf(file)
      if (!parts) return undefined
      try {
        return decodeURIComponent(parts.encodedName)
      } catch {
        return undefined
      }
    }

    function fileNameOf(path) {
      const parts = String(path || '').split(/[\\/]/)
      return parts[parts.length - 1] || String(path || '')
    }

    function policyFileLabel(file) {
      return attachmentNameOf(file) || String(file || '')
    }

    function rootFileLabel(file) {
      return fileNameOf(policyFileLabel(file))
    }

    const PROJECTION_TIMEOUT_MS = 1500

    function encodeAttachmentFile(ref) {
      return `dsh-attachment:${ref.attachmentId}#${ref.bytes}#${encodeURIComponent(ref.name)}`
    }

    function matchesTarget(policy, target) {
      if (!target || !policy) return true
      if (target.kind === 'root' || target.kind === 'custom') {
        return target.kind === 'custom'
          ? policy.root === 'custom' && policy.file === target.file
          : policy.root === target.value
      }
      if (target.kind === 'global') return policy.global === target.value
      if (target.kind === 'nested') return policy.nested === target.value
      return true
    }

    function projectRootName(path) {
      return path ? fileNameOf(path) : ''
    }

    /** Chip tooltip: the project root (or its pending state), the loaded files, and both switches. */
    function chipTooltip(state, policy, t) {
      const lines = [t('chipTitle')]
      const root = state && (state.projectRoot || state.projectRootText)
      lines.push(`${t('projectRootLabel')}: ${root || t('projectRootUnresolved')}`)
      const loaded = state && Array.isArray(state.loaded) ? state.loaded : []
      lines.push(`${t('loadedLabel')}: ${loaded.length === 0 ? t('noneLabel') : loaded.join(t('listSeparator'))}`)
      lines.push([`${t('global')}: ${policy.global ? t('onLabel') : t('offLabel')}`,
        `${t('nested')}: ${policy.nested ? t('onLabel') : t('offLabel')}`].join(' · '))
      return lines.join('\n')
    }

    /* ---------------- menu body ---------------- */

    function layerButton({ t, layer, name, sub, on, disabled, child, title, busy, pending, onSelect, onRowFocus }) {
      return h('button', {
        type: 'button',
        role: 'menuitem',
        'data-layer': layer,
        'data-busy': busy ? 'true' : undefined,
        'data-pending': pending ? 'true' : undefined,
        'aria-busy': busy ? 'true' : undefined,
        'aria-label': `${name} · ${on ? t('onLabel') : t('offLabel')}`,
        className: `dsp-row${child ? ' is-child' : ''}`,
        disabled,
        title,
        onFocus: () => onRowFocus(layer),
        onClick: () => onSelect(layer),
      },
        h('span', { className: 'dsp-row-text' },
          h('span', { className: 'dsp-row-name' }, name),
          h('span', { className: 'dsp-row-sub' }, sub)),
        h('span', {
          className: `dsp-switch${on ? ' is-on' : ''}${disabled ? ' is-disabled' : ''}`,
          'data-on': String(on),
          'aria-hidden': 'true',
        }, h('span', { className: 'dsp-switch-thumb' })))
    }

    function sectionRow(title, hint) {
      return h('div', { className: 'dsp-section' },
        h('span', null, title),
        h('span', { className: 'dsp-section-hint' }, hint))
    }

    function menuStatus({ kind, text }) {
      return h('div', {
        className: `dsp-status is-${kind}`,
        role: 'status',
        title: text,
      },
        h('span', { className: 'dsp-status-dot', 'aria-hidden': 'true' }),
        h('span', null, text))
    }

    function policyMenuBody(props) {
      const {
        t, projectRoot, projectRootText, locked, current, rootCustom, rootSub, customSub,
        status, onSelect, busyLayer, pendingLayers, customIntent, onRowFocus, bodyRef,
      } = props
      const initialHint = locked ? t('sectionLockedHint') : t('sectionInitialHint')
      const queued = pendingLayers || new Set()
      const row = (options) => layerButton({
        ...options,
        t,
        busy: busyLayer === options.layer,
        pending: queued.has(options.layer),
        onSelect,
        onRowFocus,
      })

      return h('div', {
        className: 'dsp-menu-body',
        ref: bodyRef,
      },
        h('div', { className: 'dsp-menu-head' },
          h('div', { className: 'dsp-menu-head-row' },
            h('span', { className: 'dsp-menu-title' }, t('menuHeading')),
            locked
              ? h('span', { className: 'dsp-lock-pill' }, h(LockIcon, null), t('lockedPill'))
              : null),
          h('div', { className: 'dsp-menu-path' },
            h('span', null, t('projectRootLabel')),
            h('code', { title: projectRoot || '' },
              projectRoot ? projectRootName(projectRoot) : projectRootText))),
        sectionRow(t('sectionInitial'), initialHint),
        row({
          layer: 'root',
          name: t('rootFile'),
          sub: rootSub,
          on: current.root !== 'off' && !rootCustom,
          disabled: locked || rootCustom || customIntent,
          title: rootCustom ? t('rootFileCustomTip') : t('rootFileTip'),
        }),
        row({
          layer: 'custom',
          name: t('customFile'),
          sub: customSub,
          on: rootCustom,
          disabled: locked,
          child: true,
          title: t('customFileTip'),
        }),
        row({
          layer: 'global',
          name: t('global'),
          sub: t('globalSub'),
          on: current.global,
          disabled: locked,
          title: t('globalTip'),
        }),
        h('div', { className: 'dsp-divider' }),
        sectionRow(t('sectionSession'), t('sectionSessionHint')),
        row({
          layer: 'nested',
          name: t('nested'),
          sub: t('nestedSub'),
          on: current.nested,
          disabled: false,
          title: t('nestedTip'),
        }),
        status ? menuStatus(status) : null)
    }

    /* ---------------- chip ---------------- */

    function Chip(props) {
      const { sessionId, t, run, useProjection, upload } = props
      const [open, setOpen] = React.useState(false)
      const [busy, setBusy] = React.useState(null)
      const [, setQueueVersion] = React.useState(0)
      const [error, setError] = React.useState(null)
      const [stale, setStale] = React.useState(false)
      const [rootBeforeCustom, setRootBeforeCustom] = React.useState(null)
      const queueRef = React.useRef([])
      const activeRef = React.useRef(null)
      const processingRef = React.useRef(false)
      const timerRef = React.useRef(null)
      const sessionRef = React.useRef(sessionId)
      const triggerRef = React.useRef(null)
      const bodyRef = React.useRef(null)
      const focusedLayerRef = React.useRef(null)
      const policyRef = React.useRef(null)
      const staleTargetRef = React.useRef(null)
      // The host projection is the only policy source: it is folded from the
      // complete durable command log, so direct /instructions runs, resume,
      // compaction, and history paging all agree with the host.
      const projected = useProjection(PROJECTION_KEY)
      const base = (projected && projected.policy) || DEFAULTS
      const current = base
      const details = {
        projectRoot: projected && projected.projectRoot,
        loaded: projected && Array.isArray(projected.loaded) ? projected.loaded : [],
      }
      // The projection keeps the latest settled command, so a handler error
      // survives a remount or a reconnect instead of existing only in local
      // component state. A newer successful command clears it.
      const lastCommand = projected && projected.lastCommand
      const projectedError = lastCommand
        && lastCommand.kind === 'error'
        && typeof lastCommand.text === 'string'
        && lastCommand.text.length > 0
        ? lastCommand.text
        : null
      const lastCommandKey = lastCommand
        ? `${lastCommand.commandId || ''}:${lastCommand.seq === undefined ? '' : lastCommand.seq}`
        : ''
      const connected = sessionId !== undefined
      const disabled = Boolean(projected && projected.locked)
      // A session that exists but has not entered its first step has no project
      // root yet: the loader only resolves it when it composes the baseline.
      // Distinguish that from "connected but unresolved" and from a real
      // disconnection, so the chip does not sit on "resolving…" forever.
      const notStarted = !details.projectRoot && !disabled
      details.projectRootText = details.projectRoot
        ? ''
        : notStarted ? t('projectRootNotStarted') : t('projectRootUnresolved')
      const rootCustom = current.root === 'custom' && current.file !== null
      const rootSub = rootCustom
        ? t('rootFileCustomSub', { name: rootFileLabel(current.file) })
        : current.root === 'off' ? t('rootFileOffSub') : t('rootFileDefaultSub')
      const customSub = rootCustom
        ? (attachmentPartsOf(current.file) !== undefined
          ? t('customFileImportedSub', { name: rootFileLabel(current.file) })
          : rootFileLabel(current.file))
        : t('customFileSub')

      sessionRef.current = sessionId
      policyRef.current = current

      const queued = queueRef.current
      const pendingLayers = new Set(queued.map((intent) => intent.layer))
      const busyLayer = busy === null ? null : busy.layer
      const customIntent = hasIntent('custom')

      function hasIntent(layer) {
        if (activeRef.current !== null && activeRef.current.layer === layer) return true
        return queueRef.current.some((intent) => intent.layer === layer)
      }

      function clearTimer() {
        if (timerRef.current === null) return
        clearTimeout(timerRef.current)
        timerRef.current = null
      }

      function finishActive(continueQueue = true) {
        if (activeRef.current === null) return
        clearTimer()
        activeRef.current = null
        processingRef.current = false
        setBusy(null)
        setQueueVersion((value) => value + 1)
        if (continueQueue) pump()
      }

      function failActive(reason) {
        clearTimer()
        const failed = activeRef.current
        activeRef.current = null
        processingRef.current = false
        queueRef.current = []
        if (failed && failed.file) setRootBeforeCustom(null)
        setQueueVersion((value) => value + 1)
        setBusy(null)
        setError(t('failed', {
          reason: String(reason && reason.message ? reason.message : reason),
        }))
      }

      function pump() {
        if (processingRef.current || activeRef.current !== null) return
        if (sessionRef.current === undefined) return
        const intent = queueRef.current.shift()
        if (!intent) return
        processingRef.current = true
        activeRef.current = intent
        setQueueVersion((value) => value + 1)
        setBusy({ layer: intent.layer, phase: 'starting', settled: false, target: intent.target || null })
        execute(intent)
      }

      async function execute(intent) {
        try {
          let target = intent.target || null
          if (intent.file && !intent.uploaded) {
            const priorRoot = policyRef.current && policyRef.current.root === 'off' ? 'off' : 'default'
            setRootBeforeCustom(priorRoot)
            setBusy({ layer: intent.layer, phase: 'uploading', settled: false, target: null })
            const ref = await upload(sessionRef.current, intent.file)
            intent.uploaded = ref
            intent.text = `/instructions root attach ${ref.attachmentId} ${ref.bytes} uri:${encodeURIComponent(ref.name)}`
            intent.target = { kind: 'custom', file: encodeAttachmentFile(ref) }
            target = intent.target
          }
          if (!intent.text) throw new Error('empty policy intent')
          setBusy({ layer: intent.layer, phase: 'running', settled: false, target })
          const outcome = await run(sessionRef.current, intent.text)
          if (outcome === 'staged') {
            // The session went away between the check and the command. Keep the
            // intent for the next session, but do not spin on it here.
            queueRef.current.unshift(intent)
            setQueueVersion((value) => value + 1)
            finishActive(false)
            return
          }
          if (outcome !== 'applied') throw new Error(`unexpected command outcome: ${outcome}`)
          setBusy({ layer: intent.layer, phase: 'waiting', settled: true, target })
          timerRef.current = setTimeout(() => {
            if (activeRef.current !== intent) return
            queueRef.current = []
            setQueueVersion((value) => value + 1)
            staleTargetRef.current = target
            setStale(true)
            finishActive(false)
          }, PROJECTION_TIMEOUT_MS)
        } catch (reason) {
          failActive(reason)
        }
      }

      function enqueue(intent) {
        if (hasIntent(intent.layer)) return false
        staleTargetRef.current = null
        setStale(false)
        queueRef.current.push(intent)
        setQueueVersion((value) => value + 1)
        pump()
        return true
      }

      /** Pick a local file; upload and attach happen in the ordered queue. */
      function pickLocal() {
        if (typeof document === 'undefined') return
        const input = document.createElement('input')
        input.type = 'file'
        input.accept = '.md,.markdown,.txt,text/markdown,text/plain'
        input.onchange = () => {
          const file = input.files && input.files[0]
          if (!file) return
          if (!/\.(md|markdown|txt)$/i.test(file.name)) {
            setError(t('failed', { reason: t('unsupportedFile') }))
            return
          }
          enqueue({
            layer: 'custom',
            file,
            text: null,
            target: null,
          })
        }
        input.click()
      }

      const onSelect = (layer) => {
        if (hasIntent(layer)) return
        if (layer === 'custom') {
          if (rootCustom) {
            // Cancel: put the project-root layer back the way it was before.
            const restore = rootBeforeCustom === 'off' ? 'off' : 'default'
            enqueue({
              layer: 'custom',
              text: restore === 'off' ? '/instructions root off' : '/instructions root default',
              target: { kind: 'root', value: restore },
              clearRootBeforeCustom: true,
            })
            return
          }
          pickLocal()
          return
        }
        if (layer === 'root') {
          const target = current.root === 'off' ? 'default' : 'off'
          enqueue({
            layer: 'root',
            text: `/instructions root ${target}`,
            target: { kind: 'root', value: target },
          })
          return
        }
        if (layer === 'global') {
          const target = !current.global
          enqueue({
            layer: 'global',
            text: `/instructions global ${target ? 'on' : 'off'}`,
            target: { kind: 'global', value: target },
          })
          return
        }
        if (layer === 'nested') {
          const target = !current.nested
          enqueue({
            layer: 'nested',
            text: `/instructions nested ${target ? 'on' : 'off'}`,
            target: { kind: 'nested', value: target },
          })
        }
      }

      // A queued intent is applied when the session exists. This is also the
      // only place that starts the worker, so staged and live commands share
      // one ordered path.
      React.useEffect(() => {
        sessionRef.current = sessionId
        if (sessionId !== undefined) pump()
      }, [sessionId])

      // The switch itself never moves optimistically. Keep the row busy until
      // the projection adopts the target value; the timeout is only a guard
      // against a projection that never arrives.
      React.useEffect(() => {
        if (!busy || busy.settled !== true || !busy.target) return
        if (!matchesTarget(current, busy.target)) return
        if (activeRef.current && activeRef.current.clearRootBeforeCustom) setRootBeforeCustom(null)
        setError(null)
        setStale(false)
        finishActive()
      }, [busy, current])

      // If the projection arrives after the guard timeout, clear the warning as
      // soon as it actually adopts the target.
      React.useEffect(() => {
        if (!stale || !staleTargetRef.current) return
        if (!matchesTarget(current, staleTargetRef.current)) return
        staleTargetRef.current = null
        setStale(false)
      }, [current, stale])

      // A host success is the only thing that clears local errors: it may come
      // from this menu or from a direct /instructions command. The key changes
      // on every settled command, so an old success cannot clear a newer error.
      React.useEffect(() => {
        if (!lastCommand || lastCommand.kind !== 'success') return
        staleTargetRef.current = null
        setError(null)
        setStale(false)
      }, [lastCommandKey])

      function closeMenu() {
        setOpen(false)
        focusedLayerRef.current = null
      }

      // When the first turn locks the menu, the focused row may become disabled.
      // Browsers move that focus to the body, so put it on a still-active row.
      React.useEffect(() => {
        if (!open || !disabled) return
        const layer = focusedLayerRef.current
        if (layer !== 'root' && layer !== 'custom' && layer !== 'global') return
        if (typeof document === 'undefined' || !bodyRef.current) return
        const active = document.activeElement
        if (active !== null && active !== document.body && !bodyRef.current.contains(active)) return
        const focus = () => {
          const nested = bodyRef.current
            && bodyRef.current.querySelector('[data-layer="nested"]:not(:disabled)')
          const target = nested || triggerRef.current
          if (target && typeof target.focus === 'function') target.focus()
        }
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(focus)
        else focus()
      }, [open, disabled])

      React.useEffect(() => () => {
        clearTimer()
      }, [])

      const localError = error && !projectedError ? error : null
      const pending = queueRef.current.length > 0
      let status = null
      if (projectedError) status = { kind: 'error', text: projectedError }
      else if (localError) status = { kind: 'error', text: localError }
      else if (stale) status = { kind: 'stale', text: t('statusStale') }
      else if (busy !== null) status = { kind: 'busy', text: t('statusBusy') }
      else if (!connected) status = { kind: 'staged', text: t('statusDisconnected') }
      else if (pending || notStarted) status = { kind: 'staged', text: t('statusStaged') }

      const notice = busy !== null
        ? { kind: 'busy', text: t('applying') }
        : error !== null
          ? { kind: 'error', text: error }
          : projectedError !== null
            ? { kind: 'error', text: t('failed', { reason: projectedError }) }
            : stale
              ? { kind: 'staged', text: t('statusStale') }
              : (pending || !connected || notStarted)
                ? { kind: 'staged', text: t('staged') }
                : null

      const trigger = h('button', {
        type: 'button',
        ref: triggerRef,
        className: 'dsp-chip',
        'aria-haspopup': 'menu',
        'aria-expanded': String(open),
        title: chipTooltip(details, current, t),
        onClick: () => {
          if (open) closeMenu()
          else setOpen(true)
        },
      },
      h('span', { className: 'dsp-chip-label' }, t('chip')),
      h(primitives.IconChevronDownOutlineRegular, null))

      return h('span', { className: 'dsp-chip-wrap' },
        h(primitives.Menu, {
          open,
          onClose: closeMenu,
          items: [],
          anchor: trigger,
          align: 'start',
          side: 'top',
          portal: true,
          children: policyMenuBody({
            t,
            projectRoot: details.projectRoot,
            projectRootText: details.projectRootText,
            locked: disabled,
            current,
            rootCustom,
            rootSub,
            customSub,
            status,
            onSelect,
            busyLayer,
            pendingLayers,
            customIntent,
            onRowFocus: (layer) => { focusedLayerRef.current = layer },
            bodyRef,
          }),
        }),
        notice === null
          ? null
          : h('span', {
            className: `dsp-notice is-${notice.kind}`,
            title: notice.text,
          },
          (notice.kind === 'busy' || notice.kind === 'staged')
            ? h('span', { className: 'dsp-notice-dot', 'aria-hidden': 'true' })
            : null,
          h('span', null, notice.text)))
    }

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (!slots) return
      ensureStyles()
      const locale = ctx.get('locale')
      if (locale && typeof locale.register === 'function') locale.register(NS, dictionaries)
      const remote = ctx.remote || ctx.get('remote')
      const fileUpload = ctx.get('fileUpload')

      slots.inject('conversation.input.left', () => slots.register({
        name: 'conversation.input.left',
        id: 'instructions-policy',
        order: -40,
        locale: NS,
        inject: () => ({
          upload: async (sessionId, file) => {
            if (!fileUpload || typeof fileUpload.upload !== 'function') throw new Error('file upload service unavailable')
            const result = await fileUpload.upload(sessionId, file, file.name)
            if (!result || result.ok !== true) throw new Error((result && result.error && result.error.message) || 'upload failed')
            return result.value.file
          },
          run: async (sessionId, text) => {
            if (sessionId === undefined) return 'staged'
            const commands = remote && remote.commands
            if (!commands || typeof commands.execute !== 'function') throw new Error('command service unavailable')
            const result = await commands.execute(sessionId, text, [], new AbortController().signal)
            if (!result || result.ok !== true) throw new Error((result && result.error && result.error.message) || 'command failed')
            if (result.value === undefined) throw new Error('the host offers no /instructions command')
            if (result.value.result.kind === 'error') throw new Error(result.value.result.text)
            return 'applied'
          },
        }),
      }, Chip))
    }

    return { apply, inject: ['slots', 'remote', 'remote.commands', 'fileUpload'] }
  },
})
