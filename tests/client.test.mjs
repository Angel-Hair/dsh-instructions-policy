import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

test('the zh and en dictionaries carry the same keys as the code uses', () => {
  const block = (locale) => {
    const start = source.indexOf(`      ${locale}: {`)
    assert.ok(start >= 0, `no ${locale} dictionary`)
    const end = source.indexOf('\n      },', start)
    assert.ok(end > start, `unterminated ${locale} dictionary`)
    return source.slice(start, end)
  }
  const keys = (text) => [...text.matchAll(/^ {8}([A-Za-z0-9_]+):/gm)].map(match => match[1]).sort()
  const zh = keys(block('zh'))
  const en = keys(block('en'))
  assert.ok(zh.length > 20)
  assert.deepEqual(zh, en)
  const used = [...new Set([...source.matchAll(/(?<![A-Za-z])t\('([A-Za-z0-9_]+)'/g)].map(match => match[1]))]
  const missing = used.filter(key => !zh.includes(key))
  assert.deepEqual(missing, [], `missing dictionary keys: ${missing.join(', ')}`)
})

function loadClient() {
  let loaded
  const elements = []
  const window = { __ModuleLoader__: { load: (definition) => { loaded = definition } } }
  const react = {
    createElement: (type, props, ...children) => {
      const element = {
        type,
        props: {
          ...(props ?? {}),
          ...(children.length === 0 ? {} : { children: children.length === 1 ? children[0] : children }),
        },
      }
      elements.push(element)
      return element
    },
    useState: (initial) => [initial, () => {}],
    useRef: (initial) => ({ current: initial }),
    useEffect: () => {},
  }
  const primitives = {
    Menu: function Menu() {},
    IconChevronDownOutlineRegular: function IconChevronDownOutlineRegular() {},
  }
  const requireFn = (name) => {
    if (name === 'react') return react
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitives
    throw new Error(`unexpected require: ${name}`)
  }
  vm.runInNewContext(source, {
    window,
    require: requireFn,
    console,
    AbortController,
  })
  assert.equal(loaded.id, 'dsh-instructions-policy')
  const namespace = loaded.factory(requireFn)
  return { namespace, primitives, elements }
}

function mountClient({ execute } = {}) {
  const { namespace, primitives } = loadClient()
  const registrations = []
  const executions = []
  const api = {
    execute: execute ?? (async (sessionId, line) => {
      executions.push({ sessionId, line })
      return { ok: true, value: { commandId: 'cmd-1', result: { kind: 'success' } } }
    }),
  }
  const ctx = {
    get: (name) => {
      if (name === 'slots') {
        return {
          inject: (_slot, factory) => factory(),
          register: (definition, component) => {
            registrations.push({ definition, component })
            return () => {}
          },
        }
      }
      if (name === 'locale') return { register: () => {} }
      if (name === 'remote') {
        return { commands: api }
      }
      if (name === 'fileUpload') {
        return { upload: async () => ({ ok: true, value: { file: { attachmentId: 'a', name: 'a.md', bytes: 1 } } }) }
      }
      return undefined
    },
  }
  namespace.apply(ctx)
  assert.equal(registrations.length, 1)
  return {
    namespace,
    primitives,
    executionCount: () => executions.length,
    executions,
    injected: registrations[0].definition.inject(),
    render: (projection, overrides = {}) => registrations[0].component({
      sessionId: 's-1',
      t: key => key,
      useProjection: (key) => {
        assert.equal(key, 'instructionsPolicy')
        return projection
      },
      ...registrations[0].definition.inject(),
      ...overrides,
    }),
  }
}

function childOf(element, type) {
  const children = Array.isArray(element.props.children) ? element.props.children : [element.props.children]
  return children.find(child => child && child.type === type)
}

function collectButtons(element, out = []) {
  if (!element || typeof element !== 'object') return out
  if (element.type === 'button') out.push(element)
  const children = element.props && element.props.children
  if (Array.isArray(children)) children.forEach(child => collectButtons(child, out))
  else if (children) collectButtons(children, out)
  return out
}

function collectByClass(element, className, out = []) {
  if (!element || typeof element !== 'object') return out
  const names = String((element.props && element.props.className) || '').split(/\s+/)
  if (names.includes(className)) out.push(element)
  const children = element.props && element.props.children
  if (Array.isArray(children)) children.forEach(child => collectByClass(child, className, out))
  else if (children) collectByClass(children, className, out)
  return out
}

function menuRows(rendered, primitives) {
  const menu = childOf(rendered, primitives.Menu)
  assert.ok(menu, 'menu was not rendered')
  const buttons = collectButtons(menu.props.children)
  const rows = new Map(buttons.filter(button => button.props['data-layer'] !== undefined)
    .map(button => [button.props['data-layer'], button]))
  return { menu, rows }
}

test('the client bundle requests the projection and commands Remote', () => {
  const { namespace } = loadClient()
  assert.deepEqual([...namespace.inject], ['slots', 'remote', 'remote.commands', 'fileUpload'])
})

test('run dispatches /instructions through the commands Remote', async () => {
  const client = mountClient()
  assert.equal(await client.injected.run('s-1', '/instructions nested on'), 'applied')
  assert.deepEqual(client.executions, [{ sessionId: 's-1', line: '/instructions nested on' }])
})

test('run surfaces a host command error', async () => {
  const client = mountClient({
    execute: async () => ({
      ok: true,
      value: { commandId: 'cmd-1', result: { kind: 'error', text: 'locked after the first turn' } },
    }),
  })
  await assert.rejects(
    client.injected.run('s-1', '/instructions root off'),
    /locked after the first turn/,
  )
})

test('run stages a command until a session id exists', async () => {
  const client = mountClient()
  assert.equal(await client.injected.run(undefined, '/instructions root off'), 'staged')
  assert.equal(client.executionCount(), 0)
})

test('the chip reads policy, lock state, and loaded files from the projection', () => {
  const client = mountClient()
  const projection = {
    policy: { root: 'off', file: null, global: false, nested: false },
    locked: true,
    lastCommand: null,
    projectRoot: 'C:/proj',
    loaded: ['sub/AGENTS.md'],
  }
  const rendered = client.render(projection)
  const { menu, rows } = menuRows(rendered, client.primitives)
  assert.match(menu.props.anchor.props.title, /C:\/proj/)
  assert.match(menu.props.anchor.props.title, /sub\/AGENTS\.md/)
  assert.equal(rows.get('root').props.disabled, true)
  assert.equal(rows.get('custom').props.disabled, true)
  assert.equal(rows.get('global').props.disabled, true)
  assert.equal(rows.get('nested').props.disabled, false)
  assert.match(rows.get('custom').props.className, /is-child/)
})

test('a custom root disables the project-root row and keeps nested switchable', () => {
  const client = mountClient()
  const { rows } = menuRows(client.render({
    policy: { root: 'custom', file: 'CUSTOM_ROOT.md', global: true, nested: true },
    locked: false,
    lastCommand: null,
    projectRoot: 'C:/proj',
    loaded: ['attachment/CUSTOM_ROOT.md'],
  }), client.primitives)
  assert.equal(rows.get('root').props.disabled, true)
  assert.equal(rows.get('custom').props.disabled, false)
  assert.equal(rows.get('nested').props.disabled, false)
  assert.match(rows.get('custom').props.className, /is-child/)
})

test('an initial session shows the staged state instead of resolving forever', () => {
  const client = mountClient()
  const rendered = client.render({
    policy: { root: 'default', file: null, global: true, nested: true },
    locked: false,
    lastCommand: null,
    projectRoot: undefined,
    loaded: [],
  })
  const { menu, rows } = menuRows(rendered, client.primitives)
  assert.match(menu.props.anchor.props.title, /projectRootNotStarted/)
  assert.equal(rows.get('root').props.disabled, false)
  assert.equal(rows.get('nested').props.disabled, false)
  const status = collectByClass(menu.props.children, 'dsp-status')
  assert.equal(status.length, 1)
  assert.match(status[0].props.className, /is-staged/)
  assert.match(JSON.stringify(status[0].props.children), /statusStaged/)
})

test('the client keeps the official Menu Tab contract', () => {
  assert.equal(source.includes('onTabClose'), false)
  assert.equal(source.includes('tabClosingRef'), false)
  assert.equal(source.includes('closeForTab'), false)
})

test('the chip shows the latest host command error from the projection', () => {
  const client = mountClient()
  const projection = {
    policy: { root: 'default', file: null, global: true, nested: true },
    locked: false,
    lastCommand: {
      commandId: 'cmd-1',
      args: ' root off',
      kind: 'error',
      text: 'locked after the first turn',
      seq: 2,
    },
    projectRoot: 'C:/proj',
    loaded: [],
  }
  const rendered = client.render(projection)
  const children = Array.isArray(rendered.props.children) ? rendered.props.children : [rendered.props.children]
  const notice = children.find(child => child && child.props && child.props.title === 'failed')
  assert.ok(notice, 'projected host error was not rendered')
  assert.match(notice.props.className, /dsp-notice/)
  assert.match(notice.props.className, /is-error/)

  const succeeded = client.render({
    ...projection,
    lastCommand: { ...projection.lastCommand, kind: 'success', text: 'ok' },
  })
  const successChildren = Array.isArray(succeeded.props.children) ? succeeded.props.children : [succeeded.props.children]
  assert.equal(successChildren.some(child => child && child.props && child.props.title === 'failed'), false)
})

function findMenu(element, primitives) {
  if (!element || typeof element !== 'object') return null
  if (element.type === primitives.Menu) return element
  const children = element.props && element.props.children
  if (Array.isArray(children)) {
    for (const child of children) {
      const found = findMenu(child, primitives)
      if (found) return found
    }
  } else {
    return findMenu(children, primitives)
  }
  return null
}

function defaultProjection() {
  return {
    policy: { root: 'default', file: null, global: true, nested: true },
    locked: false,
    lastCommand: null,
    projectRoot: 'C:/proj',
    loaded: [],
  }
}

function createInteractiveHarness(options = {}) {
  let projection = options.projection ?? defaultProjection()
  let sessionId = Object.prototype.hasOwnProperty.call(options, 'sessionId')
    ? options.sessionId
    : 's-1'
  let dirty = true
  let mounted = true
  let element = null
  let hookIndex = 0
  const hooks = []
  let pendingEffects = []
  const commands = []
  const uploads = []
  const timers = new Map()
  let timerId = 0
  let commandSeq = 0
  let component = null

  const fakeSetTimeout = (fn, ms = 0) => {
    const id = ++timerId
    timers.set(id, { fn, ms })
    return id
  }
  const fakeClearTimeout = (id) => { timers.delete(id) }

  const React = {
    createElement: (type, props, ...children) => ({
      type,
      props: {
        ...(props ?? {}),
        ...(children.length === 0 ? {} : { children: children.length === 1 ? children[0] : children }),
      },
    }),
    useState: (initial) => {
      const index = hookIndex++
      if (!(index in hooks)) hooks[index] = { value: initial }
      const set = (next) => {
        if (!mounted) return
        const value = typeof next === 'function' ? next(hooks[index].value) : next
        if (Object.is(value, hooks[index].value)) return
        hooks[index].value = value
        dirty = true
      }
      return [hooks[index].value, set]
    },
    useRef: (initial) => {
      const index = hookIndex++
      if (!(index in hooks)) hooks[index] = { current: initial }
      return hooks[index]
    },
    useEffect: (fn, deps) => {
      const index = hookIndex++
      const previous = hooks[index]
      const changed = !previous
        || !deps
        || deps.length !== previous.deps.length
        || deps.some((value, at) => !Object.is(value, previous.deps[at]))
      if (!changed) return
      if (previous && typeof previous.cleanup === 'function') previous.cleanup()
      const slot = { deps, cleanup: null }
      hooks[index] = slot
      pendingEffects.push(() => { slot.cleanup = fn() })
    },
  }

  const primitives = {
    Menu: function Menu() {},
    IconChevronDownOutlineRegular: function IconChevronDownOutlineRegular() {},
  }
  const requireFn = (name) => {
    if (name === 'react') return React
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitives
    throw new Error(`unexpected require: ${name}`)
  }

  const document = options.document === undefined
    ? undefined
    : {
      activeElement: null,
      body: {},
      head: { appendChild: () => {} },
      getElementById: () => null,
      ...options.document,
    }

  const context = {
    window: { __ModuleLoader__: { load: (definition) => { loaded = definition } } },
    require: requireFn,
    console,
    AbortController,
    setTimeout: fakeSetTimeout,
    clearTimeout: fakeClearTimeout,
    requestAnimationFrame: (fn) => fn(),
  }
  if (document !== undefined) context.document = document
  let loaded
  vm.runInNewContext(source, context)
  assert.ok(loaded, 'client bundle did not load')
  const namespace = loaded.factory(requireFn)

  const registrations = []
  namespace.apply({
    get: (name) => {
      if (name === 'slots') {
        return {
          inject: (_slot, factory) => factory(),
          register: (definition, instance) => { registrations.push({ definition, component: instance }) },
        }
      }
      if (name === 'locale') return { register: () => {} }
      if (name === 'remote') return { commands: { execute: async () => ({ ok: true }) } }
      if (name === 'fileUpload') return { upload: async () => ({ ok: true, value: { file: {} } }) }
      return undefined
    },
  })
  component = registrations[0].component

  function applyCommand(text) {
    const policy = { ...projection.policy }
    const attach = text.match(/^\/instructions root attach (\S+) (\S+) uri:(.+)$/)
    if (attach) {
      policy.root = 'custom'
      policy.file = `dsh-attachment:${attach[1]}#${attach[2]}#${encodeURIComponent(decodeURIComponent(attach[3]))}`
    } else if (text.startsWith('/instructions root ')) {
      policy.root = text.slice('/instructions root '.length)
      policy.file = null
    } else if (text === '/instructions global on' || text === '/instructions global off') {
      policy.global = text.endsWith(' on')
    } else if (text === '/instructions nested on' || text === '/instructions nested off') {
      policy.nested = text.endsWith(' on')
    }
    commandSeq += 1
    projection = {
      ...projection,
      policy,
      lastCommand: { commandId: `cmd-${commandSeq}`, seq: commandSeq, kind: 'success' },
    }
    dirty = true
  }

  const run = async (sid, text) => {
    commands.push(text)
    if (options.onRun) {
      const result = await options.onRun({
        sessionId: sid,
        text,
        apply: applyCommand,
        harness,
      })
      if (result === 'staged') return 'staged'
      return result || 'applied'
    }
    if (options.apply !== false) applyCommand(text)
    return 'applied'
  }

  const upload = async (sid, file) => {
    uploads.push({ sessionId: sid, file })
    if (options.upload) return options.upload({ sessionId: sid, file, harness })
    return { attachmentId: 'a1', bytes: 10, name: file.name }
  }

  const props = {
    sessionId,
    t: (key) => key,
    run,
    upload,
    useProjection: (key) => {
      assert.equal(key, 'instructionsPolicy')
      return projection
    },
  }

  function render() {
    hookIndex = 0
    element = component(props)
  }

  async function flush() {
    let stable = 0
    for (let round = 0; round < 200; round += 1) {
      if (pendingEffects.length > 0) {
        const effects = pendingEffects
        pendingEffects = []
        for (const effect of effects) effect()
        stable = 0
        continue
      }
      if (dirty) {
        dirty = false
        render()
        stable = 0
        continue
      }
      await new Promise((resolve) => setTimeout(resolve, 0))
      if (!dirty && pendingEffects.length === 0) {
        stable += 1
        if (stable >= 3) return
      } else {
        stable = 0
      }
    }
    throw new Error('interactive harness did not settle')
  }

  const harness = {
    commands,
    uploads,
    projection: () => projection,
    element: () => element,
    menu: () => findMenu(element, primitives),
    rows: () => {
      const menu = findMenu(element, primitives)
      const buttons = collectButtons(menu.props.children)
      return new Map(buttons.filter(button => button.props['data-layer'] !== undefined)
        .map(button => [button.props['data-layer'], button]))
    },
    status: () => {
      const menu = findMenu(element, primitives)
      return collectByClass(menu.props.children, 'dsp-status')[0]
    },
    setSessionId: (value) => { sessionId = value; dirty = true },
    setProjection: (value) => { projection = value; dirty = true },
    applyCommand,
    flush,
    open: async () => {
      const menu = findMenu(element, primitives)
      menu.props.anchor.props.onClick()
      await flush()
    },
    advanceTimers: async (ms = 1500) => {
      for (const [id, timer] of [...timers]) {
        if (timer.ms > ms) continue
        timers.delete(id)
        timer.fn()
      }
      await flush()
    },
    start: async () => {
      render()
      await flush()
      return harness
    },
    destroy: () => {
      mounted = false
      for (const slot of hooks) {
        if (slot && typeof slot.cleanup === 'function') slot.cleanup()
      }
      timers.clear()
    },
  }

  // Keep the component props in sync with the mutable session id.
  Object.defineProperty(props, 'sessionId', {
    enumerable: true,
    get: () => sessionId,
  })

  return harness
}

test('a row toggle keeps the menu open and refreshes from the projection', async () => {
  const harness = createInteractiveHarness()
  await harness.start()
  await harness.open()
  assert.equal(harness.menu().props.open, true)
  assert.equal(harness.rows().get('root').props.role, 'menuitem')

  harness.rows().get('root').props.onClick()
  await harness.flush()
  assert.deepEqual(harness.commands, ['/instructions root off'])
  assert.equal(harness.menu().props.open, true)
  assert.match(harness.rows().get('root').props['aria-label'], /offLabel/)
  assert.equal(harness.rows().get('root').props['data-busy'], undefined)

  harness.rows().get('root').props.onClick()
  await harness.flush()
  assert.deepEqual(harness.commands, ['/instructions root off', '/instructions root default'])
  assert.equal(harness.menu().props.open, true)
  assert.match(harness.rows().get('root').props['aria-label'], /onLabel/)
  harness.destroy()
})

test('rapid toggles are serialized in order without closing the menu', async () => {
  const harness = createInteractiveHarness()
  await harness.start()
  await harness.open()
  harness.rows().get('global').props.onClick()
  harness.rows().get('nested').props.onClick()
  harness.rows().get('root').props.onClick()
  await harness.flush()
  assert.deepEqual(harness.commands, [
    '/instructions global off',
    '/instructions nested off',
    '/instructions root off',
  ])
  assert.equal(harness.menu().props.open, true)
  assert.match(harness.rows().get('global').props['aria-label'], /offLabel/)
  assert.match(harness.rows().get('nested').props['aria-label'], /offLabel/)
  assert.match(harness.rows().get('root').props['aria-label'], /offLabel/)
  harness.destroy()
})

test('toggles before a session are queued and flushed in order', async () => {
  const harness = createInteractiveHarness({ sessionId: undefined })
  await harness.start()
  await harness.open()
  harness.rows().get('global').props.onClick()
  harness.rows().get('nested').props.onClick()
  await harness.flush()
  assert.deepEqual(harness.commands, [])
  assert.match(harness.status().props.className, /is-staged/)
  assert.equal(harness.rows().get('global').props['data-pending'], 'true')
  assert.equal(harness.rows().get('nested').props['data-pending'], 'true')

  harness.setSessionId('s-1')
  await harness.flush()
  assert.deepEqual(harness.commands, [
    '/instructions global off',
    '/instructions nested off',
  ])
  assert.equal(harness.menu().props.open, true)
  assert.match(harness.rows().get('global').props['aria-label'], /offLabel/)
  harness.destroy()
})

test('busy remains until the projection adopts the target', async () => {
  const harness = createInteractiveHarness({ apply: false })
  await harness.start()
  await harness.open()
  harness.rows().get('root').props.onClick()
  await harness.flush()
  assert.deepEqual(harness.commands, ['/instructions root off'])
  assert.equal(harness.rows().get('root').props['data-busy'], 'true')
  assert.match(harness.status().props.className, /is-busy/)
  assert.match(harness.rows().get('root').props['aria-label'], /onLabel/)

  harness.applyCommand('/instructions root off')
  await harness.flush()
  assert.equal(harness.rows().get('root').props['data-busy'], undefined)
  assert.match(harness.rows().get('root').props['aria-label'], /offLabel/)
  harness.destroy()
})

test('a projection timeout reports stale without flipping the switch', async () => {
  const harness = createInteractiveHarness({ apply: false })
  await harness.start()
  await harness.open()
  harness.rows().get('root').props.onClick()
  await harness.flush()
  assert.match(harness.status().props.className, /is-busy/)

  await harness.advanceTimers()
  assert.match(harness.rows().get('root').props['aria-label'], /onLabel/)
  assert.equal(harness.rows().get('root').props['data-busy'], undefined)
  assert.match(harness.status().props.className, /is-stale/)

  harness.applyCommand('/instructions root off')
  await harness.flush()
  assert.equal(harness.status(), undefined)
  assert.match(harness.rows().get('root').props['aria-label'], /offLabel/)
  harness.destroy()
})

test('a command error keeps the menu open and drops the queued intents', async () => {
  const harness = createInteractiveHarness({
    onRun: async () => { throw new Error('locked after the first turn') },
  })
  await harness.start()
  await harness.open()
  harness.rows().get('global').props.onClick()
  harness.rows().get('nested').props.onClick()
  await harness.flush()
  assert.deepEqual(harness.commands, ['/instructions global off'])
  assert.match(harness.status().props.className, /is-error/)
  assert.match(harness.rows().get('global').props['aria-label'], /onLabel/)
  assert.match(harness.rows().get('nested').props['aria-label'], /onLabel/)
  assert.equal(harness.menu().props.open, true)
  assert.equal(harness.rows().get('global').props['data-busy'], undefined)
  harness.destroy()
})

test('a custom file import stays in the queue and keeps the menu open', async () => {
  const input = {
    files: [{ name: 'RULES.md' }],
    click() { if (this.onchange) this.onchange() },
  }
  const document = {
    createElement: (tag) => (tag === 'input' ? input : { id: '', textContent: '' }),
  }
  const harness = createInteractiveHarness({ document })
  await harness.start()
  await harness.open()
  harness.rows().get('custom').props.onClick()
  await harness.flush()
  assert.equal(harness.uploads.length, 1)
  assert.deepEqual(harness.commands, ['/instructions root attach a1 10 uri:RULES.md'])
  assert.equal(harness.menu().props.open, true)
  assert.match(harness.rows().get('custom').props['aria-label'], /onLabel/)
  assert.match(harness.rows().get('root').props['aria-label'], /offLabel/)
  harness.destroy()
})
