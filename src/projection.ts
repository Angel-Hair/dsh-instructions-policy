/**
 * Client-facing policy projection for the instruction chip.
 *
 * A session projection is a host-computed, replayable view of committed session
 * events. The chip reads it through the `useProjection` standard seat instead of
 * folding the browser's event window itself: policy, lock state, the last
 * `/instructions` outcome, the project root, and the visible instruction files
 * all come from one authoritative host value. Compaction and history paging
 * therefore cannot leave the chip guessing.
 *
 * The projection is derived state only. Policy still comes from the declared
 * `command/run` + `command/done` lifecycle, and instruction files still come
 * from the declared `agent-instructions` messages, so the model-visible log
 * stays the sole source of truth.
 *
 * @module dsh-instructions-policy/projection
 */

import { mergePolicyConfig, resolveConfig, type Policy, type RawConfig } from './config.ts'
import { applyInstructionsArgs, INSTRUCTIONS_COMMAND } from './policy.ts'
import type {
  LoaderLike,
  PluginContext,
  ProjectionDefinitionLike,
  ProjectionHandleLike,
  ProjectionSchemaLike,
  ProjectionServiceLike,
  SessionEvent,
} from './types.ts'

/** Projection key read by the Web chip. */
export const POLICY_PROJECTION_KEY = 'instructionsPolicy'

/** Name of the shipped instruction row inside a preset. */
const UPSTREAM = '@deepseek-ai/dsh-agent-instructions'

/** One instruction scope visible to the model. */
interface LoadedScope {
  scope: string
  path: string
}

/** One pending command lifecycle waiting for its `command/done`. */
interface PendingCommand {
  commandId: string
  args: string | null
}

/** The latest settled `/instructions` invocation. */
export interface ProjectionLastCommand {
  commandId: string
  args: string | null
  kind: 'success' | 'error'
  text: string
  seq: number
}

/** Public value consumed by the chip. */
export interface PolicyProjectionView {
  policy: Policy
  locked: boolean
  lastCommand: ProjectionLastCommand | null
  projectRoot: string | undefined
  /** Model-facing paths, in load order. */
  loaded: string[]
}

/** Host state folded over the complete session log. */
export interface PolicyProjectionState {
  policy: Policy
  locked: boolean
  lastCommand: ProjectionLastCommand | null
  projectRoot: string | undefined
  loaded: LoadedScope[]
  baselineScopes: string[]
  pending: PendingCommand[]
  /** Stable client view; carries the same reference while only hidden fields change. */
  visible: PolicyProjectionView
}

/** Options needed to register the host projection. */
export interface ProjectionOptions {
  hostConfig: RawConfig | undefined
  loader: LoaderLike | undefined
  /** Diagnostics for an unusable preset-row policy override. */
  warn?: (...args: unknown[]) => void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isRootMode(value: unknown): value is Policy['root'] {
  return value === 'default' || value === 'custom' || value === 'off'
}

/** Normalize one policy snapshot from an instruction message or a projection cache. */
function policyOf(value: unknown): Policy | undefined {
  if (!isRecord(value) || !isRootMode(value['root'])) return undefined
  const file = value['file']
  if (file !== null && typeof file !== 'string') return undefined
  if (typeof value['global'] !== 'boolean' || typeof value['nested'] !== 'boolean') return undefined
  return { root: value['root'], file, global: value['global'], nested: value['nested'] }
}

function clonePolicy(policy: Policy): Policy {
  return { root: policy.root, file: policy.file, global: policy.global, nested: policy.nested }
}

function samePolicy(left: Policy, right: Policy): boolean {
  return left.root === right.root
    && left.file === right.file
    && left.global === right.global
    && left.nested === right.nested
}

function sameLoaded(left: readonly LoadedScope[], right: readonly LoadedScope[]): boolean {
  if (left.length !== right.length) return false
  return left.every((entry, index) => {
    const other = right[index]
    return other !== undefined && entry.scope === other.scope && entry.path === other.path
  })
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function visibleOf(state: Omit<PolicyProjectionState, 'visible'>): PolicyProjectionView {
  return {
    policy: clonePolicy(state.policy),
    locked: state.locked,
    lastCommand: state.lastCommand === null ? null : { ...state.lastCommand },
    projectRoot: state.projectRoot,
    loaded: state.loaded.map(entry => entry.path),
  }
}

/** Build one state with a fresh visible value. */
function stateWithVisible(
  state: PolicyProjectionState,
  patch: Partial<Omit<PolicyProjectionState, 'visible'>>,
): PolicyProjectionState {
  const next = { ...state, ...patch }
  return { ...next, visible: visibleOf(next) }
}

/** Initial projection state for one Session. */
export function createProjectionState(policy: Policy): PolicyProjectionState {
  const base = {
    policy: clonePolicy(policy),
    locked: false,
    lastCommand: null,
    projectRoot: undefined,
    loaded: [] as LoadedScope[],
    baselineScopes: [] as string[],
    pending: [] as PendingCommand[],
  }
  return { ...base, visible: visibleOf(base) }
}

function instructionSource(data: unknown): Record<string, unknown> | undefined {
  if (!isRecord(data)) return undefined
  const source = data['source']
  if (!isRecord(source) || source['kind'] !== 'agent-instructions') return undefined
  return source
}

function lastCommandOf(value: unknown): ProjectionLastCommand | null | undefined {
  if (value === null || value === undefined) return null
  if (!isRecord(value)) return undefined
  const commandId = value['commandId']
  const args = value['args']
  const kind = value['kind']
  const text = value['text']
  const seq = value['seq']
  if (typeof commandId !== 'string' || (args !== null && typeof args !== 'string')) return undefined
  if (kind !== 'success' && kind !== 'error') return undefined
  if (typeof text !== 'string' || typeof seq !== 'number') return undefined
  return { commandId, args, kind, text, seq }
}

function pendingOf(value: unknown): PendingCommand[] | undefined {
  if (!Array.isArray(value)) return undefined
  const entries: PendingCommand[] = []
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry['commandId'] !== 'string') return undefined
    const args = entry['args']
    if (args !== null && typeof args !== 'string') return undefined
    entries.push({ commandId: entry['commandId'], args })
  }
  return entries
}

