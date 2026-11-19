/**
 * Structural interfaces for the parts of the DeepSeek Harness runtime this
 * plugin touches.
 *
 * The plugin ships without runtime dependencies, so it cannot import the
 * harness packages for types. Every interface here is narrower than the real
 * contract on purpose: it names only what this plugin reads or calls.
 *
 * @module dsh-instructions-policy/types
 */

/** One text block of a user message. */
export interface TextBlock {
  readonly type: 'text'
  readonly text: string
}

/** A model-visible user message. */
export interface UserMessage {
  readonly id: string
  readonly role: 'user'
  readonly content: readonly TextBlock[]
  readonly source: Readonly<Record<string, unknown>>
}

/** One durable session event. */
export interface SessionEvent {
  readonly seq: number
  readonly type: string
  readonly data: unknown
}

/** The session surface this plugin reads to recover what was already loaded. */
export interface Session {
  readonly surface: {
    /** Model-visible event sequences, in order. */
    readonly nodes: readonly number[]
    /** Bumped when a surface region is positionally replaced (compaction); absent on older runtimes. */
    readonly replaceGeneration?: number
  }
  /** Complete event log snapshot; used to replay recorded commands. */
  snapshotEvents?(): readonly SessionEvent[]
  /** @deprecated The harness is migrating synchronous event reads to projections; this plugin only reads its own messages. */
  eventAt(seq: number): SessionEvent | undefined
  append(type: string, data: unknown): unknown
}

/** The agent whose turn is entering a step. */
export interface Agent {
  readonly session: Session
}

/** Filesystem provider resolved through `ctx.get('fs')`. */
export interface FileSystem {
  resolve(path: string, opts?: { signal?: AbortSignal }): Promise<FsTarget>
  stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined>
  streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>>
}

/** One stored file attachment reference. */
export interface FileAttachmentRefLike {
  readonly attachmentId: string
  readonly name: string
  readonly bytes: number
}

/** The host attachment store this plugin imports files from. */
export interface AttachmentStoreLike {
  readFileStream(ref: FileAttachmentRefLike, signal?: AbortSignal): AsyncIterable<Uint8Array>
}

/** Opaque provider target produced by {@link FileSystem.resolve}. */
export interface FsTarget {
  readonly __fsTarget?: never
}

/** Provider metadata for one resolved target. */
export interface FsInfo {
  readonly version: unknown
  readonly type: 'file' | 'directory' | 'other'
  readonly size?: number
}

/** Working-directory service. */
export interface WorkingDirectory {
  ensure(agent: Agent, signal?: AbortSignal): Promise<string>
}

/** A tool call observed by the `tools/result` listener. */
export interface ToolExecution {
  readonly name: string
  readonly arguments?: unknown
  readonly agent?: Agent
  readonly signal?: AbortSignal
}

/** The settled result of a tool call. */
export interface ToolExecutionResult {
  readonly isError?: boolean
}

/** The claimed messages a step enters with, plus its cancellation signal. */
export interface PreStepPayload {
  readonly agent: Agent
  readonly messages: readonly UserMessage[]
  readonly step: number
  readonly signal: AbortSignal
}

/** The decision a `agent/pre-step` listener returns. */
export type PreStepDecision =
  | { readonly kind: 'reject' }
  | { readonly kind: string; readonly messages: readonly UserMessage[] }

/** The listener signature of `agent/pre-step` (a waterfall). */
export type PreStepListener = (
  payload: PreStepPayload,
  next: () => Promise<PreStepDecision>,
) => Promise<PreStepDecision>

/** One entry-import call made by the Loader's module seam. */
export interface ModuleLoaderLike {
  import(specifier: string, parentURL: string, attributes: unknown): Promise<unknown>
}

/** One admitted entry in the composed profile tree. */
export interface LoaderEntryLike {
  readonly options: {
    readonly name: string
    readonly config?: unknown
  }
}

/** One profile row as the configuration service exposes it. */
export interface ProfileEntryLike {
  readonly options: {
    readonly id: string
    readonly name: string
    readonly config?: unknown
  }
}

/**
 * The profile configuration service, read only for another row's live config.
 *
 * This plugin uses it to follow the DSH language preference stored on the
 * shipped locale row; it never writes configuration.
 */
export interface ConfigEditorLike {
  entries?(): readonly ProfileEntryLike[]
}

/** The Loader's module seam, the only place every plugin entry is imported. */
export interface LoaderLike {
  internal: ModuleLoaderLike
  /** Composed profile rows; absent on older runtimes. */
  entries?(): readonly LoaderEntryLike[]
}

/** One admitted `/command` invocation. */
export interface CommandInvocation {
  readonly agent: Agent
  readonly rawInput: string
}

/** Human-only command outcome rendered outside model history. */
export interface CommandResult {
  readonly kind: 'success' | 'error'
  readonly text: string
}

/** The human command registry. */
export interface CommandService {
  register(definition: {
    name: string
    description: string
    /** Advertising free-form input makes the composer claim the command and accept arguments. */
    input?: { hint: string; attachments?: boolean }
    handler: (invocation: CommandInvocation) => CommandResult | Promise<CommandResult>
  }): () => void
}

/** Minimal schema surface required by the session projection registry. */
export interface ProjectionSchemaLike<T> {
  parse(value: unknown): T
}

/** One client-visible session projection definition. */
export interface ProjectionDefinitionLike {
  key: string
  stateSchema: ProjectionSchemaLike<unknown>
  init(header: unknown, inheritedEventCount: unknown): unknown
  apply(state: unknown, event: SessionEvent): unknown
  wire: {
    viewSchema: ProjectionSchemaLike<unknown>
    view(state: unknown): unknown
    summary?: boolean
  }
  stateVersion: number
}

/** The registry handle that owns one projection registration. */
export interface ProjectionHandleLike {
  dispose(): Promise<void>
}

/** The session projection registry service. */
export interface ProjectionServiceLike {
  register(definition: ProjectionDefinitionLike): Promise<ProjectionHandleLike>
}

/** The subset of the Cordis plugin context this plugin uses. */
export interface PluginContext {
  on(event: 'agent/pre-step', listener: PreStepListener): void
  on(event: 'tools/result', listener: (exec: ToolExecution, result: ToolExecutionResult) => void): void
  on(event: 'session/event', listener: (session: Session, event: SessionEvent) => void): void
  get(name: 'fs'): FileSystem | undefined
  get(name: 'workingDirectory'): WorkingDirectory | undefined
  get(name: 'loader'): LoaderLike | undefined
  get(name: 'sessionProjections'): ProjectionServiceLike | undefined
  get(name: 'commands'): CommandService | undefined
  get(name: 'attachments'): AttachmentStoreLike | undefined
  get(name: 'configEditor'): ConfigEditorLike | undefined
  /** Register a cleanup for this plugin's fiber, when the runtime exposes it. */
  effect?(callback: () => (() => void)): void
  logger: { warn(...args: unknown[]): void; info?(...args: unknown[]): void }
}
