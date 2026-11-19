/**
 * Browser half: one control in the composer tool row, immediately after the
 * permission and plan controls (conversation.input.left).
 *
 * Styles mirror ui-permission-presets' trigger by value (same tokens, height,
 * padding, font, hover fill). Writes go through the same `/instructions`
 * command the composer uses; reads come from the binding's event window and
 * lifecycle snapshot.
 */

window.__ModuleLoader__.load({
  id: 'dsh-instructions-policy',
  factory: (require) => {
    const React = require('react')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    const ReactDOM = (() => {
      try { return require('react-dom') } catch { return undefined }
    })()

    const NS = 'instructionsPolicy'
    const PROJECTION_KEY = 'instructionsPolicy'
    const DEFAULTS = { root: 'default', file: null, global: true, nested: true }

    const dictionaries = {
      zh: {
        chip: '指令策略',
        chipTitle: '指令策略',
        menuTitle: '本任务加载的指令文件(AGENTS.md等)',
        initialGroup: '初始引入',
        initialTip: '任务开始前固定加载的指令：项目根文件与用户级。',
        customFile: '自定义文件',
        customFileTip: '勾选后选择一个文件替代项目根这一层；取消勾选恢复之前的项目根设置，再次勾选可重新选择。',
        rootFile: '项目根文件',
        rootFileTip: '遵循官方机制：从当前目录向上找 .git，找到就以该目录为项目根，找不到则回退到当前目录。开启时加载项目根的 AGENTS.md 等文件；关闭只跳过这一层，当前目录及中间目录仍会加载。',
        rootFileCustomTip: '这一层当前由自定义文件替代；取消上面的勾选即可恢复。',
        global: '用户级',
        globalTip: '读 ~/.dsh/AGENTS.md 与 ~/.agents/AGENTS.md；任务开始后锁定。',
        nested: '子目录追加',
        nestedTip: '读取或编辑子目录文件时追加该目录的 AGENTS.md；随时可切，下一步生效。',
        staged: '任务开始时应用',
        applying: '应用中…',
        menuTitleDisconnected: '本任务加载的指令文件(AGENTS.md等) · 会话未连接',
        projectRootLabel: '项目根',
        loadedLabel: '已加载',
        noneLabel: '无',
        onLabel: '开',
        offLabel: '关',
        listSeparator: '、',
        pickerTitle: '选择项目根指令文件',
        cancel: '取消',
        pickLocal: '从本机选择…',
        loadingFiles: '读取目录…',
        parentDirectory: '上级目录',
        noMarkdown: '这里没有 Markdown 文件',
        unsupportedFile: '仅支持 .md / .markdown / .txt',
        failed: '切换失败：{reason}',
      },
      en: {
        chip: 'Instruction policy',
        chipTitle: 'Instruction policy',
        menuTitle: 'Instruction files loaded for this task (AGENTS.md and others)',
        initialGroup: 'Initial files',
        initialTip: 'Loaded before the task starts: the project-root file and the user-global instructions.',
        customFile: 'Custom file',
        customFileTip: 'Check to pick a file that replaces the project-root layer; uncheck to restore the previous project-root setting, then check again to pick another.',
        rootFile: 'Project-root file',
        rootFileTip: 'Follows the official mechanism: walk up from the working directory looking for .git and use that directory as the project root; fall back to the working directory when none is found. On loads the project root\u2019s AGENTS.md; Off skips only that layer, so the working directory and the directories between still load.',
        rootFileCustomTip: 'This layer is currently replaced by the custom file; uncheck the row above to restore it.',
        global: 'User-global',
        globalTip: 'Reads ~/.dsh/AGENTS.md and ~/.agents/AGENTS.md. Locked after the task starts.',
        nested: 'Subdirectory append',
        nestedTip: 'Appends a directory AGENTS.md when a file inside it is read or edited. Switchable; applies to the next step.',
        staged: 'Applied when the task starts',
        applying: 'Applying…',
        menuTitleDisconnected: 'Instruction files loaded for this task (AGENTS.md and others) · session not connected',
        projectRootLabel: 'Project root',
        loadedLabel: 'Loaded',
        noneLabel: 'none',
        onLabel: 'on',
        offLabel: 'off',
        listSeparator: ', ',
        pickerTitle: 'Choose the project-root instruction file',
        cancel: 'Cancel',
        pickLocal: 'Choose local file…',
        loadingFiles: 'Listing…',
        parentDirectory: 'parent directory',
        noMarkdown: 'No Markdown files here',
        unsupportedFile: 'Only .md, .markdown, and .txt are supported',
        failed: 'Switch failed: {reason}',
      },
    }

    const boxStyle = {
      width: '14px',
      height: '14px',
      borderRadius: '3px',
      border: '1px solid currentColor',
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontSize: '10px',
      lineHeight: '1',
      flex: '0 0 auto',
    }

    const ATTACHMENT_PREFIX = 'dsh-attachment:'
    const ATTACH_NAME_ARG_PREFIX = 'uri:'

    function attachmentPartsOf(file) {
      if (typeof file !== 'string' || !file.startsWith(ATTACHMENT_PREFIX)) return undefined
      const parts = file.slice(ATTACHMENT_PREFIX.length).split('#')
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

    /** Chip tooltip: the resolved project root, the loaded files, and both switches. */
    function chipTooltip(state, policy, t) {
      const lines = [t('chipTitle')]
      if (state && state.projectRoot) lines.push(`${t('projectRootLabel')}: ${state.projectRoot}`)
      const loaded = state ? state.loaded : []
      lines.push(`${t('loadedLabel')}: ${loaded.length === 0 ? t('noneLabel') : loaded.join(t('listSeparator'))}`)
      lines.push([`${t('global')}: ${policy.global ? t('onLabel') : t('offLabel')}`,
        `${t('nested')}: ${policy.nested ? t('onLabel') : t('offLabel')}`].join(' · '))
      return lines.join('\n')
    }

    function box(checked) {
      return React.createElement('span', { style: boxStyle }, checked ? '✓' : '')
    }

    /** Indent that lines a nested row up with the text after an outer row's checkbox. */
    const NESTED_INDENT = '22px'

    /** One menu row: a checkbox box, a label, and a tooltip. `muted` marks a layer a custom file has taken over. */
    /**
     * One menu row: an optional tree branch, a checkbox, a label, and a tooltip.
     * `muted` marks a layer a custom file has taken over; `indent` nests the row
     * under the previous one; `branch` draws the `└` that makes the nesting visible.
     */
    function row(checked, text, tip, muted, indent, branch) {
      return React.createElement(
        'span',
        {
          title: tip || text,
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: '8px',
            marginLeft: indent ? NESTED_INDENT : undefined,
            color: muted ? 'var(--dsw-alias-label-tertiary)' : 'inherit',
          },
        },
        branch === true
          ? React.createElement(
            'span',
            {
              'aria-hidden': 'true',
              style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: '12px' },
            },
            '└',
          )
          : null,
        box(checked),
        React.createElement('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, text),
      )
    }

    function fileNameOf(path) {
      const parts = String(path || '').split(/[\\/]/)
      return parts[parts.length - 1] || String(path || '')
    }

    function policyFileLabel(file) {
      return attachmentNameOf(file) || String(file || '')
    }

    function tipText(tip, text, indent) {
      return React.createElement(
        'span',
        {
          title: tip,
          style: { display: 'inline-flex', alignItems: 'center', marginLeft: indent ? NESTED_INDENT : undefined },
        },
        text,
      )
    }

    function PickerDialog(props) {
      const { picker, t, onClose, onNavigate, onChoose, onPickLocal } = props
      const [hovered, setHovered] = React.useState(null)
      React.useEffect(() => {
        const onKey = (event) => { if (event.key === 'Escape') onClose() }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [onClose])

      const rows = []
      if (picker.path !== '') rows.push({ key: 'up', kind: 'up', label: `.. ${t('parentDirectory')}` })
      if (!picker.loading && !picker.error) {
        for (const entry of picker.entries) {
          if (entry.type === 'directory') {
            rows.push({ key: `d:${entry.name}`, kind: 'dir', name: entry.name, label: `${entry.name}/` })
          } else if (entry.type === 'file' && /\.(md|markdown|txt)$/i.test(entry.name)) {
            const path = picker.path ? `${picker.path}/${entry.name}` : entry.name
            rows.push({ key: `f:${path}`, kind: 'file', name: entry.name, path, label: entry.name })
          }
        }
      }

      const rowStyle = (hover) => ({
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px',
        width: '100%', padding: '8px 12px', border: 'none', borderRadius: '6px',
        background: hover ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent',
        color: 'inherit', cursor: 'pointer', textAlign: 'left', font: 'inherit', fontSize: '13px',
      })
      const body = picker.loading
        ? React.createElement('div', { style: { padding: '16px', fontSize: '13px', color: 'var(--dsw-alias-label-tertiary)' } }, t('loadingFiles'))
        : picker.error
          ? React.createElement('div', { style: { padding: '16px', fontSize: '13px', color: 'var(--dsw-color-error, #d33)' } }, picker.error)
          : rows.length === 0
            ? React.createElement('div', { style: { padding: '16px', fontSize: '13px', color: 'var(--dsw-alias-label-tertiary)' } }, t('noMarkdown'))
            : rows.map((row) => React.createElement('button', {
              key: row.key,
              type: 'button',
              onMouseEnter: () => setHovered(row.key),
              onMouseLeave: () => setHovered(null),
              onClick: () => {
                if (row.kind === 'up') return onNavigate(picker.path.includes('/') ? picker.path.slice(0, picker.path.lastIndexOf('/')) : '')
                if (row.kind === 'dir') return onNavigate(picker.path ? `${picker.path}/${row.name}` : row.name)
                return onChoose(row.path)
              },
              style: rowStyle(hovered === row.key),
            },
            React.createElement('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, row.label),
            row.kind === 'file'
              ? React.createElement('span', { style: { maxWidth: '55%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)' } }, row.path)
              : null,
            ))

      const panel = React.createElement('div', {
        onClick: (event) => event.stopPropagation(),
        style: {
          width: 'min(560px, 92vw)', maxHeight: '70vh', display: 'flex', flexDirection: 'column',
          background: 'var(--dsw-alias-bg-elevated, #1f1f1f)', color: 'var(--dsw-alias-label-primary, inherit)',
          borderRadius: '12px', border: '1px solid var(--dsw-alias-border-secondary, rgba(255,255,255,.12))',
          boxShadow: '0 12px 40px rgba(0,0,0,.35)', overflow: 'hidden',
        },
      },
      React.createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', padding: '12px 16px', borderBottom: '1px solid var(--dsw-alias-border-secondary, rgba(255,255,255,.12))' } },
        React.createElement('div', { style: { minWidth: 0 } },
          React.createElement('div', { style: { fontSize: '13px', fontWeight: 600 } }, t('pickerTitle')),
          React.createElement('div', { style: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, picker.path === '' ? '/' : picker.path),
        ),
        React.createElement('button', { type: 'button', onClick: onClose, style: { border: 'none', background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: '16px', lineHeight: 1 } }, '×'),
      ),
      React.createElement('div', { style: { padding: '8px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '2px' } }, body),
      React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', gap: '8px', padding: '8px 12px', borderTop: '1px solid var(--dsw-alias-border-secondary, rgba(255,255,255,.12))' } },
        React.createElement('button', { type: 'button', onClick: onPickLocal, style: { border: '1px solid var(--dsw-alias-border-secondary, rgba(255,255,255,.2))', background: 'transparent', color: 'inherit', borderRadius: '6px', padding: '4px 12px', cursor: 'pointer', font: 'inherit', fontSize: '12px' } }, t('pickLocal')),
        React.createElement('button', { type: 'button', onClick: onClose, style: { border: '1px solid var(--dsw-alias-border-secondary, rgba(255,255,255,.2))', background: 'transparent', color: 'inherit', borderRadius: '6px', padding: '4px 12px', cursor: 'pointer', font: 'inherit', fontSize: '12px' } }, t('cancel')),
      ),
      )
      const overlay = React.createElement('div', {
        onClick: onClose,
        style: { position: 'fixed', inset: 0, zIndex: 1200, background: 'rgba(0,0,0,.4)', display: 'flex', alignItems: 'center', justifyContent: 'center' },
      }, panel)
      return ReactDOM ? ReactDOM.createPortal(overlay, document.body) : overlay
    }

    function Chip(props) {
      const { sessionId, t, run, useProjection, list, stat, upload } = props
      const [open, setOpen] = React.useState(false)
      const [hover, setHover] = React.useState(false)
      const [picker, setPicker] = React.useState(null)
      const [busy, setBusy] = React.useState(null)
      const [pending, setPending] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [rootBeforeCustom, setRootBeforeCustom] = React.useState(null)
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
      const connected = sessionId !== undefined
      const disabled = Boolean(projected && projected.locked)

      // A policy chosen before the Session exists is only an intent. Retry once
      // the Session ID arrives; a host rejection is shown, never swallowed.
      React.useEffect(() => {
        if (pending === null || sessionId === undefined) return undefined
        let cancelled = false
        setBusy(pending)
        Promise.resolve()
          .then(() => run(sessionId, pending))
          .then((outcome) => {
            if (cancelled) return
            if (outcome === 'applied') {
              setPending(null)
              setError(null)
            }
          })
          .catch((reason) => {
            if (cancelled) return
            setPending(null)
            setError(t('failed', { reason: String(reason && reason.message ? reason.message : reason) }))
          })
          .finally(() => {
            if (!cancelled) setBusy(null)
          })
        return () => {
          cancelled = true
        }
      }, [pending, sessionId, run])

      const invoke = (text) => {
        setOpen(false)
        setError(null)
        setPending(null)
        setBusy(text)
        Promise.resolve()
          .then(() => run(sessionId, text))
          .then((outcome) => {
            setBusy(null)
            if (outcome === 'staged') setPending(text)
          })
          .catch((reason) => {
            setBusy(null)
            setPending(null)
            setError(t('failed', { reason: String(reason && reason.message ? reason.message : reason) }))
          })
      }

      const rootCustom = current.root === 'custom' && current.file !== null
      const customLabel = rootCustom
        ? `${t('customFile')} · ${fileNameOf(policyFileLabel(current.file))}`
        : t('customFile')

      /** Remember the project-root mode a custom file replaces, so cancel can restore it. */
      const rememberRoot = () => {
        if (current.root !== 'custom') setRootBeforeCustom(current.root === 'off' ? 'off' : 'default')
      }

      const items = [
        { type: 'label', id: 'menu-title', text: connected ? t('menuTitle') : t('menuTitleDisconnected') },
        {
          id: 'initial',
          label: tipText(t('initialTip'), t('initialGroup')),
          submenu: [
            {
              id: 'root',
              label: row(
                current.root !== 'off' && !rootCustom,
                t('rootFile'),
                rootCustom ? t('rootFileCustomTip') : t('rootFileTip'),
                rootCustom,
              ),
              disabled: disabled || rootCustom,
            },
            {
              id: 'custom',
              label: row(rootCustom, customLabel, t('customFileTip'), false, true, true),
              disabled,
            },
            { id: 'global', label: row(current.global, t('global'), t('globalTip')), disabled },
          ],
        },
        { type: 'separator', id: 'sep-1' },
        { id: 'nested', label: row(current.nested, t('nested'), t('nestedTip')) },
      ]

      const pickLocal = () => {
        if (typeof document === 'undefined') return
        const input = document.createElement('input')
        input.type = 'file'
        input.accept = '.md,.markdown,.txt,text/markdown,text/plain'
        input.onchange = () => {
          const file = input.files && input.files[0]
          if (!file) return
          if (!/\.(md|markdown|txt)$/i.test(file.name)) {
            setPicker((previous) => ({ ...(previous || { path: '' }), loading: false, error: t('unsupportedFile') }))
            return
          }
          setPicker((previous) => ({ ...(previous || { path: '' }), loading: true, error: null }))
          Promise.resolve()
            .then(() => upload(sessionId, file))
            .then((ref) => {
              setPicker(null)
              const command = `/instructions root attach ${ref.attachmentId} ${ref.bytes} ${ATTACH_NAME_ARG_PREFIX}${encodeURIComponent(ref.name)}`
              rememberRoot()
              invoke(command)
            })
            .catch((reason) => setPicker((previous) => ({ ...(previous || { path: '' }), loading: false, error: t('failed', { reason: String(reason && reason.message ? reason.message : reason) }) })))
        }
        input.click()
      }

      const loadPicker = (path) => {
        setOpen(false)
        setPicker({ path, entries: [], loading: true, error: null })
        // The Host rejects an empty path; `.` names the workspace root.
        const apiPath = path === '' ? '.' : path
        Promise.resolve()
          .then(() => list(sessionId, apiPath))
          .then((listing) => setPicker({ path, entries: listing.entries || [], loading: false, error: null }))
          .catch((reason) => setPicker({ path, entries: [], loading: false, error: t('failed', { reason: String(reason && reason.message ? reason.message : reason) }) }))
      }

      const chooseFile = (name) => {
        const path = picker.path ? `${picker.path}/${name}` : name
        Promise.resolve()
          .then(() => stat(sessionId, path))
          .then((info) => {
            const absolute = info && info.absolutePath ? info.absolutePath : path
            setPicker(null)
            const command = `/instructions root custom ${absolute}`
            rememberRoot()
            invoke(command)
          })
          .catch((reason) => setPicker({ ...picker, error: t('failed', { reason: String(reason && reason.message ? reason.message : reason) }) }))
      }

      const onSelect = (id) => {
        if (id === 'custom') {
          if (rootCustom) {
            // Cancel: put the project-root layer back the way it was before.
            const restore = rootBeforeCustom === 'off' ? 'off' : 'default'
            setRootBeforeCustom(null)
            return invoke(restore === 'off' ? '/instructions root off' : '/instructions root default')
          }
          // Enabling always asks for a file; a cancelled selection leaves the layer as it was.
          loadPicker('')
          return
        }
        if (id === 'root') {
          if (current.root === 'off') return invoke('/instructions root default')
          return invoke('/instructions root off')
        }
        if (id === 'global') return invoke(`/instructions global ${current.global ? 'off' : 'on'}`)
        if (id === 'nested') return invoke(`/instructions nested ${current.nested ? 'off' : 'on'}`)
      }

      const trigger = React.createElement(
        'button',
        {
          type: 'button',
          onClick: () => {
            setOpen((value) => {
              if (!value) {
                setPicker(null)
                setError(null)
              }
              return !value
            })
          },
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          title: chipTooltip(details, current, t),
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: '4px',
            minWidth: 0,
            maxWidth: '220px',
            height: '28px',
            padding: '0 4px 0 8px',
            border: 'none',
            borderRadius: 'var(--dsw-radius-sm)',
            outline: 'none',
            background: hover ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent',
            color: 'var(--dsw-alias-label-secondary)',
            fontSize: '13px',
            lineHeight: '20px',
            fontWeight: 500,
            cursor: 'pointer',
          },
        },
        React.createElement('span', {
          style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
        }, t('chip')),
        React.createElement('span', { style: { display: 'inline-flex', flex: '0 0 auto' } },
          React.createElement(primitives.IconChevronDownOutlineRegular, null)),
      )

      const notice = busy !== null
        ? t('applying')
        : pending !== null
          ? t('staged')
          : error !== null
            ? error
            : projectedError !== null
              ? t('failed', { reason: projectedError })
              : null

      return React.createElement(
        'span',
        { style: { display: 'inline-flex', alignItems: 'center', gap: '4px' } },
        React.createElement(primitives.Menu, {
          open,
          onClose: () => setOpen(false),
          items,
          onSelect,
          anchor: trigger,
          align: 'start',
          portal: true,
        }),
        picker === null
          ? null
          : React.createElement(PickerDialog, {
            picker,
            t,
            onClose: () => setPicker(null),
            onNavigate: loadPicker,
            onChoose: chooseFile,
            onPickLocal: pickLocal,
          }),
        notice === null || notice === undefined
          ? null
          : React.createElement('span', {
            title: notice,
            style: {
              color: busy !== null || pending !== null ? 'var(--dsw-alias-label-tertiary)' : 'var(--dsw-color-error, #d33)',
              fontSize: '11px',
              maxWidth: '180px',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            },
          }, notice),
      )
    }

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (!slots) return
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
          list: async (sessionId, path) => {
            const api = remote && remote.workspaceFiles
            if (!api || typeof api.list !== 'function') throw new Error('workspace file service unavailable')
            const result = await api.list(sessionId, path, new AbortController().signal)
            if (!result || result.ok !== true) throw new Error((result && result.error && result.error.message) || 'list failed')
            return result.value
          },
          upload: async (sessionId, file) => {
            if (!fileUpload || typeof fileUpload.upload !== 'function') throw new Error('file upload service unavailable')
            const result = await fileUpload.upload(sessionId, file, file.name)
            if (!result || result.ok !== true) throw new Error((result && result.error && result.error.message) || 'upload failed')
            return result.value.file
          },
          stat: async (sessionId, path) => {
            const api = remote && remote.workspaceFiles
            if (!api || typeof api.stat !== 'function') throw new Error('workspace file service unavailable')
            const result = await api.stat(sessionId, path, new AbortController().signal)
            if (!result || result.ok !== true) throw new Error((result && result.error && result.error.message) || 'stat failed')
            return result.value
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

    return { apply, inject: ['slots', 'remote', 'remote.commands', 'remote.workspaceFiles', 'fileUpload'] }
  },
})