function loadedOf(value: unknown): LoadedScope[] | undefined {
  if (!Array.isArray(value)) return undefined
  const entries: LoadedScope[] = []
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry['scope'] !== 'string' || typeof entry['path'] !== 'string') {
      return undefined
    }
    entries.push({ scope: entry['scope'], path: entry['path'] })
  }
  return entries
}

function stringsOf(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) return undefined
  return value as string[]
}

/** Validate cached projection state and rebuild its client view. */
export function parseProjectionState(value: unknown): PolicyProjectionState {
  if (!isRecord(value)) throw new Error('instructionsPolicy state must be an object')
  const policy = policyOf(value['policy'])
  if (policy === undefined) throw new Error('instructionsPolicy state has an invalid policy')
  if (typeof value['locked'] !== 'boolean') throw new Error('instructionsPolicy state has an invalid lock')
  const lastCommand = lastCommandOf(value['lastCommand'])
  if (lastCommand === undefined) throw new Error('instructionsPolicy state has an invalid lastCommand')
  const projectRoot = value['projectRoot']
  if (projectRoot !== undefined && typeof projectRoot !== 'string') {
    throw new Error('instructionsPolicy state has an invalid projectRoot')
  }
  const loaded = loadedOf(value['loaded'])
  if (loaded === undefined) throw new Error('instructionsPolicy state has invalid instruction files')
  const baselineScopes = stringsOf(value['baselineScopes'])
  if (baselineScopes === undefined) throw new Error('instructionsPolicy state has invalid baseline scopes')
  const pending = pendingOf(value['pending'])
  if (pending === undefined) throw new Error('instructionsPolicy state has invalid pending commands')
  const base = {
    policy,
    locked: value['locked'],
    lastCommand,
    projectRoot,
    loaded,
    baselineScopes,
    pending,
  }
  return { ...base, visible: visibleOf(base) }
}

/** Validate the wire value before it leaves the host. */
function parseProjectionView(value: unknown): PolicyProjectionView {
  if (!isRecord(value)) throw new Error('instructionsPolicy view must be an object')
  const policy = policyOf(value['policy'])
  if (policy === undefined) throw new Error('instructionsPolicy view has an invalid policy')
  if (typeof value['locked'] !== 'boolean') throw new Error('instructionsPolicy view has an invalid lock')
  const lastCommand = lastCommandOf(value['lastCommand'])
  if (lastCommand === undefined) throw new Error('instructionsPolicy view has an invalid lastCommand')
  const projectRoot = value['projectRoot']
  if (projectRoot !== undefined && typeof projectRoot !== 'string') {
    throw new Error('instructionsPolicy view has an invalid projectRoot')
  }
  const loaded = stringsOf(value['loaded'])
  if (loaded === undefined) throw new Error('instructionsPolicy view has invalid files')
  return { policy, locked: value['locked'], lastCommand, projectRoot, loaded }
}

