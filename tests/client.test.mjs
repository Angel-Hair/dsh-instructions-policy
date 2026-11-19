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
        return {
          commands: api,
          workspaceFiles: {
            list: async () => ({ ok: true, value: { path: '', entries: [] } }),
            stat: async () => ({ ok: true, value: { absolutePath: '/tmp/file.md' } }),
          },
        }
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

test('the client bundle requests the projection and commands Remote', () => {
  const { namespace } = loadClient()
  assert.deepEqual([...namespace.inject], ['slots', 'remote', 'remote.commands', 'remote.workspaceFiles', 'fileUpload'])
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
  const menu = childOf(rendered, client.primitives.Menu)
  assert.ok(menu, 'menu was not rendered')
  assert.match(menu.props.anchor.props.title, /C:\/proj/)
  assert.match(menu.props.anchor.props.title, /sub\/AGENTS\.md/)
  const initial = menu.props.items[1]
  assert.equal(initial.submenu[0].disabled, true)
  assert.equal(initial.submenu[1].disabled, true)
  assert.equal(initial.submenu[2].disabled, true)
  assert.equal(menu.props.items[3].disabled, undefined)
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
  assert.equal(notice.props.style.color, 'var(--dsw-color-error, #d33)')

  const succeeded = client.render({
    ...projection,
    lastCommand: { ...projection.lastCommand, kind: 'success', text: 'ok' },
  })
  const successChildren = Array.isArray(succeeded.props.children) ? succeeded.props.children : [succeeded.props.children]
  assert.equal(successChildren.some(child => child && child.props && child.props.title === 'failed'), false)
})
