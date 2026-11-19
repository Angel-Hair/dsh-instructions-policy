/**
 * Small runtime helpers shared by the policy loader.
 *
 * @module dsh-instructions-policy/toolkit
 */

import { createHash, randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { TextBlock, UserMessage } from './types.ts'

/** Environment variable that overrides the harness home. */
export const DSH_HOME_ENV = 'DSH_HOME'

/** Environment variable that overrides the shared agents root. */
export const AGENTS_HOME_ENV = 'DSH_AGENTS_HOME'

/** Fixed file name of the user-global instruction chain. */
export const USER_GLOBAL_FILE = 'AGENTS.md'

/** Prefix of a `policy.file` value that names a stored attachment instead of a path. */
export const ATTACHMENT_FILE_PREFIX = 'dsh-attachment:'

/** Model-facing path prefix of an imported instruction file. */
const ATTACHMENT_DISPLAY_DIRECTORY = 'attachment'

/** One stored attachment reference. */
export interface AttachmentRef {
  attachmentId: string
  name: string
  bytes: number
}

/**
 * Encode an attachment reference as a replayable `policy.file` value.
 *
 * The command log only keeps the arguments of `/instructions`, so the policy
 * must be reconstructible from them: the reference carries the content id, the
 * exact byte count, and the display name the store needs to find the object.
 * @param ref - stored attachment reference.
 * @returns the encoded policy file value.
 */
export function encodeAttachmentFile(ref: AttachmentRef): string {
  return `${ATTACHMENT_FILE_PREFIX}${ref.attachmentId}#${ref.bytes}#${encodeURIComponent(ref.name)}`
}

/**
 * Decode a `policy.file` value produced by {@link encodeAttachmentFile}.
 * @param file - policy file value.
 * @returns the reference, or undefined for a path or a malformed value.
 */
export function decodeAttachmentFile(file: string): AttachmentRef | undefined {
  if (!file.startsWith(ATTACHMENT_FILE_PREFIX)) return undefined
  const rest = file.slice(ATTACHMENT_FILE_PREFIX.length)
  const bytesAt = rest.indexOf('#')
  if (bytesAt <= 0) return undefined
  const nameAt = rest.indexOf('#', bytesAt + 1)
  if (nameAt < 0) return undefined
  const attachmentId = rest.slice(0, bytesAt)
  const bytes = Number(rest.slice(bytesAt + 1, nameAt))
  let name: string
  try {
    name = decodeURIComponent(rest.slice(nameAt + 1))
  } catch {
    return undefined
  }
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || name.length === 0) return undefined
  return { attachmentId, name, bytes }
}

/** Model-facing path of an imported instruction file. */
export function attachmentDisplayPath(name: string): string {
  return `${ATTACHMENT_DISPLAY_DIRECTORY}/${name}`
}

/** Human-readable name of a policy file value, for command output and tooltips. */
export function displayFileValue(file: string): string {
  return decodeAttachmentFile(file)?.name ?? file
}

/** Prefix that marks a URI-encoded attachment name in command arguments. */
const ENCODED_ATTACH_NAME_PREFIX = 'uri:'

/**
 * Decode the name token of `/instructions root attach`.
 *
 * The name is URI-encoded so the command remains a whitespace-separated line:
 * a stored display name may contain repeated spaces, and splitting the raw name
 * would make the attachment store's exact-name lookup fail. Names stored without
 * the prefix are legacy raw names and are returned verbatim.
 * @param value - the name token from the command line.
 * @returns the decoded display name, or undefined when an encoded name is malformed.
 */
function decodeAttachName(value: string): string | undefined {
  if (!value.startsWith(ENCODED_ATTACH_NAME_PREFIX)) return value
  try {
    return decodeURIComponent(value.slice(ENCODED_ATTACH_NAME_PREFIX.length))
  } catch {
    return undefined
  }
}

/**
 * Parse the arguments of `/instructions root attach`.
 * @param value - everything after `attach `.
 * @returns the reference, or undefined when the line is malformed.
 */
export function parseAttachArgs(value: string): AttachmentRef | undefined {
  const [attachmentId, bytesText, ...nameParts] = value.trim().split(/\s+/)
  const bytes = Number(bytesText)
  const name = decodeAttachName(nameParts.join(' '))
  if (attachmentId === undefined || attachmentId.length === 0
    || !Number.isSafeInteger(bytes) || bytes <= 0 || name === undefined || name.length === 0) {
    return undefined
  }
  return { attachmentId, name, bytes }
}

