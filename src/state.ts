/**
 * Per-session instruction state.
 *
 * The durable session log is the only source of truth for what the model sees.
 * This module keeps an incrementally folded view of it: every instruction
 * message carries the changes it produced, so replaying `surface.nodes`
 * reconstructs the visible instruction set without a projection.
 *
 * Folding is what makes compaction safe. When compaction replaces a surface
 * region, `surface.replaceGeneration` changes and the sequence list may shrink;
 * the fold is rebuilt from the remaining nodes, so a shadowed baseline looks
 * absent and the next step renders it again.
 *
 * @module dsh-instructions-policy/state
 */

import type { Policy } from './config.ts'
import type { Session, SessionEvent } from './types.ts'

/** One instruction file the model has already seen. */
export interface LoadedEntry {
  /** Model-facing path. */
  path: string
  /** Digest of the rendered content, or `''` when recovered from the log without one. */
  digest: string
}

/** Instruction files currently visible to the model, folded from the log. */
export interface VisibleInstructions {
  /** Identity of the newest visible baseline, when one exists. */
  baselineIdentity: string | undefined
  /** Scopes that the newest visible baseline owns. */
  baselineScopes: Set<string>
  /** Every instruction file the model currently sees. */
  loaded: Map<string, LoadedEntry>
}

/** Mutable state owned for one session. */
export interface SessionState {
  /** Whether the initial fold ran. */
  scanned: boolean
  /** Folded `surface.replaceGeneration`; a change invalidates the fold. */
  surfaceGeneration: number
  /** Folded surface sequences: both the fold cursor and the drift check. */
  foldedNodes: number[]
  /** Folded view of the visible instruction set. */
  visible: VisibleInstructions
  /** File paths touched by filesystem tools since the last step. */
  touched: Set<string>
  /** Directories ever touched in this session, kept for re-enabling nested discovery. */
  knownDirs: Set<string>
  /** Policy recorded for this session, when one was selected. */
  policy?: Policy
  /** Session log length at the last policy read. */
  policySeq: number
  /** Whether nested discovery was active at the previous step. */
  nestedActive: boolean
}

/** Create an empty visible instruction set. */
export function emptyVisible(): VisibleInstructions {
  return {
    baselineIdentity: undefined,
    baselineScopes: new Set(),
    loaded: new Map(),
  }
}

/** Create empty state for one session. */
export function createSessionState(): SessionState {
  return {
    scanned: false,
    surfaceGeneration: 0,
    foldedNodes: [],
    visible: emptyVisible(),
    touched: new Set(),
    knownDirs: new Set(),
    policySeq: 0,
    nestedActive: true,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function instructionSource(data: unknown): Record<string, unknown> | undefined {
  if (!isRecord(data)) return undefined
  const source = data['source']
  if (!isRecord(source)) return undefined
  if (source['kind'] !== 'agent-instructions') return undefined
  return source
}

/**
 * Fold one durable `user/message` event into a visible instruction set.
 *
 * A baseline message owns its scope set: scopes it does not mention stop being
 * baseline scopes, so a baseline rendered without per-file removals still
 * reconciles. Nested messages only add, replace, or drop the scopes they name.
 * @param visible - the fold to mutate.
 * @param data - the event payload.
 */
export function foldInstructionEvent(visible: VisibleInstructions, data: unknown): void {
  const source = instructionSource(data)
  if (source === undefined) return
  const isBaseline = source['baseline'] === true
  const changes = source['changes']
  const scopes = new Set<string>()
  if (Array.isArray(changes)) {
    for (const change of changes) {
      if (!isRecord(change)) continue
      const scope = change['scope']
      const path = change['path']
      if (typeof scope !== 'string' || typeof path !== 'string') continue
      if (change['action'] === 'remove') {
        visible.loaded.delete(scope)
        visible.baselineScopes.delete(scope)
        continue
      }
      visible.loaded.set(scope, {
        path,
        digest: typeof change['digest'] === 'string' ? change['digest'] : '',
      })
      scopes.add(scope)
    }
  }
  if (!isBaseline) return
  for (const scope of visible.baselineScopes) {
    if (!scopes.has(scope)) visible.loaded.delete(scope)
  }
  visible.baselineScopes = scopes
  if (typeof source['baselineIdentity'] === 'string') {
    visible.baselineIdentity = source['baselineIdentity']
  }
}

function foldSeq(session: Session, seq: number, visible: VisibleInstructions): void {
  const event: SessionEvent | undefined = session.eventAt(seq)
  if (event?.type !== 'user/message') return
  foldInstructionEvent(visible, event.data)
}

/**
 * Whether the surface still begins with the sequences the fold consumed.
 *
 * The runtime reports positional replacement through `replaceGeneration`; this
 * check keeps the fold correct on a runtime that renamed or dropped the field.
 * Appending leaves the folded prefix untouched, so only a replacement (or a
 * shrink) invalidates the fold.
 * @param nodes - current model-visible event sequences.
 * @param folded - sequences consumed so far.
 * @returns true when every folded position still holds the same sequence.
 */
function prefixMatches(nodes: readonly number[], folded: readonly number[]): boolean {
  if (nodes.length < folded.length) return false
  for (let index = 0; index < folded.length; index += 1) {
    if (nodes[index] !== folded[index]) return false
  }
  return true
}

/**
 * Rebuild visible instruction state from the complete durable log.
 * @param session - session whose surface is read.
 * @returns the newest baseline identity and every instruction path still in force.
 */
export function scanVisibleInstructions(session: Session): VisibleInstructions {
  const visible = emptyVisible()
  for (const seq of session.surface.nodes) foldSeq(session, seq, visible)
  return visible
}

/**
 * Bring the folded view up to date with the session surface.
 *
 * A new fold starts on the first call or after a surface replacement (compaction
 * and any other positional replacement). Otherwise only appended nodes are
 * folded, so the per-step cost stays proportional to new events.
 * @param session - session whose surface is read.
 * @param state - session state holding the fold and its cursor.
 * @returns the up-to-date visible instruction set.
 */
export function syncVisibleInstructions(session: Session, state: SessionState): VisibleInstructions {
  const surface = session.surface
  const generation = surface.replaceGeneration
  const replaced = generation === undefined
    ? !prefixMatches(surface.nodes, state.foldedNodes)
    : generation !== state.surfaceGeneration
  if (!state.scanned || replaced) {
    // A replacement can shadow nested scopes as well as the baseline. Nested
    // instructions return when their directory is touched again, like the
    // shipped loader; only the baseline is re-armed by the next pre-step.
    state.visible = emptyVisible()
    state.foldedNodes = []
    state.surfaceGeneration = generation ?? 0
    state.scanned = true
  }
  const nodes = surface.nodes
  while (state.foldedNodes.length < nodes.length) {
    const index = state.foldedNodes.length
    // `nodes` is a sequence list by contract; a hole still advances the cursor.
    const seq = nodes[index] as number
    state.foldedNodes.push(seq)
    foldSeq(session, seq, state.visible)
  }
  return state.visible
}
