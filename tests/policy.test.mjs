import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../lib/loader.js'
import { apply as applyHost } from '../lib/index.js'

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'dsh-ip-'))
  const root = join(base, 'project')
  const home = join(base, 'home')
  const agents = join(base, 'agents')
  await mkdir(join(root, '.git'), { recursive: true })
  await mkdir(join(root, 'sub'), { recursive: true })
  await mkdir(join(root, 'sub', 'deep'), { recursive: true })
  await mkdir(home, { recursive: true })
  await mkdir(agents, { recursive: true })
  await writeFile(join(root, 'AGENTS.md'), 'ROOT RULES')
  await writeFile(join(root, 'sub', 'AGENTS.md'), 'SUB RULES')
  await writeFile(join(root, 'sub', 'deep', 'AGENTS.md'), 'DEEP RULES')
  return { base, root, home, agents }
}

function mount({ cwd, config, official, attachments }) {
  const listeners = { preStep: [], tools: [] }
  const ctx = {
    on(event, fn) {
      if (event === 'agent/pre-step') listeners.preStep.push(fn)
      if (event === 'tools/result') listeners.tools.push(fn)
    },
    get(name) {
      if (name === 'workingDirectory') return { ensure: async () => cwd }
      if (name === 'attachments') return attachments
      return undefined
    },
    logger: { warn() {} },
  }
  // Command-result copy is localized; pin English so text assertions do not
  // depend on the machine running the tests.
  apply(ctx, { locale: 'en', ...(config ?? {}) }, official)
  return listeners
}

function makeAgent() {
  const events = []
  const surface = { nodes: [], replaceGeneration: 0 }
  const session = {
    surface,
    eventAt: (seq) => events[seq],
    snapshotEvents: () => events.slice(),
    append: (type, data) => {
      events.push({ seq: events.length, type, data })
      surface.nodes.push(events.length - 1)
      return events.length - 1
    },
  }
  return { session }
}

/** Replace the whole model-visible surface with one summary node, as compaction does. */
function compactSurface(agent) {
  const seq = agent.session.append('compaction/summary', { text: 'summary so far' })
  agent.session.surface.nodes.splice(0, agent.session.surface.nodes.length, seq)
  agent.session.surface.replaceGeneration += 1
  return seq
}

function applyPolicyCommand(agent, args, kind = 'success') {
  const commandId = `cmd-${Math.random().toString(36).slice(2)}`
  agent.session.append('command/run', { commandId, name: 'instructions', args, source: { kind: 'user' } })
  agent.session.append('command/done', { commandId, kind })
}

async function runStep(listeners, agent, step = 1, claimed = [{ id: 'u1', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }]) {
  let result
  for (const listener of listeners.preStep) {
    result = await listener(
      { agent, messages: claimed, step, signal: new AbortController().signal },
      async () => ({ kind: 'proceed', messages: [...claimed] }),
    )
  }
  // The real loop persists every entering message as a user/message event; the
  // fold reads that log, so the harness has to record it the same way.
  for (const message of result.messages) {
    if (message.source?.kind !== 'agent-instructions') continue
    agent.session.append('user/message', {
      id: message.id,
      role: message.role,
      content: message.content,
      source: message.source,
    })
  }
  return result
}

function touchFile(listeners, agent, path, name = 'read') {
  for (const touch of listeners.tools) {
    touch({ name, arguments: { file_path: path }, agent }, { isError: false })
  }
}

function textOf(decision) {
  return decision.messages
    .filter(message => message.source?.kind === 'agent-instructions')
    .flatMap(message => message.content.map(block => block.text))
    .join('\n\n')
}

/** Join one logger call the way the runtime formats printf-style arguments. */
function formatLog(args) {
  let index = 0
  return String(args[0] ?? '').replace(/%[sdio]/g, () => String(args[++index] ?? ''))
}

test('default policy loads the root and current-directory instructions', async () => {
  const fx = await fixture()
  process.env.DSH_HOME = fx.home
  process.env.DSH_AGENTS_HOME = fx.agents
  try {
    const listeners = mount({ cwd: join(fx.root, 'sub'), config: undefined })
    const decision = await runStep(listeners, makeAgent())
    const text = textOf(decision)
    assert.match(text, /ROOT RULES/)
    assert.match(text, /SUB RULES/)
    assert.doesNotMatch(text, /DEEP RULES/)
  } finally {
    await rm(fx.base, { recursive: true, force: true })
  }
})

test('custom root replaces the root scope but keeps the rest of the chain', async () => {
  const fx = await fixture()
  process.env.DSH_HOME = fx.home
  process.env.DSH_AGENTS_HOME = fx.agents
  await writeFile(join(fx.root, 'CUSTOM.md'), 'CUSTOM RULES')
  try {
    const listeners = mount({
      cwd: join(fx.root, 'sub'),
      config: { policy: { root: 'custom', file: 'CUSTOM.md', global: true, nested: true } },
    })
    const text = textOf(await runStep(listeners, makeAgent()))
    assert.match(text, /CUSTOM RULES/)
    assert.match(text, /SUB RULES/)
    assert.doesNotMatch(text, /ROOT RULES/)
  } finally {
    await rm(fx.base, { recursive: true, force: true })
  }
})

test('user-global instructions load by default and can be switched off', async () => {
  const fx = await fixture()
  process.env.DSH_HOME = fx.home
  process.env.DSH_AGENTS_HOME = fx.agents
  await writeFile(join(fx.home, 'AGENTS.md'), 'GLOBAL RULES')
  try {
    const on = textOf(await runStep(mount({ cwd: fx.root, config: undefined }), makeAgent()))
    assert.match(on, /GLOBAL RULES/)
    const off = textOf(await runStep(
      mount({ cwd: fx.root, config: { policy: { global: false } } }),
      makeAgent(),
    ))
    assert.doesNotMatch(off, /GLOBAL RULES/)
    assert.match(off, /ROOT RULES/)
  } finally {
    await rm(fx.base, { recursive: true, force: true })
  }
})

test('touching a deeper directory adds its instructions when nested is on', async () => {
  const fx = await fixture()
  process.env.DSH_HOME = fx.home
  process.env.DSH_AGENTS_HOME = fx.agents
  try {
    const cwd = join(fx.root, 'sub')
    const agent = makeAgent()
    const listeners = mount({ cwd, config: undefined })
    await runStep(listeners, agent)
    for (const touch of listeners.tools) {
      touch(
        { name: 'read', arguments: { file_path: join(cwd, 'deep', 'NOTE.md') }, agent },
        { isError: false },
      )
    }
    const text = textOf(await runStep(listeners, agent, 2))
    assert.match(text, /DEEP RULES/)
  } finally {
    await rm(fx.base, { recursive: true, force: true })
  }
})

test('a missing custom root file drops only the root scope and reports it', async () => {
  const fx = await fixture()
  process.env.DSH_HOME = fx.home
  process.env.DSH_AGENTS_HOME = fx.agents
  try {
    const listeners = mount({
      cwd: join(fx.root, 'sub'),
      config: { policy: { root: 'custom', file: 'MISSING.md', global: false, nested: true } },
    })
    const text = textOf(await runStep(listeners, makeAgent()))
    assert.doesNotMatch(text, /ROOT RULES/)
    assert.match(text, /SUB RULES/)
    assert.match(text, /MISSING\.md/)
  } finally {
    await rm(fx.base, { recursive: true, force: true })
  }
})