/** One instruction file that was read successfully. */
export interface InstructionFile {
  /** Absolute path on the host filesystem. */
  absolutePath: string
  /** Model-facing path, relative to the project root or symbolic for a home root. */
  displayPath: string
  /** UTF-8 content. */
  content: string
  /** Digest of the trimmed content, used to detect changes and duplicates. */
  digest: string
  /** Byte length of the content. */
  bytes: number
  /** Which budgeted chain the file belongs to. */
  chain: 'global' | 'project'
}

/** Deep-freeze a value so published messages cannot be mutated in place. */
export function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const nested of Object.values(value)) deepFreeze(nested)
  return value
}

/**
 * Create the model-visible user message that carries instruction text.
 * @param content - rendered instruction text.
 * @param source - durable source record for the session event.
 * @returns a frozen user message with a fresh identity.
 */
export function createInstructionMessage(
  content: string,
  source: Record<string, unknown>,
): UserMessage {
  const blocks: TextBlock[] = [{ type: 'text', text: content }]
  return deepFreeze({
    id: randomUUID(),
    role: 'user',
    content: blocks,
    source,
  } satisfies UserMessage)
}

/** Digest one file's trimmed content. */
export function contentDigest(content: string): string {
  return createHash('sha1').update(content.trim(), 'utf8').digest('hex')
}

/** UTF-8 byte length of a string. */
export function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

/**
 * Truncate a string to a UTF-8 byte budget without splitting a character.
 * @param text - source text.
 * @param maxBytes - maximum bytes to keep.
 * @returns the longest prefix at or under the budget.
 */
export function truncateUtf8(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.byteLength <= maxBytes) return text
  // Back up to a lead byte so a trailing partial code point is dropped instead
  // of becoming a replacement character that exceeds the budget again.
  let end = Math.max(0, Math.trunc(maxBytes))
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1
  return bytes.subarray(0, end).toString('utf8')
}

/**
 * Protect the plugin-owned frame from repository-controlled text.
 *
 * The model sees a plain closing tag if a file contains one, so replace it with
 * an escaped form, matching the shipped plugin's framing guarantee.
 * @param text - instruction file content.
 * @returns the content with closing frame tags escaped.
 */
export function escapeClosingTag(text: string): string {
  return text.replaceAll('</system-reminder>', '<\\/system-reminder>')
}

/** Expand `~`, `~/`, and `~\` prefixes against the operating-system home. */
function expandHomePath(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

/**
 * Resolve one user-data root.
 * @param configured - explicit row override, highest precedence.
 * @param envName - environment variable that overrides the default.
 * @param directoryName - default directory name under the OS home.
 * @returns the normalized absolute root.
 */
export function resolveUserRoot(configured: string | undefined, envName: string, directoryName: string): string {
  const fromEnv = process.env[envName]
  const selected = configured
    ?? (fromEnv !== undefined && fromEnv.trim().length > 0 ? fromEnv : join(homedir(), directoryName))
  return resolve(expandHomePath(selected))
}

/**
 * Label a resolved user-data root symbolically for model-facing display.
 * @param resolvedRoot - absolute root returned by {@link resolveUserRoot}.
 * @param defaultRoot - absolute default root.
 * @param defaultLabel - symbolic label of the default root.
 * @param envName - environment variable that labels any other root.
 * @returns the symbolic label.
 */
export function userRootDisplay(
  resolvedRoot: string,
  defaultRoot: string,
  defaultLabel: string,
  envName: string,
): string {
  return resolvedRoot === resolve(defaultRoot) ? defaultLabel : `$${envName}`
}

/** The inclusive directory chain from a root down to cwd, broad to specific. */
export function ancestorChain(root: string, cwd: string): string[] {
  const chain: string[] = []
  let current = resolve(cwd)
  const resolvedRoot = resolve(root)
  while (current !== resolvedRoot) {
    chain.push(current)
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  chain.push(resolvedRoot)
  return chain.reverse()
}

/** Directories crossed from cwd down to the touched file's parent. */
export function descendantDirsBetween(root: string, touchedPath: string): string[] {
  const resolvedRoot = resolve(root)
  const target = isAbsolute(touchedPath) ? resolve(touchedPath) : resolve(resolvedRoot, touchedPath)
  const targetDir = dirname(target)
  const rel = relative(resolvedRoot, targetDir)
  if (rel.length === 0 || rel.startsWith('..') || isAbsolute(rel)) return []
  return ancestorChain(resolvedRoot, targetDir).slice(1)
}

/** Whether one absolute path is inside a root directory. */
export function isInside(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path))
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel)
}

/** Read the `file_path` argument of a filesystem tool call. */
export function filePathArgument(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined
  const value = (args as Record<string, unknown>)['file_path']
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}