const stateSchema: ProjectionSchemaLike<unknown> = {
  parse: parseProjectionState,
}

const viewSchema: ProjectionSchemaLike<unknown> = {
  parse: parseProjectionView,
}

/**
 * Fold one committed event into policy projection state.
 *
 * Events that do not touch policy, the lock, the latest command, or the visible
 * instruction set return the same state reference, so the projection drive does
 * no downstream view work.
 * @param state - state covering all previous events.
 * @param event - next committed session event.
 * @returns the next state, or the same reference when the event is unrelated.
 */
export function applyProjectionEvent(state: PolicyProjectionState, event: SessionEvent): PolicyProjectionState {
  const data = isRecord(event.data) ? event.data : undefined

  switch (event.type) {
    case 'command/run': {
      if (data === undefined || data['name'] !== INSTRUCTIONS_COMMAND || typeof data['commandId'] !== 'string') {
        return state
      }
      const commandId = data['commandId']
      const args = typeof data['args'] === 'string' ? data['args'] : null
      const pending = state.pending.filter(entry => entry.commandId !== commandId)
      return { ...state, pending: [...pending, { commandId, args }] }
    }

    case 'command/done': {
      if (data === undefined || typeof data['commandId'] !== 'string') return state
      const kind = data['kind']
      if (kind !== 'success' && kind !== 'error') return state
      const commandId = data['commandId']
      const index = state.pending.findIndex(entry => entry.commandId === commandId)
      if (index < 0) return state
      const pendingEntry = state.pending[index]
      if (pendingEntry === undefined) return state
      const policy = kind === 'success'
        ? applyInstructionsArgs(state.policy, pendingEntry.args ?? undefined) ?? state.policy
        : state.policy
      const lastCommand: ProjectionLastCommand = {
        commandId,
        args: pendingEntry.args,
        kind,
        text: typeof data['text'] === 'string' ? data['text'] : '',
        seq: event.seq,
      }
      return stateWithVisible(state, {
        policy,
        pending: state.pending.toSpliced(index, 1),
        lastCommand,
      })
    }

    case 'turn/start':
    case 'step/start':
      return state.locked ? state : stateWithVisible(state, { locked: true })

    case 'user/message': {
      const source = instructionSource(event.data)
      if (source === undefined) return state

      let policy = state.policy
      let policyChanged = false
      const snapshot = policyOf(source['policy'])
      if (snapshot !== undefined && !samePolicy(snapshot, policy)) {
        policy = snapshot
        policyChanged = true
      }

      let projectRoot = state.projectRoot
      const projectRootValue = source['projectRoot']
      if (typeof projectRootValue === 'string' && projectRootValue !== projectRoot) {
        projectRoot = projectRootValue
      }

      let loaded = state.loaded
      let baselineScopes = state.baselineScopes
      let loadedChanged = false
      let baselineChanged = false
      const changes = Array.isArray(source['changes']) ? source['changes'] : []
      const baseline = source['baseline'] === true
      const nextBaseline = baseline ? new Set<string>() : undefined

      for (const change of changes) {
        if (!isRecord(change)) continue
        const action = change['action']
        const scope = change['scope']
        const path = change['path']
        if (typeof scope !== 'string' || typeof path !== 'string') continue
        if (action === 'remove') {
          const remaining = loaded.filter(entry => entry.scope !== scope)
          if (remaining.length !== loaded.length) {
            loaded = remaining
            loadedChanged = true
          }
          if (baselineScopes.includes(scope)) {
            baselineScopes = baselineScopes.filter(value => value !== scope)
            baselineChanged = true
          }
          continue
        }
        if (action !== 'set' && action !== 'replace') continue
        nextBaseline?.add(scope)
        const index = loaded.findIndex(entry => entry.scope === scope)
        if (index < 0) {
          loaded = [...loaded, { scope, path }]
          loadedChanged = true
        } else if (loaded[index]?.path !== path) {
          const next = loaded.slice()
          next[index] = { scope, path }
          loaded = next
          loadedChanged = true
        }
      }

      if (baseline) {
        const previous = state.baselineScopes
        const next = [...(nextBaseline ?? [])]
        const survivors = loaded.filter(entry => !previous.includes(entry.scope) || next.includes(entry.scope))
        if (survivors.length !== loaded.length) {
          loaded = survivors
          loadedChanged = true
        }
        if (!sameStrings(next, previous)) {
          baselineScopes = next
          baselineChanged = true
        }
      }

      if (!policyChanged && !loadedChanged && projectRoot === state.projectRoot) {
        return baselineChanged ? { ...state, baselineScopes } : state
      }
      return stateWithVisible(state, { policy, projectRoot, loaded, baselineScopes })
    }

    case 'compaction/end': {
      if (data !== undefined && data['error'] !== undefined) return state
      if (state.loaded.length === 0 && state.baselineScopes.length === 0) return state
      return stateWithVisible(state, { loaded: [], baselineScopes: [] })
    }

    default:
      return state
  }
}

