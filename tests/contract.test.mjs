import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { test } from 'node:test'
import { resolveConfig } from '../lib/config.js'
import { discoverBaseline } from '../lib/discovery.js'
import { createPolicyProjectionDefinition } from '../lib/projection.js'
import { renderBaseline } from '../lib/render.js'
import { encodeAttachmentFile } from '../lib/toolkit.js'

// These checks run against the DSH installation that is actually booting the
// harness, not against hand-written mocks. A renamed export, a changed store
// reference, or a renderer that no longer reads displayPath fails here instead
// of in a live session.
function findDshPackage() {
  const configured = process.env.DSH_INSTALL
  if (configured !== undefined && configured.length > 0) {
    const candidate = configured.endsWith('package.json') ? configured : join(configured, 'package.json')
    return existsSync(candidate) ? candidate : undefined
  }
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (directory.length === 0) continue
    const hasLauncher = ['dsh.cmd', 'dsh.ps1', 'dsh'].some(name => existsSync(join(directory, name)))
    if (!hasLauncher) continue
    const candidate = join(directory, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
    if (existsSync(candidate)) return candidate
  }
  const appData = process.env.APPDATA
  if (appData !== undefined) {
    const candidate = join(appData, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

const dshPackage = findDshPackage()
const requireDsh = dshPackage === undefined ? undefined : createRequire(dshPackage)

function installed(name) {
  try {
    return requireDsh?.(name)
  } catch {
    return undefined
  }
}

test('the installed attachment store accepts the policy file reference', async (t) => {
  const cordis = installed('@deepseek-ai/cordis')
  const attachmentLocal = installed('@deepseek-ai/dsh-attachment-local')
  if (dshPackage === undefined || cordis === undefined || attachmentLocal === undefined) {
    t.skip('no DSH installation found')
    return
  }
  const home = await mkdtemp(join(tmpdir(), 'dsh-contract-att-'))
  const project = await mkdtemp(join(tmpdir(), 'dsh-contract-proj-'))
  try {
    await mkdir(join(project, '.git'), { recursive: true })
    const ctx = new cordis.Context()
    const store = new attachmentLocal.LocalAttachmentStore(ctx, { dshHome: home })
    const ref = await store.saveFile({ data: Buffer.from('ATTACHMENT CONTRACT RULES'), name: 'rules.md' })
    const config = resolveConfig({
      policy: { root: 'custom', file: encodeAttachmentFile(ref), global: false },
    })
    const discovery = await discoverBaseline(config, project, project, undefined, undefined, store)
    assert.equal(discovery.customProblem, null)
    assert.equal(discovery.files.length, 1)
    assert.equal(discovery.files[0].displayPath, 'attachment/rules.md')
    assert.equal(discovery.files[0].content, 'ATTACHMENT CONTRACT RULES')

    const tampered = resolveConfig({
      policy: { root: 'custom', file: encodeAttachmentFile({ ...ref, bytes: ref.bytes + 1 }), global: false },
    })
    const rejected = await discoverBaseline(tampered, project, project, undefined, undefined, store)
    assert.deepEqual(rejected.customProblem, { kind: 'missing', file: 'rules.md' })
  } finally {
    await rm(home, { recursive: true, force: true })
    await rm(project, { recursive: true, force: true })
  }
})

test('the installed renderer still renders our baseline', (t) => {
  const official = installed('@deepseek-ai/dsh-agent-instructions')
  if (official === undefined || typeof official.renderAgentInstructions !== 'function') {
    t.skip('no DSH installation found')
    return
  }
  assert.equal(typeof official.apply, 'function')
  const rendered = renderBaseline([{
    absolutePath: join(tmpdir(), 'AGENTS.md'),
    displayPath: 'AGENTS.md',
    content: 'CONTRACT RULES',
    digest: 'd',
    bytes: 15,
    chain: 'project',
  }], 65_536, false, official)
  assert.match(rendered.text, /Instructions from: AGENTS\.md/)
  assert.match(rendered.text, /CONTRACT RULES/)
  // The installed renderer reports omissions, and the policy records only the
  // files its text carries.
  assert.deepEqual(rendered.included.map(file => file.displayPath), ['AGENTS.md'])
})

test('the installed projection registry serves the policy view', async (t) => {
  const cordis = installed('@deepseek-ai/cordis')
  const projection = installed('@deepseek-ai/dsh-session-projection')
  const sessionModule = installed('@deepseek-ai/dsh-session')
  if (cordis === undefined || projection === undefined || sessionModule === undefined) {
    t.skip('no DSH installation found')
    return
  }
  const ctx = new cordis.Context()
  new projection.SessionProjectionRegistry(ctx)
  const definition = createPolicyProjectionDefinition({
    hostConfig: { policy: { root: 'default', global: true, nested: true } },
    loader: { entries: () => [] },
  })
  const handle = await ctx.sessionProjections.register(definition)
  try {
    const session = sessionModule.Session.create('contract-policy', [], {
      version: 4,
      id: 'contract-policy',
      createdAt: 0,
      isSeeded: false,
      cwd: tmpdir(),
    })
    session.append('command/run', {
      commandId: 'contract-command',
      name: 'instructions',
      args: 'nested off',
    })
    session.append('command/done', { commandId: 'contract-command', kind: 'success' })
    session.append('user/message', {
      id: 'contract-message',
      role: 'user',
      content: [{ type: 'text', text: 'instructions' }],
      source: {
        kind: 'agent-instructions',
        form: 'instructions',
        baseline: true,
        policy: { root: 'off', file: null, global: false, nested: false },
        projectRoot: 'C:/contract',
        changes: [{ action: 'set', scope: 'AGENTS.md', path: 'AGENTS.md', digest: 'd' }],
      },
    }, { surfaceOp: 'append' })
    const value = ctx.sessionProjections.snapshot(session).values.instructionsPolicy
    assert.equal(value.policy.root, 'off')
    assert.equal(value.policy.nested, false)
    assert.equal(value.projectRoot, 'C:/contract')
    assert.deepEqual(value.loaded, ['AGENTS.md'])
    assert.equal(value.lastCommand.kind, 'success')
  } finally {
    await handle.dispose()
  }
})

test('the installed renderer reports a zero-byte truncation as dropped', (t) => {
  const official = installed('@deepseek-ai/dsh-agent-instructions')
  if (official === undefined || typeof official.renderAgentInstructions !== 'function') {
    t.skip('no DSH installation found')
    return
  }
  const rendered = renderBaseline([{
    absolutePath: join(tmpdir(), 'AGENTS.md'),
    displayPath: 'AGENTS.md',
    content: 'A'.repeat(5000),
    digest: 'd',
    bytes: 5000,
    chain: 'project',
  }], 200, false, official)
  assert.ok(rendered !== undefined)
  assert.match(rendered.text, /truncated AGENTS\.md from 5000 to 0 bytes/)
  assert.deepEqual(rendered.included, [])
})

test('the installed locale plugin still names the preference field', (t) => {
  const locale = installed('@deepseek-ai/dsh-client-locale')
  if (locale === undefined) {
    t.skip('no DSH installation found')
    return
  }
  // `locale: auto` reads the DSH language preference from this exact field on
  // the locale row's live config, so a rename must fail here instead of
  // silently falling back to the system language.
  assert.equal(locale.LOCALE_PREFERENCE_FIELD, 'preference')
  assert.ok(locale.Config.dict.preference, 'the locale Config schema lost the preference field')
})

test('the installed config editor still lists profile rows', (t) => {
  const editor = installed('@deepseek-ai/dsh-config-editor')
  if (editor === undefined || typeof editor.ConfigEditor !== 'function') {
    t.skip('no DSH installation found')
    return
  }
  // `auto` resolves the locale row through this service; a renamed or removed
  // listing means the language preference can no longer be followed.
  assert.equal(typeof editor.ConfigEditor.prototype.entries, 'function')
})
