/**
 * Rebuild the instruction state of one session from its JSONL log.
 *
 * The session log is the same durable source the policy loader folds: a
 * `user/message` with `source.kind === "agent-instructions"` lists the scopes
 * it rendered, and `surfaceOp` says whether the event is still on the model's
 * surface. Replaying those operations keeps this checker honest after
 * compaction instead of treating every instruction message ever logged as
 * currently active.
 *
 * Usage:
 *   node verify-state.mjs                    newest session matching this cwd
 *   node verify-state.mjs --expect A         assert the final state of scenario A
 *   node verify-state.mjs --json             machine-readable result
 *   node verify-state.mjs --list             list recent sessions
 *   node verify-state.mjs <file.jsonl[.zstd]>
 *   node verify-state.mjs <path-substring>
 *
 * The script reads only `~/.dsh/sessions` (or `$DSH_HOME/sessions`) and never
 * writes, uploads, or reads plugin source.
 */

import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import zlib from 'node:zlib'

const zstdDecompressSync = zlib.zstdDecompressSync

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const MARKER_RE = /[A-Z][A-Z0-9_]*_MARKER_\d+/g

/**
 * Final-state expectations after the VERIFY prompt has read `deep/note.txt`.
 * `files` is the exact visible set; `forbidden` markers must not appear in the
 * newest instruction batch.
 */
const SCENARIOS = {
  A: {
    root: 'default', file: null, global: true,
    files: ['AGENTS.md', 'CLAUDE.md', 'sub/AGENTS.md', 'sub/deep/AGENTS.md'],
    forbidden: [],
  },
  B: {
    root: 'off', file: null, global: true,
    files: ['sub/AGENTS.md', 'sub/deep/AGENTS.md'],
    forbidden: ['ROOT_MARKER_111', 'CLAUDE_MARKER_555'],
  },
  C: {
    root: 'custom', file: 'CUSTOM_ROOT.md', global: true,
    files: ['CUSTOM_ROOT.md', 'sub/AGENTS.md', 'sub/deep/AGENTS.md'],
    forbidden: ['ROOT_MARKER_111', 'CLAUDE_MARKER_555'],
  },
  D: {
    root: 'default', file: null, global: true,
    files: ['AGENTS.md', 'CLAUDE.md', 'sub/AGENTS.md'],
    forbidden: ['DEEP_MARKER_333'],
  },
  E: {
    root: 'default', file: null, global: false,
    files: ['AGENTS.md', 'CLAUDE.md', 'sub/AGENTS.md', 'sub/deep/AGENTS.md'],
    forbidden: ['GLOBAL_MARKER_999'],
  },
  F: {
    root: 'off', file: null, global: true,
    files: ['sub/AGENTS.md', 'sub/deep/AGENTS.md'],
    forbidden: ['ROOT_MARKER_111', 'CLAUDE_MARKER_555'],
  },
}

function usage() {
  console.log(`Usage: node verify-state.mjs [options] [session-file|path-substring]

  --expect A|B|C|D|E|F   assert the final state of one scenario (exit 2 on mismatch)
  --json                 print one JSON object
  --list                 list recent sessions and their cwd
  --session <file>       read one explicit session log
  --match <substring>    only consider session paths containing the substring
  --cwd <path>           select a session by cwd (default: this process cwd)
  --any                  skip cwd matching and take the newest session
  --help                 show this help`)
}

function parseArgs(argv) {
  const options = {
    json: false,
    expect: undefined,
    list: false,
    session: undefined,
    match: undefined,
    cwd: undefined,
    any: false,
    help: false,
  }
  const positional = []
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--json') options.json = true
    else if (argument === '--list') options.list = true
    else if (argument === '--any') options.any = true
    else if (argument === '--help' || argument === '-h') options.help = true
    else if (argument === '--expect') {
      options.expect = argv[index += 1]
      if (options.expect === undefined) throw new Error('--expect requires a scenario letter')
    } else if (argument.startsWith('--expect=')) {
      options.expect = argument.slice('--expect='.length)
    } else if (argument === '--session') {
      options.session = argv[index += 1]
      if (options.session === undefined) throw new Error('--session requires a file')
    } else if (argument.startsWith('--session=')) {
      options.session = argument.slice('--session='.length)
    } else if (argument === '--match') {
      options.match = argv[index += 1]
      if (options.match === undefined) throw new Error('--match requires a substring')
    } else if (argument.startsWith('--match=')) {
      options.match = argument.slice('--match='.length)
    } else if (argument === '--cwd') {
      options.cwd = argv[index += 1]
      if (options.cwd === undefined) throw new Error('--cwd requires a path')
    } else if (argument.startsWith('--cwd=')) {
      options.cwd = argument.slice('--cwd='.length)
    } else if (argument.startsWith('-')) {
      throw new Error(`unknown option: ${argument}`)
    } else {
      positional.push(argument)
    }
  }
  if (positional.length > 0) {
    const first = positional[0]
    if (first.endsWith('.jsonl') || first.endsWith('.jsonl.zstd')) options.session = first
    else options.match = first
  }
  return options
}