/** Resolve the policy defaults of the preset that owns one Session. */
function defaultsResolver(options: ProjectionOptions, hostPolicy: Policy): (header: unknown) => Policy {
  const cache = new Map<string, Policy>()
  return (header) => {
    const agentPreset = isRecord(header) ? header['agentPreset'] : undefined
    if (typeof agentPreset !== 'string') return hostPolicy
    const cached = cache.get(agentPreset)
    if (cached !== undefined) return cached

    let policy = hostPolicy
    try {
      const entries = options.loader?.entries?.() ?? []
      const preset = entries.find((entry) => {
        const config = entry.options.config
        return isRecord(config) && config['id'] === agentPreset && Array.isArray(config['plugins'])
      })
      const config = preset?.options.config
      const plugins = isRecord(config) ? config['plugins'] : undefined
      const row = Array.isArray(plugins)
        ? plugins.find(candidate => isRecord(candidate) && candidate['name'] === UPSTREAM)
        : undefined
      if (isRecord(row)) {
        const rowConfig = isRecord(row['config']) ? row['config'] as RawConfig : undefined
        policy = resolveConfig(mergePolicyConfig(options.hostConfig, rowConfig)).policy
      }
    } catch (error) {
      options.warn?.('instructions-policy: preset policy defaults are unavailable: %o', error)
    }
    cache.set(agentPreset, policy)
    return policy
  }
}

/**
 * Create the projection definition registered by the host row.
 * @param options - host row config and the Loader entry listing used to resolve
 *   one preset's own policy defaults.
 * @returns the definition consumed by `ctx.sessionProjections.register`.
 */
export function createPolicyProjectionDefinition(options: ProjectionOptions): ProjectionDefinitionLike {
  const hostPolicy = resolveConfig(options.hostConfig).policy
  const defaultsFor = defaultsResolver(options, hostPolicy)
  return {
    key: POLICY_PROJECTION_KEY,
    stateSchema,
    init: header => createProjectionState(defaultsFor(header)),
    apply: (state, event) => applyProjectionEvent(state as PolicyProjectionState, event),
    wire: {
      viewSchema,
      view: state => (state as PolicyProjectionState).visible,
      summary: false,
    },
    stateVersion: 1,
  }
}

/**
 * Register the projection on the host and dispose it with the plugin fiber.
 *
 * The registry registration is asynchronous. Disposal can arrive before the
 * handle resolves, so the late handle is released in that case.
 * @param ctx - host plugin context.
 * @param service - the session projection registry, when the profile provides it.
 * @param options - host row config and Loader listing.
 */
export function installPolicyProjection(
  ctx: PluginContext,
  service: ProjectionServiceLike | undefined,
  options: ProjectionOptions,
): void {
  if (service === undefined) {
    ctx.logger.warn('instructions-policy: session projection service unavailable; the Web chip cannot read policy')
    return
  }
  let disposed = false
  let handle: ProjectionHandleLike | undefined
  let registration: Promise<ProjectionHandleLike>
  try {
    registration = service.register(createPolicyProjectionDefinition(options))
  } catch (error) {
    ctx.logger.warn('instructions-policy: cannot register the policy projection: %o', error)
    return
  }
  void registration.then(
    (resolved) => {
      if (disposed) {
        void resolved.dispose()
        return
      }
      handle = resolved
    },
    (error: unknown) => {
      if (!disposed) ctx.logger.warn('instructions-policy: policy projection registration failed: %o', error)
    },
  )
  ctx.effect?.(() => () => {
    disposed = true
    if (handle !== undefined) void handle.dispose()
  })
}
