import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createPolicyProjectionDefinition } from '../lib/projection.js'

function definition(options = {}) {
  return createPolicyProjectionDefinition({
    hostConfig: options.hostConfig ?? { policy: { root: 'default', global: true, nested: true } },
    loader: {
      entries: () => options.entries ?? [],
    },
    warn: options.warn ?? (() => {}),
  })
}

function stateOf(def, header = {}) {
  return def.init(header, 0)
}

function viewOf(def, state) {
  return def.wire.view(state)
}

function event(seq, type, data) {
  return { seq, type, data }
}

test('initial state takes the host row policy defaults', () => {
  const def = definition({
    hostConfig: { policy: { root: 'off', file: null, global: false, nested: false } },
  })
  const view = viewOf(def, stateOf(def))
  assert.deepEqual(view.policy, { root: 'off', file: null, global: false, nested: false })
  assert.equal(view.locked, false)
  assert.equal(view.lastCommand, null)
  assert.equal(view.projectRoot, undefined)
  assert.deepEqual(view.loaded, [])
})

test('a successful command updates policy and only publishes a new view once', () => {
  const def = definition()
  let state = stateOf(def)
  const initial = viewOf(def, state)
  state = def.apply(state, event(1, 'command/run', {
    commandId: 'c1',
    name: 'instructions',
    args: 'nested off',
  }))
  assert.equal(viewOf(def, state), initial)
  assert.equal(viewOf(def, state).policy.nested, true)
  state = def.apply(state, event(2, 'command/done', { commandId: 'c1', kind: 'success' }))
  const view = viewOf(def, state)
  assert.notEqual(view, initial)
  assert.equal(view.policy.nested, false)
  assert.deepEqual(view.lastCommand, {
    commandId: 'c1',
    args: 'nested off',
    kind: 'success',
    text: '',
    seq: 2,
  })
})

test('a failed command records the host error without changing policy', () => {
  const def = definition()
  let state = stateOf(def)
  state = def.apply(state, event(1, 'command/run', {
    commandId: 'c1',
    name: 'instructions',
    args: 'root off',
  }))
  state = def.apply(state, event(2, 'command/done', {
    commandId: 'c1',
    kind: 'error',
    text: 'The instruction root is locked',
  }))
  const view = viewOf(def, state)
  assert.equal(view.policy.root, 'default')
  assert.equal(view.lastCommand.kind, 'error')
  assert.equal(view.lastCommand.text, 'The instruction root is locked')
})

test('turn and step starts lock the policy projection', () => {
  const def = definition()
  let state = stateOf(def)
  state = def.apply(state, event(1, 'turn/start', {}))
  assert.equal(viewOf(def, state).locked, true)
  const locked = state
  state = def.apply(state, event(2, 'step/start', {}))
  assert.equal(state, locked)
})

test('instruction messages fold the visible file set and project root', () => {
  const def = definition()
  let state = stateOf(def)
  state = def.apply(state, event(1, 'user/message', {
    source: {
      kind: 'agent-instructions',
      baseline: true,
      policy: { root: 'off', file: null, global: false, nested: true },
      projectRoot: 'C:/project',
      changes: [
        { action: 'set', scope: 'sub/AGENTS.md', path: 'sub/AGENTS.md' },
      ],
    },
  }))
  let view = viewOf(def, state)
  assert.equal(view.projectRoot, 'C:/project')
  assert.deepEqual(view.loaded, ['sub/AGENTS.md'])
  assert.equal(view.policy.root, 'off')

  state = def.apply(state, event(2, 'user/message', {
    source: {
      kind: 'agent-instructions',
      projectRoot: 'C:/project',
      changes: [
        { action: 'set', scope: 'sub/deep/AGENTS.md', path: 'sub/deep/AGENTS.md' },
      ],
    },
  }))
  view = viewOf(def, state)
  assert.deepEqual(view.loaded, ['sub/AGENTS.md', 'sub/deep/AGENTS.md'])

  state = def.apply(state, event(3, 'user/message', {
    source: {
      kind: 'agent-instructions',
      changes: [
        { action: 'remove', scope: 'sub/AGENTS.md', path: 'sub/AGENTS.md' },
      ],
    },
  }))
  view = viewOf(def, state)
  assert.deepEqual(view.loaded, ['sub/deep/AGENTS.md'])
})

test('a replacement baseline owns the scopes that vanish', () => {
  const def = definition()
  let state = stateOf(def)
  state = def.apply(state, event(1, 'user/message', {
    source: {
      kind: 'agent-instructions',
      baseline: true,
      policy: { root: 'default', file: null, global: false, nested: true },
      changes: [{ action: 'set', scope: 'AGENTS.md', path: 'AGENTS.md' }],
    },
  }))
  state = def.apply(state, event(2, 'user/message', {
    source: {
      kind: 'agent-instructions',
      baseline: true,
      policy: { root: 'default', file: null, global: false, nested: true },
      changes: [{ action: 'set', scope: 'CLAUDE.md', path: 'CLAUDE.md' }],
    },
  }))
  assert.deepEqual(viewOf(def, state).loaded, ['CLAUDE.md'])
})

test('a successful compaction clears the visible file set but keeps policy', () => {
  const def = definition()
  let state = stateOf(def)
  state = def.apply(state, event(1, 'user/message', {
    source: {
      kind: 'agent-instructions',
      baseline: true,
      policy: { root: 'off', file: null, global: false, nested: true },
      changes: [{ action: 'set', scope: 'AGENTS.md', path: 'AGENTS.md' }],
    },
  }))
  state = def.apply(state, event(2, 'compaction/end', {}))
  const view = viewOf(def, state)
  assert.deepEqual(view.loaded, [])
  assert.equal(view.policy.root, 'off')
  const cleared = state
  state = def.apply(state, event(3, 'compaction/end', { error: 'summary failed' }))
  assert.equal(state, cleared)
})

test('an unrelated event keeps the same state and view references', () => {
  const def = definition()
  const state = stateOf(def)
  const view = viewOf(def, state)
  assert.equal(def.apply(state, event(1, 'session/title', { title: 'x' })), state)
  assert.equal(viewOf(def, def.apply(state, event(2, 'session/title', { title: 'x' }))), view)
})

test('the preset row policy defaults are used when the header names a preset', () => {
  const def = definition({
    hostConfig: { policy: { root: 'default', global: true, nested: true } },
    entries: [{
      options: {
        name: '@deepseek-ai/dsh-agent-preset',
        config: {
          id: 'standard',
          plugins: [{
            name: '@deepseek-ai/dsh-agent-instructions',
            config: { policy: { root: 'off', global: false } },
          }],
        },
      },
    }],
  })
  const view = viewOf(def, stateOf(def, { agentPreset: 'standard' }))
  assert.equal(view.policy.root, 'off')
  assert.equal(view.policy.global, false)
  assert.equal(view.policy.nested, true)
})

test('cached state is validated and its visible value is rebuilt', () => {
  const def = definition()
  let state = stateOf(def)
  state = def.apply(state, event(1, 'turn/start', {}))
  const restored = def.stateSchema.parse(JSON.parse(JSON.stringify(state)))
  assert.equal(restored.locked, true)
  assert.deepEqual(restored.visible, def.wire.view(restored))
  assert.throws(() => def.stateSchema.parse({ policy: {} }), /invalid policy/)
})