/** Decode one session log; `.zstd` logs are concatenated frames. */
function decode(file) {
  const buffer = readFileSync(file)
  if (!file.endsWith('.zstd')) return buffer.toString('utf8')
  if (typeof zstdDecompressSync !== 'function') {
    throw new Error(`Node ${process.version} has no zlib.zstdDecompressSync; use Node >= 22.15 (DSH 0.2.2 requires >= 24.9)`)
  }
  const cuts = []
  let index = -1
  while ((index = buffer.indexOf(ZSTD_MAGIC, index + 1)) !== -1) cuts.push(index)
  if (cuts.length === 0) throw new Error(`not a zstd frame stream: ${file}`)
  const parts = []
  for (let cursor = 0; cursor < cuts.length; cursor += 1) {
    const end = cursor + 1 < cuts.length ? cuts[cursor + 1] : buffer.length
    try {
      parts.push(zstdDecompressSync(buffer.subarray(cuts[cursor], end)).toString('utf8'))
    } catch {
      // A magic-like byte sequence inside a frame or a partial trailing frame:
      // the remaining frames still carry the events the checker needs.
    }
  }
  return parts.join('\n')
}

function eventsOf(file) {
  const events = []
  for (const line of decode(file).split('\n')) {
    if (!line.trim()) continue
    try {
      events.push(JSON.parse(line))
    } catch {
      // A partial trailing line is not an event.
    }
  }
  if (events.length === 0) throw new Error(`no events: ${file}`)
  return events
}

function sessionCwd(events) {
  const header = events.find(event => event.type === 'session')
  if (header !== undefined && typeof header.cwd === 'string') return header.cwd
  const data = header?.data
  return data !== undefined && typeof data.cwd === 'string' ? data.cwd : undefined
}

function samePath(left, right) {
  const normalize = (value) => {
    let absolute
    try {
      absolute = realpathSync.native(resolve(value))
    } catch {
      absolute = resolve(value)
    }
    return process.platform === 'win32' ? absolute.toLowerCase() : absolute
  }
  return normalize(left) === normalize(right)
}

function sessionsRoot() {
  const configured = process.env.DSH_HOME?.trim()
  return join(configured !== undefined && configured.length > 0 ? resolve(configured) : join(homedir(), '.dsh'), 'sessions')
}

function walk(directory, out) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) walk(path, out)
    else if (entry.name.endsWith('.jsonl') || entry.name.endsWith('.jsonl.zstd')) out.push(path)
  }
}

function sessionFiles() {
  const root = sessionsRoot()
  if (!existsSync(root)) throw new Error(`no session directory: ${root} (set DSH_HOME if needed)`)
  const files = []
  walk(root, files)
  files.sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)
  return files
}

function loadSession(file) {
  const events = eventsOf(file)
  return { file, events, cwd: sessionCwd(events) }
}