test('nested off never adds deeper instructions', async () => {
  const fx = await fixture()
  process.env.DSH_HOME = fx.home
  process.env.DSH_AGENTS_HOME = fx.agents
  try {
    const cwd = join(fx.root, 'sub')
    const agent = makeAgent()
    const listeners = mount({ cwd, config: { policy: { nested: false } } })
    await runStep(listeners, agent)
    for (const touch of listeners.tools) {
      touch(
        { name: 'edit', arguments: { file_path: join(cwd, 'deep', 'NOTE.md') }, agent },
        { isError: false },
      )
    }
    const text = textOf(await runStep(listeners, agent, 2))
    assert.doesNotMatch(text, /DEEP RULES/)
  } finally {
    await rm(fx.base, { recursive: true, force: true })
  }
})

test('host row redirects the shipped loader import and restores on dispose', async () => {
  const calls = []
  const original = {
    import: async (specifier) => {
      calls.push(specifier)
      return { name: 'original' }
    },
  }
  const loader = { internal: original }
  const disposers = []
  const infos = []
  const ctx = {
    get: (name) => (name === 'loader' ? loader : undefined),
    logger: { warn() {}, info: (...args) => infos.push(formatLog(args)) },
    on: () => {},
    effect: (factory) => { disposers.push(factory()) },
  }

  applyHost(ctx)
  assert.notEqual(loader.internal, original)

  const replacement = await loader.internal.import('@deepseek-ai/dsh-agent-instructions', 'file:///', {})
  assert.equal(replacement.name, 'instructions-policy')
  assert.equal(typeof replacement.apply, 'function')
  assert.ok(infos.some(line => /replaced .*@/.test(line)), infos.join('\n'))

  const other = await loader.internal.import('dsh-other', 'file:///', {})
  assert.equal(other.name, 'original')
  assert.deepEqual(calls.sort(), ['@deepseek-ai/dsh-agent-instructions', 'dsh-other'])

  for (const dispose of disposers) dispose()
  assert.equal(loader.internal, original)
})

test('host config merges under the replaced row config', async () => {
  const { mergePolicyConfig } = await import('../lib/index.js')
  assert.deepEqual(
    mergePolicyConfig(
      { policy: { root: 'custom', file: 'X.md', global: false }, maxBytes: 4096 },
      { maxBytes: 65536, policy: { nested: false } },
    ),
    { maxBytes: 65536, policy: { root: 'custom', file: 'X.md', global: false, nested: false } },
  )
})

test('/instructions advertises free-form input so the composer accepts arguments', () => {
  const registered = []
  const ctx = {
    on: () => {},
    get: (name) => {
      if (name === 'commands') return { register: (definition) => { registered.push(definition); return () => {} } }
      return undefined
    },
    logger: { warn() {} },
    effect: (factory) => { factory() },
  }
  apply(ctx, {})
  assert.equal(registered[0].name, 'instructions')
  assert.equal(typeof registered[0].input?.hint, 'string')
  assert.match(registered[0].input.hint, /root/)
  assert.match(registered[0].input.hint, /nested/)
  assert.equal(registered[0].input.attachments, undefined)
})

test('the host row registers the instructionsPolicy projection and disposes it', async () => {
  const calls = []
  let captured
  let disposed = false
  const original = { import: async () => ({ name: 'original' }) }
  const loader = { internal: original, entries: () => [] }
  const projections = {
    register: async (definition) => {
      captured = definition
      return { dispose: async () => { disposed = true } }
    },
  }
  const disposers = []
  const ctx = {
    get: (name) => {
      if (name === 'loader') return loader
      if (name === 'sessionProjections') return projections
      return undefined
    },
    logger: { warn: (...args) => calls.push(args.join(' ')), info() {} },
    on: () => {},
    effect: (factory) => { disposers.push(factory()) },
  }
  applyHost(ctx, { policy: { root: 'default' } })
  await Promise.resolve()
  assert.ok(captured, 'projection was not registered')
  assert.equal(captured.key, 'instructionsPolicy')
  assert.equal(captured.stateVersion, 1)
  assert.equal(captured.wire.summary, false)
  for (const dispose of disposers) dispose()
  await Promise.resolve()
  assert.equal(disposed, true)
})

test('apply warns when no composed preset mounts the shipped row', () => {
  const warnings = []
  const loader = {
    internal: { import: async () => ({ name: 'original' }) },
    entries: () => [
      { options: { name: 'preset-standard', config: { plugins: [{ name: '@deepseek-ai/dsh-persona' }] } } },
    ],
  }
  const ctx = {
    get: (n) => (n === 'loader' ? loader : undefined),
    logger: { warn: (...args) => warnings.push(args.join(' ')), info() {} },
    on: () => {},
    effect: () => {},
  }
  applyHost(ctx)
  assert.ok(warnings.some(line => line.includes('no agent preset mounts')), warnings.join('\n'))
})

test('apply reports how many preset rows mount the shipped row', () => {
  const infos = []
  const shipped = { name: '@deepseek-ai/dsh-agent-instructions' }
  const loader = {
    internal: { import: async () => ({ name: 'original' }) },
    entries: () => [
      { options: { name: 'preset-a', config: { plugins: [shipped] } } },
      { options: { name: 'preset-b', config: { plugins: [shipped] } } },
      { options: { name: 'tool-fs', config: {} } },
    ],
  }
  const ctx = {
    get: (n) => (n === 'loader' ? loader : undefined),
    logger: { warn() {}, info: (...args) => infos.push(formatLog(args)) },
    on: () => {},
    effect: () => {},
  }
  applyHost(ctx)
  assert.ok(infos.some(line => line.includes('for 2 preset row')), infos.join('\n'))
})

test('the redirect survives a wholesale loader.internal replacement', async () => {
  const original = { import: async () => ({ name: 'original' }) }
  const second = { import: async () => ({ name: 'second' }) }
  const loader = { internal: original }
  const ctx = { get: (n) => (n === 'loader' ? loader : undefined), logger: { warn() {}, info() {} }, on: () => {}, effect: () => {} }
  applyHost(ctx)
  loader.internal = second
  assert.notEqual(loader.internal, second)
  const redirected = await loader.internal.import('@deepseek-ai/dsh-agent-instructions', 'file:///', {})
  assert.equal(redirected.name, 'instructions-policy')
  const other = await loader.internal.import('other', 'file:///', {})
  assert.equal(other.name, 'second')
})