function selectSession(options) {
  if (options.session !== undefined) {
    const file = resolve(options.session)
    if (!existsSync(file)) throw new Error(`session file not found: ${file}`)
    return loadSession(file)
  }

  let files = sessionFiles()
  if (options.match !== undefined) {
    files = files.filter(file => file.includes(options.match))
    if (files.length === 0) throw new Error(`no session path contains ${JSON.stringify(options.match)}`)
  }
  if (options.list) {
    if (files.length === 0) {
      console.log('(no sessions)')
      return undefined
    }
    for (const file of files.slice(0, 20)) {
      try {
        const session = loadSession(file)
        console.log(`${new Date(statSync(file).mtimeMs).toISOString()}  ${session.cwd ?? '(unknown cwd)'}  ${file}`)
      } catch (error) {
        console.log(`(unreadable)  ${file}  ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return undefined
  }
  if (files.length === 0) throw new Error(`no session logs under ${sessionsRoot()}`)
  if (options.any) return loadSession(files[0])

  const target = resolve(options.cwd ?? process.cwd())
  for (const file of files) {
    try {
      const session = loadSession(file)
      if (session.cwd !== undefined && samePath(session.cwd, target)) return session
    } catch {
      // Skip unreadable logs while looking for the workspace's newest session.
    }
  }
  const newest = loadSession(files[0])
  console.error(`verify-state: no session for ${target}; using newest ${files[0]}`)
  return newest
}

/**
 * Replay surface operations. `append` pushes an event; a replace operation
 * swaps the inclusive range with the replacement event, mirroring the Session
 * surface. Both released field spellings are accepted (`start/end` and
 * `startSeq/endSeq`).
 */
function replaySurface(events) {
  const surface = []
  const warnings = []
  let replacements = 0
  for (const event of events) {
    const operation = event.surfaceOp
    if (operation === 'append') {
      surface.push(event.seq)
      continue
    }
    if (operation === undefined || operation === null) continue
    if (typeof operation !== 'object') {
      warnings.push(`ignored surfaceOp ${JSON.stringify(operation)} at seq ${event.seq}`)
      continue
    }
    const start = Number.isInteger(operation.startSeq) ? operation.startSeq : operation.start
    const end = Number.isInteger(operation.endSeq) ? operation.endSeq : operation.end
    if (!Number.isInteger(start) || !Number.isInteger(end)) {
      warnings.push(`ignored malformed replacement at seq ${event.seq}`)
      continue
    }
    const at = surface.indexOf(start)
    const to = surface.indexOf(end)
    if (at < 0 || to < at) {
      // A log that starts after the replaced range (or a migration artifact):
      // keep the report useful by removing what is present and appending the
      // replacement, and surface the approximation as a warning.
      const low = Math.min(start, end)
      const high = Math.max(start, end)
      const kept = surface.filter(seq => seq < low || seq > high)
      kept.push(event.seq)
      surface.splice(0, surface.length, ...kept)
      warnings.push(`replacement ${start}-${end} at seq ${event.seq} was not fully on the surface`)
    } else {
      surface.splice(at, to - at + 1, event.seq)
    }
    replacements += 1
  }
  return { surface, replacements, warnings }
}

function markersOf(text) {
  return [...new Set(text.match(MARKER_RE) ?? [])]
}

/** Map each rendered `Instructions from: path` section to its markers. */
function sectionMarkers(text) {
  const map = new Map()
  const heading = /^(?:Instructions from|Additional instructions from|Updated instructions from): (.+)$/gm
  const matches = [...text.matchAll(heading)]
  for (let index = 0; index < matches.length; index += 1) {
    const start = matches[index].index + matches[index][0].length
    const end = index + 1 < matches.length ? matches[index + 1].index : text.length
    map.set(matches[index][1].trim(), markersOf(text.slice(start, end)))
  }
  return map
}

function policyOf(value) {
  if (typeof value !== 'object' || value === null) return undefined
  const root = value.root
  const file = value.file
  if (root !== 'default' && root !== 'custom' && root !== 'off') return undefined
  if (file !== null && typeof file !== 'string') return undefined
  if (typeof value.global !== 'boolean') return undefined
  return { root, file, global: value.global }
}

function baselinePolicy(identity, sourcePolicy) {
  const direct = policyOf(sourcePolicy)
  if (direct !== undefined) return direct
  if (typeof identity !== 'string' || identity === '(none)') return undefined
  try {
    return policyOf(JSON.parse(identity).policy)
  } catch {
    return undefined
  }
}

/** A custom root may be stored relative or absolute (the chip picks absolute). */
function sameConfiguredFile(actual, expected) {
  if (actual === expected) return true
  if (expected === 'CUSTOM_ROOT.md' && typeof actual === 'string') {
    return actual.replaceAll('\\', '/').endsWith('/CUSTOM_ROOT.md')
  }
  return false
}

function fold(events, seqs) {
  const bySeq = new Map(events.map(event => [event.seq, event]))
  const active = new Map()
  const removed = new Set()
  let baselineIdentity
  let policy
  let batches = 0
  let lastContent = ''
  const sections = new Map()
  for (const seq of seqs) {
    const event = bySeq.get(seq)
    if (event === undefined || event.type !== 'user/message') continue
    const data = event.data ?? {}
    const source = data.source
    if (typeof source !== 'object' || source === null || source.kind !== 'agent-instructions') continue
    batches += 1
    if (source.baseline === true) {
      baselineIdentity = typeof source.baselineIdentity === 'string' ? source.baselineIdentity : '(none)'
      policy = policyOf(source.policy)
    }
    for (const change of Array.isArray(source.changes) ? source.changes : []) {
      if (typeof change !== 'object' || change === null) continue
      if (typeof change.scope !== 'string' || typeof change.path !== 'string') continue
      if (change.action === 'remove') {
        active.delete(change.scope)
        removed.add(change.path)
      } else {
        active.set(change.scope, change.path)
      }
    }
    const blocks = Array.isArray(data.content) ? data.content : []
    lastContent = blocks.map(block => (typeof block?.text === 'string' ? block.text : '')).join('\n')
    for (const [path, markers] of sectionMarkers(lastContent)) {
      const existing = sections.get(path)
      if (existing === undefined) {
        sections.set(path, markers)
      } else {
        for (const marker of markers) {
          if (!existing.includes(marker)) existing.push(marker)
        }
      }
    }
  }
  return { active, removed, baselineIdentity, policy, batches, lastContent, sections }
}

function resultOf(session) {
  const surface = replaySurface(session.events)
  const visible = fold(session.events, surface.surface)
  const logged = fold(session.events, session.events.filter(event => event.type === 'user/message').map(event => event.seq))
  const visiblePaths = new Set(visible.active.values())
  const hidden = [...logged.active.values()].filter(path => !visiblePaths.has(path)).sort()
  const lastMarkers = markersOf(visible.lastContent)
  const visibleMarkers = new Map()
  for (const path of [...visible.active.values()].sort()) {
    visibleMarkers.set(path, visible.sections.get(path) ?? [])
  }
  return {
    session: session.file,
    cwd: session.cwd,
    surfaceNodes: surface.surface.length,
    surfaceReplacements: surface.replacements,
    warnings: surface.warnings,
    instructionBatches: visible.batches,
    baseline: visible.baselineIdentity,
    policy: visible.policy ?? baselinePolicy(visible.baselineIdentity, visible.policy),
    visible: [...visible.active.values()].sort(),
    visibleMarkers: Object.fromEntries(visibleMarkers),
    hidden,
    removed: [...visible.removed].sort(),
    lastMarkers,
    lastText: visible.lastContent,
  }
}

function checkExpectation(result, letter) {
  const scenario = SCENARIOS[letter]
  const failures = []
  if (scenario === undefined) {
    return { scenario: letter, pass: false, failures: [`unknown scenario ${letter}`] }
  }
  if (result.policy === undefined || result.policy === null) {
    failures.push('no baseline policy in the session log')
  } else {
    if (result.policy.root !== scenario.root) failures.push(`root: expected ${scenario.root}, got ${result.policy.root}`)
    if (!sameConfiguredFile(result.policy.file, scenario.file)) {
      failures.push(`file: expected ${scenario.file}, got ${result.policy.file}`)
    }
    if (result.policy.global !== scenario.global) failures.push(`global: expected ${scenario.global}, got ${result.policy.global}`)
  }
  const actual = new Set(result.visible)
  for (const path of scenario.files) {
    if (!actual.has(path)) failures.push(`missing visible file: ${path}`)
  }
  for (const path of actual) {
    if (!scenario.files.includes(path)) failures.push(`unexpected visible file: ${path}`)
  }
  for (const marker of scenario.forbidden) {
    if (result.lastMarkers.includes(marker)) failures.push(`forbidden marker in last batch: ${marker}`)
  }
  return { scenario: letter, pass: failures.length === 0, failures }
}

function printHuman(result, expected) {
  console.log(`session: ${result.session}`)
  console.log(`cwd: ${result.cwd ?? '(unknown)'}`)
  console.log(`instruction batches: ${result.instructionBatches}`)
  console.log(`surface: ${result.surfaceNodes} nodes, ${result.surfaceReplacements} replacement(s)`)
  console.log(`baseline: ${result.baseline ?? '(none)'}`)
  console.log(`visible instruction files (${result.visible.length}):`)
  for (const path of result.visible) {
    const markers = result.visibleMarkers[path] ?? []
    console.log(`  ${path}${markers.length > 0 ? `  [${markers.join(', ')}]` : ''}`)
  }
  if (result.hidden.length > 0) {
    console.log(`not on current surface (${result.hidden.length}):`)
    for (const path of result.hidden) console.log(`  ${path}`)
  }
  console.log(`removed (${result.removed.length}):`)
  for (const path of result.removed) console.log(`  ${path}`)
  console.log(`last batch markers: ${result.lastMarkers.length > 0 ? result.lastMarkers.join(', ') : '(none)'}`)
  for (const warning of result.warnings) console.error(`warning: ${warning}`)
  if (expected !== undefined) {
    console.log(`expect ${expected.scenario}: ${expected.pass ? 'PASS' : 'FAIL'}`)
    for (const failure of expected.failures) console.log(`  - ${failure}`)
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    usage()
    return
  }
  if (options.expect !== undefined) {
    const letter = options.expect.toUpperCase()
    if (SCENARIOS[letter] === undefined) {
      usage()
      throw new Error(`unknown scenario: ${options.expect}`)
    }
    options.expect = letter
  }
  const session = selectSession(options)
  if (session === undefined) return

  const result = resultOf(session)
  const expected = options.expect === undefined ? undefined : checkExpectation(result, options.expect)
  if (options.json) {
    console.log(JSON.stringify({ ...result, expect: expected }, null, 2))
  } else {
    printHuman(result, expected)
  }
  if (expected !== undefined && !expected.pass) process.exitCode = 2
}

try {
  main()
} catch (error) {
  console.error(`verify-state: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