test('private-field methods keep working through the proxy', async () => {
  class Seam {
    #secret = 'ok'
    import() { return Promise.resolve({ name: 'inner' }) }
    read() { return this.#secret }
  }
  const loader = { internal: new Seam() }
  const ctx = { get: (n) => (n === 'loader' ? loader : undefined), logger: { warn() {}, info() {} }, on: () => {}, effect: () => {} }
  applyHost(ctx)
  assert.equal(loader.internal.read(), 'ok')
})

test('self-check warns when no preset ever imported the shipped loader', async () => {
  const warnings = []
  const loader = { internal: { import: async () => ({ name: 'original' }) } }
  const listeners = []
  const ctx = {
    get: (n) => (n === 'loader' ? loader : undefined),
    logger: { warn: (...args) => warnings.push(args.join(' ')), info() {} },
    on: (event, fn) => { if (event === 'agent/pre-step') listeners.push(fn) },
    effect: () => {},
  }
  applyHost(ctx)
  for (const listener of listeners) {
    await listener(
      { agent: { session: {} }, messages: [], step: 1, signal: new AbortController().signal },
      async () => ({ kind: 'proceed', messages: [{}] }),
    )
  }
  assert.ok(warnings.some(line => line.includes('no preset imported')))
})

test('maxBytes 0 disables instruction loading', async () => {
  const fx = await fixture()
  process.env.DSH_HOME = fx.home
  process.env.DSH_AGENTS_HOME = fx.agents
  try {
    const listeners = mount({ cwd: fx.root, config: { maxBytes: 0 } })
    const text = textOf(await runStep(listeners, makeAgent()))
    assert.equal(text, '')
  } finally {
    await rm(fx.base, { recursive: true, force: true })
  }
})

test('a custom root outside the project root is refused with a notice', async () => {
  const fx = await fixture()
  process.env.DSH_HOME = fx.home
  process.env.DSH_AGENTS_HOME = fx.agents
  const outside = join(fx.base, 'outside.md')
  await writeFile(outside, 'OUTSIDE RULES')
  try {
    const listeners = mount({ cwd: fx.root, config: { policy: { root: 'custom', file: outside, global: false } } })
    const text = textOf(await runStep(listeners, makeAgent()))
    assert.doesNotMatch(text, /OUTSIDE RULES/)
    assert.match(text, /outside the project root/)
  } finally {
    await rm(fx.base, { recursive: true, force: true })
  }
})

test('a compose failure leaves the step untouched', async () => {
  const listeners = { preStep: [], tools: [] }
  const ctx = {
    on: (event, fn) => {
      if (event === 'agent/pre-step') listeners.preStep.push(fn)
      if (event === 'tools/result') listeners.tools.push(fn)
    },
    get: (name) => (name === 'workingDirectory' ? { ensure: async () => { throw new Error('boom') } } : undefined),
    logger: { warn() {} },
  }
  apply(ctx, {})
  const claimed = [{ id: 'u1' }]
  const decision = await listeners.preStep[0](
    { agent: makeAgent(), messages: claimed, step: 1, signal: new AbortController().signal },
    async () => ({ kind: 'proceed', messages: claimed }),
  )
  assert.deepEqual(decision.messages, claimed)
})

test('a session policy record overrides the row defaults', async () => {
  const fx = await fixture()
  process.env.DSH_HOME = fx.home
  process.env.DSH_AGENTS_HOME = fx.agents
  await writeFile(join(fx.root, 'CUSTOM.md'), 'CUSTOM RULES')
  try {
    const agent = makeAgent()
    applyPolicyCommand(agent, 'root custom CUSTOM.md')
    applyPolicyCommand(agent, 'global off')
    const listeners = mount({ cwd: join(fx.root, 'sub'), config: undefined })
    const text = textOf(await runStep(listeners, agent))
    assert.match(text, /CUSTOM RULES/)
    assert.doesNotMatch(text, /ROOT RULES/)
    assert.match(text, /SUB RULES/)
  } finally {
    await rm(fx.base, { recursive: true, force: true })
  }
})

test('nested discovery can be switched off and back on mid-session', async () => {
  const fx = await fixture()
  process.env.DSH_HOME = fx.home
  process.env.DSH_AGENTS_HOME = fx.agents
  try {
    const cwd = join(fx.root, 'sub')
    const agent = makeAgent()
    const listeners = mount({ cwd, config: undefined })
    await runStep(listeners, agent)
    const touch = (path) => {
      for (const listener of listeners.tools) {
        listener({ name: 'read', arguments: { file_path: join(cwd, path) }, agent }, { isError: false })
      }
    }
    touch('deep/NOTE.md')
    assert.match(textOf(await runStep(listeners, agent, 2)), /DEEP RULES/)
    applyPolicyCommand(agent, 'nested off')
    touch('deep/NOTE.md')
    const off = textOf(await runStep(listeners, agent, 3))
    assert.match(off, /Instructions removed/)
    assert.doesNotMatch(off, /DEEP RULES/)
    applyPolicyCommand(agent, 'nested on')
    assert.match(textOf(await runStep(listeners, agent, 4)), /DEEP RULES/)
  } finally {
    await rm(fx.base, { recursive: true, force: true })
  }
})

test('/instructions locks root after the first turn but keeps nested switchable', async () => {
  const registered = []
  const ctx = {
    on: () => {},
    get: (name) => {
      if (name === 'commands') return { register: (definition) => { registered.push(definition); return () => {} } }
      return undefined
    },
    logger: { warn() {} },
    effect: (factory) => { factory() },
  }
  apply(ctx, { locale: 'en' })
  assert.equal(registered.length, 1)
  const agent = makeAgent()
  agent.session.append('turn/start', {})
  const lockedRoot = await registered[0].handler({ agent, rawInput: 'root default' })
  assert.equal(lockedRoot.kind, 'error')
  const nested = await registered[0].handler({ agent, rawInput: 'nested off' })
  assert.equal(nested.kind, 'success')
  assert.match(nested.text, /subdirectory discovery: off/)
})

test('root off drops the root scope but keeps the rest of the chain', async () => {
  const fx = await fixture()
  process.env.DSH_HOME = fx.home
  process.env.DSH_AGENTS_HOME = fx.agents
  try {
    const listeners = mount({ cwd: join(fx.root, 'sub'), config: { policy: { root: 'off' } } })
    const text = textOf(await runStep(listeners, makeAgent()))
    assert.doesNotMatch(text, /ROOT RULES/)
    assert.match(text, /SUB RULES/)
  } finally {
    await rm(fx.base, { recursive: true, force: true })
  }
})

test('a resumed session recovers which scopes belong to the baseline', async () => {
  const { scanVisibleInstructions } = await import('../lib/state.js')
  const events = [
    {
      type: 'user/message',
      data: {
        source: {
          kind: 'agent-instructions',
          baseline: true,
          baselineIdentity: 'x',
          changes: [
            { action: 'set', scope: 'AGENTS.md', path: 'AGENTS.md' },
            { action: 'set', scope: 'CLAUDE.md', path: 'CLAUDE.md' },
          ],
        },
      },
    },
    {
      type: 'user/message',
      data: {
        source: {
          kind: 'agent-instructions',
          changes: [{ action: 'set', scope: 'sub/AGENTS.md', path: 'sub/AGENTS.md' }],
        },
      },
    },
  ]
  const session = { surface: { nodes: [0, 1] }, eventAt: (seq) => events[seq] }
  const scan = scanVisibleInstructions(session)
  assert.deepEqual([...scan.baselineScopes].sort(), ['AGENTS.md', 'CLAUDE.md'])
  assert.equal(scan.loaded.size, 3)
  assert.equal(scan.baselineIdentity, 'x')
})


test('uses the running shipped renderer when the host provides it', async () => {
  const fx = await fixture()
  process.env.DSH_HOME = fx.home
  process.env.DSH_AGENTS_HOME = fx.agents
  let seen = 0
  const official = {
    renderAgentInstructions: (files) => {
      seen = files.length
      return { text: '<system-reminder>\nOFFICIAL RENDERER\n</system-reminder>' }
    },
  }
  try {
    const listeners = mount({ cwd: fx.root, config: undefined, official })
    const text = textOf(await runStep(listeners, makeAgent()))
    assert.match(text, /OFFICIAL RENDERER/)
    assert.ok(seen >= 1)
  } finally {
    await rm(fx.base, { recursive: true, force: true })
  }
})

test('an attached file becomes a replayable custom root', async () => {
  const registered = []
  const ctx = {
    on: () => {},
    get: (name) => {
      if (name === 'commands') return { register: (definition) => { registered.push(definition); return () => {} } }
      if (name === 'attachments') return { readFileStream: async function* () { yield Buffer.from('ATTACHED RULES') } }
      return undefined
    },
    logger: { warn() {} },
    effect: (factory) => { factory() },
  }
  apply(ctx, { locale: 'en' })
  const result = await registered[0].handler({ agent: makeAgent(), rawInput: 'root attach sha256:abc 14 rules.md' })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /custom \(rules\.md\)/)
})

test('an encoded attach name survives import unchanged', async () => {
  const registered = []
  const ctx = {
    on: () => {},
    get: (name) => {
      if (name === 'commands') return { register: (definition) => { registered.push(definition); return () => {} } }
      if (name === 'attachments') {
        return {
          readFileStream: async function* (ref) {
            assert.equal(ref.name, 'my  rules.md')
            yield Buffer.from('ATTACHED RULES')
          },
        }
      }
      return undefined
    },
    logger: { warn() {} },
    effect: (factory) => { factory() },
  }
  apply(ctx, { locale: 'en' })
  const result = await registered[0].handler({
    agent: makeAgent(),
    rawInput: 'root attach sha256:abc 14 uri:my%20%20rules.md',
  })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /custom \(my  rules\.md\)/)
})

test('a replayed encoded attach reads the exact stored name', async () => {
  const fx = await fixture()
  process.env.DSH_HOME = fx.home
  process.env.DSH_AGENTS_HOME = fx.agents
  try {
    const agent = makeAgent()
    applyPolicyCommand(agent, 'root attach sha256:abc 14 uri:my%20%20rules.md')
    let seen
    const decision = await runStep(mount({
      cwd: fx.root,
      config: { policy: { global: false } },
      attachments: {
        readFileStream: async function* (ref) {
          seen = ref.name
          yield Buffer.from('ATTACHED RULES')
        },
      },
    }), agent)
    assert.equal(seen, 'my  rules.md')
    const text = textOf(decision)
    assert.match(text, /Instructions from: attachment\/my  rules\.md/)
    assert.match(text, /ATTACHED RULES/)
    const baseline = decision.messages.find(message => message.source?.kind === 'agent-instructions')
    assert.equal(baseline.source.policy.root, 'custom')
    assert.match(baseline.source.policy.file, /^dsh-attachment:sha256:abc#14#my%20%20rules\.md$/)
  } finally {
    await rm(fx.base, { recursive: true, force: true })
  }
})

test('a replayed attach injects the stored attachment as the root file', async () => {
  const fx = await fixture()
  process.env.DSH_HOME = fx.home
  process.env.DSH_AGENTS_HOME = fx.agents
  try {
    const agent = makeAgent()
    applyPolicyCommand(agent, 'root attach sha256:abc 14 rules.md')
    const decision = await runStep(mount({
      cwd: fx.root,
      config: { policy: { global: false } },
      attachments: { readFileStream: async function* () { yield Buffer.from('ATTACHED RULES') } },
    }), agent)
    const text = textOf(decision)
    assert.match(text, /Instructions from: attachment\/rules\.md/)
    assert.match(text, /ATTACHED RULES/)
    assert.doesNotMatch(text, /ROOT RULES/)
    const baseline = decision.messages.find(message => message.source?.kind === 'agent-instructions')
    assert.equal(baseline.source.policy.root, 'custom')
    assert.match(baseline.source.policy.file, /^dsh-attachment:sha256:abc#14#rules\.md$/)
  } finally {
    await rm(fx.base, { recursive: true, force: true })
  }
})

test('an attach survives a later policy command', async () => {
  const fx = await fixture()
  process.env.DSH_HOME = fx.home
  process.env.DSH_AGENTS_HOME = fx.agents
  try {
    const agent = makeAgent()
    applyPolicyCommand(agent, 'root attach sha256:abc 14 rules.md')
    applyPolicyCommand(agent, 'global off')
    const decision = await runStep(mount({
      cwd: fx.root,
      config: undefined,
      attachments: { readFileStream: async function* () { yield Buffer.from('ATTACHED RULES') } },
    }), agent)
    const text = textOf(decision)
    assert.match(text, /ATTACHED RULES/)
    assert.doesNotMatch(text, /ROOT RULES/)
    const baseline = decision.messages.find(message => message.source?.kind === 'agent-instructions')
    assert.equal(baseline.source.policy.root, 'custom')
    assert.equal(baseline.source.policy.global, false)
  } finally {
    await rm(fx.base, { recursive: true, force: true })
  }
})

test('a missing attachment keeps the root scope off and reports it', async () => {
  const fx = await fixture()
  process.env.DSH_HOME = fx.home
  process.env.DSH_AGENTS_HOME = fx.agents
  try {
    const agent = makeAgent()
    applyPolicyCommand(agent, 'root attach sha256:abc 14 rules.md')
    const text = textOf(await runStep(mount({
      cwd: fx.root,
      config: { policy: { global: false } },
      attachments: undefined,
    }), agent))
    assert.doesNotMatch(text, /ROOT RULES/)
    assert.match(text, /rules\.md/)
  } finally {
    await rm(fx.base, { recursive: true, force: true })
  }
})

test('a compacted baseline is rendered again on the next step', async () => {
  const fx = await fixture()
  process.env.DSH_HOME = fx.home
  process.env.DSH_AGENTS_HOME = fx.agents
  try {
    const agent = makeAgent()
    const listeners = mount({ cwd: join(fx.root, 'sub'), config: undefined })
    assert.match(textOf(await runStep(listeners, agent)), /ROOT RULES/)
    compactSurface(agent)
    const decision = await runStep(listeners, agent, 2)
    const text = textOf(decision)
    assert.match(text, /ROOT RULES/)
    assert.match(text, /SUB RULES/)
    const baseline = decision.messages.find(message => message.source?.kind === 'agent-instructions')
    assert.equal(baseline.source.baseline, true)
  } finally {
    await rm(fx.base, { recursive: true, force: true })
  }
})

test('compaction re-arms nested scopes only after another touch', async () => {
  const fx = await fixture()
  process.env.DSH_HOME = fx.home
  process.env.DSH_AGENTS_HOME = fx.agents
  try {
    const cwd = join(fx.root, 'sub')
    const agent = makeAgent()
    const listeners = mount({ cwd, config: undefined })
    await runStep(listeners, agent)
    touchFile(listeners, agent, join(cwd, 'deep', 'NOTE.md'))
    assert.match(textOf(await runStep(listeners, agent, 2)), /DEEP RULES/)
    compactSurface(agent)

    const compacted = textOf(await runStep(listeners, agent, 3))
    assert.match(compacted, /ROOT RULES/)
    assert.doesNotMatch(compacted, /DEEP RULES/)

    touchFile(listeners, agent, join(cwd, 'deep', 'NOTE.md'))
    const restored = textOf(await runStep(listeners, agent, 4))
    assert.match(restored, /DEEP RULES/)
  } finally {
    await rm(fx.base, { recursive: true, force: true })
  }
})

test('a surface replacement is detected without replaceGeneration', async () => {
  const fx = await fixture()
  process.env.DSH_HOME = fx.home
  process.env.DSH_AGENTS_HOME = fx.agents
  try {
    const agent = makeAgent()
    // A runtime that renamed or dropped the field still has to re-inject a
    // baseline compaction shadowed; the folded node prefix is the fallback.
    delete agent.session.surface.replaceGeneration
    const listeners = mount({ cwd: join(fx.root, 'sub'), config: undefined })
    assert.match(textOf(await runStep(listeners, agent)), /ROOT RULES/)
    const seq = agent.session.append('compaction/summary', { text: 'summary so far' })
    agent.session.surface.nodes.splice(0, agent.session.surface.nodes.length, seq)
    const text = textOf(await runStep(listeners, agent, 2))
    assert.match(text, /ROOT RULES/)
    assert.match(text, /SUB RULES/)
  } finally {
    await rm(fx.base, { recursive: true, force: true })
  }
})

test('a resumed session does not re-inject a visible baseline', async () => {
  const fx = await fixture()
  process.env.DSH_HOME = fx.home
  process.env.DSH_AGENTS_HOME = fx.agents
  try {
    const agent = makeAgent()
    await runStep(mount({ cwd: join(fx.root, 'sub'), config: undefined }), agent)
    const resumed = mount({ cwd: join(fx.root, 'sub'), config: undefined })
    assert.equal(textOf(await runStep(resumed, agent, 2)), '')
  } finally {
    await rm(fx.base, { recursive: true, force: true })
  }
})

test('a policy change replaces the visible baseline', async () => {
  const fx = await fixture()
  process.env.DSH_HOME = fx.home
  process.env.DSH_AGENTS_HOME = fx.agents
  try {
    const agent = makeAgent()
    const listeners = mount({ cwd: join(fx.root, 'sub'), config: undefined })
    assert.match(textOf(await runStep(listeners, agent)), /ROOT RULES/)
    applyPolicyCommand(agent, 'root off')
    const text = textOf(await runStep(listeners, agent, 2))
    assert.match(text, /replaces all earlier workspace instruction baselines/)
    assert.doesNotMatch(text, /ROOT RULES/)
    assert.match(text, /SUB RULES/)
  } finally {
    await rm(fx.base, { recursive: true, force: true })
  }
})

test('a first step with no claimed messages stays a no-step turn', async () => {
  const fx = await fixture()
  process.env.DSH_HOME = fx.home
  process.env.DSH_AGENTS_HOME = fx.agents
  try {
    const listeners = mount({ cwd: fx.root, config: undefined })
    const decision = await runStep(listeners, makeAgent(), 1, [])
    assert.equal(decision.messages.length, 0)
    assert.equal(textOf(decision), '')
  } finally {
    await rm(fx.base, { recursive: true, force: true })
  }
})

test('a later empty entering batch still restores a compacted baseline', async () => {
  const fx = await fixture()
  process.env.DSH_HOME = fx.home
  process.env.DSH_AGENTS_HOME = fx.agents
  try {
    const agent = makeAgent()
    const listeners = mount({ cwd: fx.root, config: undefined })
    assert.match(textOf(await runStep(listeners, agent)), /ROOT RULES/)
    compactSurface(agent)
    const decision = await runStep(listeners, agent, 2, [])
    assert.match(textOf(decision), /ROOT RULES/)
    assert.equal(
      decision.messages.filter(message => message.source?.kind === 'agent-instructions').length,
      1,
    )
  } finally {
    await rm(fx.base, { recursive: true, force: true })
  }
})

test('the built-in renderer keeps the complete baseline within maxBytes', async () => {
  const fx = await fixture()
  process.env.DSH_HOME = fx.home
  process.env.DSH_AGENTS_HOME = fx.agents
  await writeFile(join(fx.root, 'AGENTS.md'), 'BROAD RULES\n'.repeat(400))
  try {
    const listeners = mount({ cwd: fx.root, config: { maxBytes: 600, policy: { global: false } } })
    const text = textOf(await runStep(listeners, makeAgent()))
    assert.ok(Buffer.byteLength(text, 'utf8') <= 600, `baseline exceeded the budget: ${Buffer.byteLength(text, 'utf8')}`)
    assert.match(text, /Workspace instruction budget 600 bytes/)
  } finally {
    await rm(fx.base, { recursive: true, force: true })
  }
})

test('budget truncation never splits a multibyte character', async () => {
  const fx = await fixture()
  process.env.DSH_HOME = fx.home
  process.env.DSH_AGENTS_HOME = fx.agents
  await writeFile(join(fx.root, 'AGENTS.md'), '中'.repeat(3000))
  try {
    const listeners = mount({ cwd: fx.root, config: { maxBytes: 600, policy: { global: false } } })
    const text = textOf(await runStep(listeners, makeAgent()))
    assert.ok(Buffer.byteLength(text, 'utf8') <= 600)
    assert.doesNotMatch(text, /\uFFFD/)
  } finally {
    await rm(fx.base, { recursive: true, force: true })
  }
})

test('instruction messages publish the policy that produced them', async () => {
  const fx = await fixture()
  process.env.DSH_HOME = fx.home
  process.env.DSH_AGENTS_HOME = fx.agents
  try {
    const agent = makeAgent()
    applyPolicyCommand(agent, 'global off')
    const decision = await runStep(mount({ cwd: join(fx.root, 'sub'), config: undefined }), agent)
    const message = decision.messages.find(entry => entry.source?.kind === 'agent-instructions')
    assert.equal(message.source.policy.root, 'default')
    assert.equal(message.source.policy.global, false)
    assert.equal(message.source.policy.nested, true)
    assert.equal(message.source.projectRoot, fx.root)
  } finally {
    await rm(fx.base, { recursive: true, force: true })
  }
})

test('a relative custom root resolves against the working directory first', async () => {
  const fx = await fixture()
  process.env.DSH_HOME = fx.home
  process.env.DSH_AGENTS_HOME = fx.agents
  await writeFile(join(fx.root, 'sub', 'CUSTOM.md'), 'LOCAL CUSTOM RULES')
  await writeFile(join(fx.root, 'CUSTOM.md'), 'ROOT CUSTOM RULES')
  try {
    const listeners = mount({
      cwd: join(fx.root, 'sub'),
      config: { policy: { root: 'custom', file: 'CUSTOM.md', global: false } },
    })
    const text = textOf(await runStep(listeners, makeAgent()))
    assert.match(text, /LOCAL CUSTOM RULES/)
    assert.doesNotMatch(text, /ROOT CUSTOM RULES/)
  } finally {
    await rm(fx.base, { recursive: true, force: true })
  }
})

test('a custom root that is also a chain candidate renders once', async () => {
  const fx = await fixture()
  process.env.DSH_HOME = fx.home
  process.env.DSH_AGENTS_HOME = fx.agents
  try {
    const listeners = mount({
      cwd: join(fx.root, 'sub'),
      config: { policy: { root: 'custom', file: 'sub/AGENTS.md', global: false } },
    })
    const text = textOf(await runStep(listeners, makeAgent()))
    assert.equal(text.match(/SUB RULES/g)?.length, 1)
    assert.equal(text.match(/Instructions from: sub\/AGENTS\.md/g)?.length, 1)
  } finally {
    await rm(fx.base, { recursive: true, force: true })
  }
})

test('/instructions show reports the project root and the loaded files', async () => {
  const fx = await fixture()
  process.env.DSH_HOME = fx.home
  process.env.DSH_AGENTS_HOME = fx.agents
  const cwd = join(fx.root, 'sub')
  try {
    const registered = []
    const ctx = {
      on: () => {},
      get: (name) => {
        if (name === 'commands') return { register: (definition) => { registered.push(definition); return () => {} } }
        if (name === 'workingDirectory') return { ensure: async () => cwd }
        return undefined
      },
      logger: { warn() {} },
      effect: (factory) => { factory() },
    }
    apply(ctx, { locale: 'en' })
    const result = await registered[0].handler({ agent: makeAgent(), rawInput: 'show' })
    assert.equal(result.kind, 'success')
    assert.match(result.text, new RegExp(`project root: ${fx.root.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}`))
    assert.match(result.text, /files: AGENTS\.md, sub\/AGENTS\.md/)
  } finally {
    await rm(fx.base, { recursive: true, force: true })
  }
})

test('/instructions show includes the nested files the model already loaded', async () => {
  const fx = await fixture()
  process.env.DSH_HOME = fx.home
  process.env.DSH_AGENTS_HOME = fx.agents
  const cwd = join(fx.root, 'sub')
  try {
    const registered = []
    const listeners = { preStep: [], tools: [] }
    const ctx = {
      on: (event, fn) => {
        if (event === 'agent/pre-step') listeners.preStep.push(fn)
        if (event === 'tools/result') listeners.tools.push(fn)
      },
      get: (name) => {
        if (name === 'commands') return { register: (definition) => { registered.push(definition); return () => {} } }
        if (name === 'workingDirectory') return { ensure: async () => cwd }
        return undefined
      },
      logger: { warn() {} },
      effect: (factory) => { factory() },
    }
    apply(ctx, { policy: { global: false }, locale: 'en' })
    const agent = makeAgent()
    await runStep(listeners, agent)
    touchFile(listeners, agent, join(cwd, 'deep', 'NOTE.md'))
    assert.match(textOf(await runStep(listeners, agent, 2)), /DEEP RULES/)

    const result = await registered[0].handler({ agent, rawInput: 'show' })
    assert.equal(result.kind, 'success')
    assert.match(result.text, /sub\/AGENTS\.md/)
    assert.match(result.text, /sub\/deep\/AGENTS\.md/)
  } finally {
    await rm(fx.base, { recursive: true, force: true })
  }
})

test('/instructions show lists only the files the renderer loads', async () => {
  const fx = await fixture()
  process.env.DSH_HOME = fx.home
  process.env.DSH_AGENTS_HOME = fx.agents
  await writeFile(join(fx.root, 'AGENTS.md'), 'A'.repeat(400))
  await writeFile(join(fx.root, 'CLAUDE.md'), 'B'.repeat(400))
  try {
    const registered = []
    const ctx = {
      on: () => {},
      get: (name) => {
        if (name === 'commands') return { register: (definition) => { registered.push(definition); return () => {} } }
        if (name === 'workingDirectory') return { ensure: async () => fx.root }
        return undefined
      },
      logger: { warn() {} },
      effect: (factory) => { factory() },
    }
    apply(ctx, { maxBytes: 700, policy: { global: false }, locale: 'en' })
    const result = await registered[0].handler({ agent: makeAgent(), rawInput: 'show' })
    assert.equal(result.kind, 'success')
    assert.match(result.text, /files: CLAUDE\.md/)
    assert.match(result.text, /not loaded \(budget\): AGENTS\.md/)
    assert.doesNotMatch(result.text, /files: .*AGENTS\.md/)
  } finally {
    await rm(fx.base, { recursive: true, force: true })
  }
})

test('/instructions show reports a disabled budget instead of discovered files', async () => {
  const fx = await fixture()
  process.env.DSH_HOME = fx.home
  process.env.DSH_AGENTS_HOME = fx.agents
  try {
    const registered = []
    const ctx = {
      on: () => {},
      get: (name) => {
        if (name === 'commands') return { register: (definition) => { registered.push(definition); return () => {} } }
        if (name === 'workingDirectory') return { ensure: async () => fx.root }
        return undefined
      },
      logger: { warn() {} },
      effect: (factory) => { factory() },
    }
    apply(ctx, { maxBytes: 0, locale: 'en' })
    const result = await registered[0].handler({ agent: makeAgent(), rawInput: 'show' })
    assert.equal(result.kind, 'success')
    assert.match(result.text, /files: none/)
    assert.match(result.text, /budget: disabled \(maxBytes: 0\)/)
  } finally {
    await rm(fx.base, { recursive: true, force: true })
  }
})

test('root off drops the project-root scope but keeps subdirectory appends', async () => {
  const fx = await fixture()
  process.env.DSH_HOME = fx.home
  process.env.DSH_AGENTS_HOME = fx.agents
  try {
    const cwd = join(fx.root, 'sub')
    const agent = makeAgent()
    const listeners = mount({ cwd, config: { policy: { root: 'off', global: false } } })
    const baseline = textOf(await runStep(listeners, agent))
    assert.doesNotMatch(baseline, /ROOT RULES/)
    assert.match(baseline, /SUB RULES/)
    for (const touch of listeners.tools) {
      touch({ name: 'read', arguments: { file_path: join(cwd, 'deep', 'NOTE.md') }, agent }, { isError: false })
    }
    const appended = textOf(await runStep(listeners, agent, 2))
    assert.match(appended, /DEEP RULES/)
    assert.doesNotMatch(appended, /ROOT RULES/)
  } finally {
    await rm(fx.base, { recursive: true, force: true })
  }
})

function instructionMessageOf(decision) {
  return decision.messages.find(message => message.source?.kind === 'agent-instructions')
}

test('a budget-omitted baseline file is not recorded as loaded', async () => {
  const fx = await fixture()
  process.env.DSH_HOME = fx.home
  process.env.DSH_AGENTS_HOME = fx.agents
  await writeFile(join(fx.root, 'AGENTS.md'), 'A'.repeat(400))
  await writeFile(join(fx.root, 'CLAUDE.md'), 'B'.repeat(400))
  try {
    const listeners = mount({ cwd: fx.root, config: { maxBytes: 700, policy: { global: false } } })
    const decision = await runStep(listeners, makeAgent())
    assert.match(textOf(decision), /omitted AGENTS\.md/)
    // CLAUDE.md is represented (truncated); AGENTS.md was dropped whole.
    assert.deepEqual(
      instructionMessageOf(decision).source.changes.map(change => `${change.action}:${change.scope}`),
      ['set:CLAUDE.md'],
    )
  } finally {
    await rm(fx.base, { recursive: true, force: true })
  }
})

test('a formerly visible baseline file that the budget drops is retracted', async () => {
  const fx = await fixture()
  process.env.DSH_HOME = fx.home
  process.env.DSH_AGENTS_HOME = fx.agents
  await writeFile(join(fx.root, 'AGENTS.md'), 'A'.repeat(400))
  await writeFile(join(fx.root, 'CLAUDE.md'), 'B'.repeat(400))
  try {
    const agent = makeAgent()
    await runStep(mount({ cwd: fx.root, config: { policy: { global: false } } }), agent)
    // A new budget changes the baseline identity, so the baseline renders again
    // and the file the budget had to drop must be retracted instead of lingering.
    const decision = await runStep(
      mount({ cwd: fx.root, config: { maxBytes: 700, policy: { global: false } } }),
      agent,
      2,
    )
    assert.deepEqual(
      instructionMessageOf(decision).source.changes.map(change => `${change.action}:${change.scope}`),
      ['remove:AGENTS.md', 'replace:CLAUDE.md'],
    )
  } finally {
    await rm(fx.base, { recursive: true, force: true })
  }
})

test('the shipped renderer reports which files its text omitted', async () => {
  const fx = await fixture()
  process.env.DSH_HOME = fx.home
  process.env.DSH_AGENTS_HOME = fx.agents
  await writeFile(join(fx.root, 'CLAUDE.md'), 'B'.repeat(40))
  const official = {
    renderAgentInstructions: (files) => ({
      text: '<system-reminder>\n\nWorkspace instruction budget 100 bytes: omitted AGENTS.md\n\n</system-reminder>',
      omitted: files.filter(file => file.displayPath === 'AGENTS.md'),
    }),
  }
  try {
    const decision = await runStep(
      mount({ cwd: fx.root, config: { policy: { global: false } }, official }),
      makeAgent(),
    )
    assert.deepEqual(
      instructionMessageOf(decision).source.changes.map(change => change.scope),
      ['CLAUDE.md'],
    )
  } finally {
    await rm(fx.base, { recursive: true, force: true })
  }
})

test('a shipped-renderer truncation to zero bytes is not recorded as loaded', async () => {
  const fx = await fixture()
  process.env.DSH_HOME = fx.home
  process.env.DSH_AGENTS_HOME = fx.agents
  try {
    const truncated = (includedBytes) => ({
      renderAgentInstructions: () => ({
        text: `<system-reminder>\nWorkspace instruction budget 100 bytes: truncated AGENTS.md from 5000 to ${includedBytes} bytes\n</system-reminder>`,
        omitted: [],
        truncated: [{ displayPath: 'AGENTS.md', originalBytes: 5000, includedBytes }],
      }),
    })
    const dropped = await runStep(
      mount({ cwd: fx.root, config: { maxBytes: 100, policy: { global: false } }, official: truncated(0) }),
      makeAgent(),
    )
    assert.deepEqual(instructionMessageOf(dropped).source.changes, [])
    const partial = await runStep(
      mount({ cwd: fx.root, config: { maxBytes: 100, policy: { global: false } }, official: truncated(10) }),
      makeAgent(),
    )
    assert.deepEqual(
      instructionMessageOf(partial).source.changes.map(change => `${change.action}:${change.scope}`),
      ['set:AGENTS.md'],
    )
  } finally {
    await rm(fx.base, { recursive: true, force: true })
  }
})

test('nested entries dropped by the budget wait for another touch', async () => {
  const fx = await fixture()
  process.env.DSH_HOME = fx.home
  process.env.DSH_AGENTS_HOME = fx.agents
  await mkdir(join(fx.root, 'sub', 'deep1'), { recursive: true })
  await mkdir(join(fx.root, 'sub', 'deep2'), { recursive: true })
  await writeFile(join(fx.root, 'sub', 'deep1', 'AGENTS.md'), 'DEEP1 ' + 'A'.repeat(300))
  await writeFile(join(fx.root, 'sub', 'deep2', 'AGENTS.md'), 'DEEP2 ' + 'B'.repeat(300))
  try {
    const cwd = join(fx.root, 'sub')
    const agent = makeAgent()
    const listeners = mount({ cwd, config: { maxBytes: 600, policy: { global: false } } })
    await runStep(listeners, agent)
    for (const directory of ['deep1', 'deep2']) {
      for (const touch of listeners.tools) {
        touch({ name: 'read', arguments: { file_path: join(cwd, directory, 'NOTE.md') }, agent }, { isError: false })
      }
    }

    const first = await runStep(listeners, agent, 2)
    assert.match(textOf(first), /DEEP2/)
    assert.doesNotMatch(textOf(first), /DEEP1/)
    assert.deepEqual(
      instructionMessageOf(first).source.changes.map(change => change.scope),
      ['sub/deep2/AGENTS.md'],
    )

    // No new touch: the dropped directory is not probed again.
    assert.equal(textOf(await runStep(listeners, agent, 3)), '')

    touchFile(listeners, agent, join(cwd, 'deep1', 'NOTE.md'), 'read')
    const retry = await runStep(listeners, agent, 4)
    assert.match(textOf(retry), /DEEP1/)
    assert.doesNotMatch(textOf(retry), /DEEP2/)
    assert.deepEqual(
      instructionMessageOf(retry).source.changes.map(change => change.scope),
      ['sub/deep1/AGENTS.md'],
    )

    assert.equal(textOf(await runStep(listeners, agent, 5)), '')
  } finally {
    await rm(fx.base, { recursive: true, force: true })
  }
})

test('nested removal notices dropped by the budget wait for another touch', async () => {
  const fx = await fixture()
  process.env.DSH_HOME = fx.home
  process.env.DSH_AGENTS_HOME = fx.agents
  const cwd = join(fx.root, 'sub')
  const dirs = ['r1', 'r2', 'r3', 'r4']
  for (const [index, directory] of dirs.entries()) {
    await mkdir(join(cwd, directory), { recursive: true })
    await writeFile(join(cwd, directory, 'AGENTS.md'), `R${index + 1} RULES`)
  }
  const removalScopes = decision => decision.messages
    .filter(message => message.source?.kind === 'agent-instructions')
    .flatMap(message => message.source.changes)
    .filter(change => change.action === 'remove')
    .map(change => change.scope)
  const touch = (listeners, agent, directory) => {
    for (const listener of listeners.tools) {
      listener({ name: 'read', arguments: { file_path: join(cwd, directory, 'NOTE.md') }, agent }, { isError: false })
    }
  }
  try {
    const agent = makeAgent()
    const loadListeners = mount({ cwd, config: { maxBytes: 2000, policy: { global: false } } })
    await runStep(loadListeners, agent)
    for (const directory of dirs) touch(loadListeners, agent, directory)
    const loaded = await runStep(loadListeners, agent, 2)
    for (const index of dirs.keys()) assert.match(textOf(loaded), new RegExp(`R${index + 1} RULES`))

    for (const directory of dirs) await rm(join(cwd, directory, 'AGENTS.md'))

    // A smaller mount folds the same visible state from the log, then has to
    // render four removal notices under a budget that only fits some of them.
    const listeners = mount({ cwd, config: { maxBytes: 400, policy: { global: false } } })
    for (const directory of dirs) touch(listeners, agent, directory)
    const first = await runStep(listeners, agent, 3)
    const firstRemovals = removalScopes(first)
    assert.ok(firstRemovals.length > 0, 'expected at least one removal notice')
    assert.ok(firstRemovals.length < dirs.length, 'expected the budget to drop some removals')

    // No new touch: the remaining removal notices are not retried.
    assert.deepEqual(removalScopes(await runStep(listeners, agent, 4)), [])

    const allRemovals = new Set(firstRemovals)
    for (let attempt = 0; attempt < dirs.length && allRemovals.size < dirs.length; attempt += 1) {
      for (const directory of dirs) touch(listeners, agent, directory)
      const retryRemovals = removalScopes(await runStep(listeners, agent, 5 + attempt))
      for (const scope of retryRemovals) allRemovals.add(scope)
    }
    assert.deepEqual(
      [...allRemovals].sort(),
      dirs.map(directory => `sub/${directory}/AGENTS.md`).sort(),
    )
    assert.deepEqual(removalScopes(await runStep(listeners, agent, 10)), [])
  } finally {
    await rm(fx.base, { recursive: true, force: true })
  }
})

test('a nested instruction larger than the budget is truncated, not dropped', async () => {
  const fx = await fixture()
  process.env.DSH_HOME = fx.home
  process.env.DSH_AGENTS_HOME = fx.agents
  await writeFile(join(fx.root, 'sub', 'deep', 'AGENTS.md'), '中'.repeat(1000))
  try {
    const cwd = join(fx.root, 'sub')
    const agent = makeAgent()
    const listeners = mount({ cwd, config: { maxBytes: 600, policy: { global: false } } })
    await runStep(listeners, agent)
    for (const touch of listeners.tools) {
      touch({ name: 'read', arguments: { file_path: join(cwd, 'deep', 'NOTE.md') }, agent }, { isError: false })
    }
    const decision = await runStep(listeners, agent, 2)
    const text = textOf(decision)
    assert.match(text, /Additional instructions from: sub\/deep\/AGENTS\.md/)
    assert.match(text, /truncated sub\/deep\/AGENTS\.md from 3000 to \d+ bytes/)
    assert.ok(Buffer.byteLength(text, 'utf8') <= 600, `nested batch exceeded the budget: ${Buffer.byteLength(text, 'utf8')}`)
    assert.doesNotMatch(text, /\uFFFD/)
    assert.deepEqual(
      instructionMessageOf(decision).source.changes.map(change => change.scope),
      ['sub/deep/AGENTS.md'],
    )
  } finally {
    await rm(fx.base, { recursive: true, force: true })
  }
})

test('renderNested keeps the most specific section and reports only what it rendered', async () => {
  const { renderNested } = await import('../lib/render.js')
  const file = (path, content) => ({
    absolutePath: `C:/p/${path}`,
    displayPath: path,
    content,
    digest: 'd',
    bytes: Buffer.byteLength(content),
    chain: 'project',
  })
  const rendered = renderNested([
    { action: 'set', file: file('a/AGENTS.md', 'A'.repeat(400)) },
    { action: 'set', file: file('b/AGENTS.md', 'B'.repeat(40)) },
  ], 400)
  assert.ok(rendered !== undefined)
  assert.deepEqual(rendered.changes.map(change => change.file.displayPath), ['b/AGENTS.md'])
  assert.match(rendered.text, /omitted a\/AGENTS\.md/)
  assert.ok(Buffer.byteLength(rendered.text, 'utf8') <= 400)
})

test('renderRemovals bounds the notice and names only the paths it renders', async () => {
  const { renderRemovals } = await import('../lib/render.js')
  const paths = Array.from({ length: 8 }, (_, index) => `sub/d${index}/AGENTS.md`)
  const rendered = renderRemovals(paths, 500)
  assert.ok(rendered !== undefined)
  assert.ok(Buffer.byteLength(rendered.text, 'utf8') <= 500)
  assert.ok(rendered.removed.length < paths.length)
  assert.match(rendered.text, /more files? omitted to fit the configured byte budget/)
  for (const path of rendered.removed) {
    assert.ok(rendered.text.includes(`Instructions removed: ${path}`), path)
  }
})

test('the zh and en command messages carry the same keys', async () => {
  const { MESSAGES } = await import('../lib/i18n.js')
  const keys = (locale) => Object.keys(MESSAGES[locale]).sort()
  assert.deepEqual(keys('zh'), keys('en'))
  for (const locale of ['zh', 'en']) {
    for (const [key, value] of Object.entries(MESSAGES[locale])) {
      assert.ok(typeof value === 'string' || typeof value === 'function', `${locale}.${key}`)
    }
  }
  // No message may collapse to empty text in either language.
  assert.ok(MESSAGES.zh.title.length > 0)
  assert.ok(MESSAGES.en.title.length > 0)
  assert.notEqual(MESSAGES.zh.title, MESSAGES.en.title)
})

test('auto follows the language chosen in DSH', async () => {
  const registered = []
  const localeRow = { options: { id: 'locale', name: '@deepseek-ai/dsh-client-locale', config: { preference: 'zh' } } }
  const ctx = {
    on: () => {},
    get: (name) => {
      if (name === 'commands') return { register: (definition) => { registered.push(definition); return () => {} } }
      if (name === 'configEditor') return { entries: () => [localeRow] }
      return undefined
    },
    logger: { warn() {} },
    effect: (factory) => { factory() },
  }
  apply(ctx, { locale: 'auto' })
  const result = await registered[0].handler({ agent: makeAgent(), rawInput: 'nested off' })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /^指令策略/)
  assert.match(result.text, /子目录追加: 关/)
  assert.match(result.text, /用 \/instructions root\|global\|nested 修改本任务。/)
})

test('an unsupported DSH language falls back to English instead of the system language', async () => {
  const registered = []
  const ctx = {
    on: () => {},
    get: (name) => {
      if (name === 'commands') return { register: (definition) => { registered.push(definition); return () => {} } }
      // The reader deliberately picked Japanese; this plugin does not translate it.
      if (name === 'configEditor') {
        return { entries: () => [{ options: { id: 'locale', name: '@deepseek-ai/dsh-client-locale', config: { preference: 'ja' } } }] }
      }
      return undefined
    },
    logger: { warn() {} },
    effect: (factory) => { factory() },
  }
  apply(ctx, { locale: 'auto' })
  const result = await registered[0].handler({ agent: makeAgent(), rawInput: 'nested off' })
  assert.match(result.text, /^Instructions policy/)
})

test('an explicit row locale wins over the DSH preference', async () => {
  const registered = []
  const ctx = {
    on: () => {},
    get: (name) => {
      if (name === 'commands') return { register: (definition) => { registered.push(definition); return () => {} } }
      if (name === 'configEditor') {
        return { entries: () => [{ options: { id: 'locale', name: '@deepseek-ai/dsh-client-locale', config: { preference: 'en' } } }] }
      }
      return undefined
    },
    logger: { warn() {} },
    effect: (factory) => { factory() },
  }
  apply(ctx, { locale: 'zh' })
  const result = await registered[0].handler({ agent: makeAgent(), rawInput: 'nested off' })
  assert.match(result.text, /^指令策略/)
})

test('auto falls back to the system language when DSH has no preference', async () => {
  const { resolveCommandLocale } = await import('../lib/i18n.js')
  assert.equal(resolveCommandLocale('auto', { systemLocale: 'zh-CN' }), 'zh')
  assert.equal(resolveCommandLocale('auto', { systemLocale: 'zh_TW.UTF-8' }), 'zh')
  assert.equal(resolveCommandLocale('auto', { systemLocale: 'en-US' }), 'en')
  assert.equal(resolveCommandLocale('auto', { systemLocale: 'fr-FR' }), 'en')
  assert.equal(resolveCommandLocale('zh', { systemLocale: 'en-US' }), 'zh')
  assert.equal(resolveCommandLocale('en', { systemLocale: 'zh-CN' }), 'en')
  // A profile service that is not usable must not decide the language.
  const failing = { entries: () => { throw new Error('not ready') } }
  assert.equal(resolveCommandLocale('auto', { configEditor: failing, systemLocale: 'en-GB' }), 'en')
})

test('/instructions reports usage errors in the resolved language', async () => {
  const registered = []
  const ctx = {
    on: () => {},
    get: (name) => {
      if (name === 'commands') return { register: (definition) => { registered.push(definition); return () => {} } }
      return undefined
    },
    logger: { warn() {} },
    effect: (factory) => { factory() },
  }
  apply(ctx, { locale: 'zh' })
  const result = await registered[0].handler({ agent: makeAgent(), rawInput: 'global maybe' })
  assert.equal(result.kind, 'error')
  assert.equal(result.text, '用法: /instructions global on|off')
})

test('/instructions show prints Chinese labels and untouched paths', async () => {
  const fx = await fixture()
  process.env.DSH_HOME = fx.home
  process.env.DSH_AGENTS_HOME = fx.agents
  try {
    const registered = []
    const ctx = {
      on: () => {},
      get: (name) => {
        if (name === 'commands') return { register: (definition) => { registered.push(definition); return () => {} } }
        if (name === 'workingDirectory') return { ensure: async () => fx.root }
        return undefined
      },
      logger: { warn() {} },
      effect: (factory) => { factory() },
    }
    apply(ctx, { locale: 'zh', policy: { global: false } })
    const result = await registered[0].handler({ agent: makeAgent(), rawInput: 'show' })
    assert.equal(result.kind, 'success')
    assert.match(result.text, new RegExp(`项目根: ${fx.root.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}`))
    assert.match(result.text, /已加载: AGENTS\.md/)
    assert.match(result.text, /根文件: 默认/)
  } finally {
    await rm(fx.base, { recursive: true, force: true })
  }
})
