/**
 * Policy-aware discovery and bounded reading of instruction files.
 *
 * Baseline discovery walks the project chain from the project root down to the
 * session working directory. Nested discovery adds one directory's candidates
 * after a filesystem tool touches a file below the working directory.
 *
 * @module dsh-instructions-policy/discovery
 */

import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { ResolvedConfig } from './config.ts'
import {
  ancestorChain,
  attachmentDisplayPath,
  contentDigest,
  decodeAttachmentFile,
  displayFileValue,
  isInside,
  USER_GLOBAL_FILE,
} from './toolkit.ts'
import type { AttachmentRef, InstructionFile } from './toolkit.ts'
import type { AttachmentStoreLike, FileSystem } from './types.ts'

/** Baseline files plus the configured custom root file that could not be read. */
export interface BaselineDiscovery {
  files: InstructionFile[]
  /** Configured custom root path that could not be loaded, and why. */
  customProblem: { kind: 'missing' | 'outside'; file: string } | null
}

/** Model-facing path of one project file, always with `/` separators. */
export function projectDisplayPath(projectRoot: string, absolutePath: string): string {
  return relative(resolve(projectRoot), resolve(absolutePath)).split(sep).join('/')
}

/** Resolve the working directory's project root by marker, falling back to cwd. */
export async function findProjectRoot(
  cwd: string,
  markers: readonly string[],
  fileSystem: FileSystem | undefined,
  signal: AbortSignal | undefined,
): Promise<string> {
  let current = resolve(cwd)
  for (;;) {
    for (const marker of markers) {
      if (await pathExists(join(current, marker), fileSystem, signal)) return current
    }
    const parent = resolve(current, '..')
    if (parent === current) return resolve(cwd)
    current = parent
  }
}

function isMissingPathError(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined
  return code === 'ENOENT' || code === 'ENOTDIR' || code === 'FS_NOT_FOUND'
}

async function pathExists(
  path: string,
  fileSystem: FileSystem | undefined,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  // Mirror the shipped loader: only a confirmed absence means "keep climbing".
  // A permission or I/O failure surfaces instead of selecting an ancestor root.
  if (fileSystem !== undefined) {
    try {
      const target = await fileSystem.resolve(path, signal === undefined ? {} : { signal })
      return await fileSystem.stat(target, signal) !== undefined
    } catch (error) {
      signal?.throwIfAborted()
      if (isMissingPathError(error)) return false
      throw error
    }
  }
  try {
    await stat(path)
    return true
  } catch (error) {
    signal?.throwIfAborted()
    if (isMissingPathError(error)) return false
    throw error
  }
}

/**
 * Read one instruction file under the per-file cap.
 * @param absolutePath - absolute path to read.
 * @param config - resolved configuration carrying the cap.
 * @param fileSystem - optional provider used instead of host reads.
 * @param signal - cancellation.
 * @returns the file, or undefined when it is absent, not a regular file, over the cap, empty, or unreadable.
 */
async function readInstructionFile(
  absolutePath: string,
  config: ResolvedConfig,
  fileSystem: FileSystem | undefined,
  signal: AbortSignal | undefined,
): Promise<Omit<InstructionFile, 'displayPath' | 'chain'> | undefined> {
  let content: string | undefined
  if (fileSystem !== undefined) {
    const target = await fileSystem.resolve(absolutePath, signal === undefined ? {} : { signal })
    const info = await fileSystem.stat(target, signal)
    if (info === undefined || info.type !== 'file') return undefined
    if (info.size !== undefined && info.size > config.maxSourceBytes) return undefined
    const chunks: string[] = []
    let bytes = 0
    for await (const chunk of await fileSystem.streamText(target, signal)) {
      signal?.throwIfAborted()
      bytes += Buffer.byteLength(chunk, 'utf8')
      if (bytes > config.maxSourceBytes) return undefined
      chunks.push(chunk)
    }
    content = chunks.join('')
  } else {
    try {
      const info = await stat(absolutePath)
      if (!info.isFile() || info.size > config.maxSourceBytes) return undefined
      const buffer = await readFile(absolutePath)
      if (buffer.byteLength > config.maxSourceBytes) return undefined
      content = buffer.toString('utf8')
    } catch {
      signal?.throwIfAborted()
      return undefined
    }
  }
  if (content.trim().length === 0) return undefined
  if (content.includes('\u0000')) return undefined
  return {
    absolutePath: resolve(absolutePath),
    content,
    digest: contentDigest(content),
    bytes: Buffer.byteLength(content, 'utf8'),
  }
}

/**
 * Read one imported instruction file from the durable attachment store.
 * @param ref - stored attachment reference encoded in the policy.
 * @param config - resolved configuration carrying the cap.
 * @param attachments - host attachment store.
 * @param signal - cancellation.
 * @returns the file, or undefined when the store is absent, the read fails, the
 *   declared length differs, the bytes are not UTF-8 text, or the content is empty.
 */
async function readAttachmentFile(
  ref: AttachmentRef,
  config: ResolvedConfig,
  attachments: AttachmentStoreLike | undefined,
  signal: AbortSignal | undefined,
): Promise<Omit<InstructionFile, 'displayPath' | 'chain'> | undefined> {
  if (attachments === undefined || ref.bytes > config.maxSourceBytes) return undefined
  try {
    const chunks: Uint8Array[] = []
    let total = 0
    for await (const chunk of attachments.readFileStream(ref, signal)) {
      signal?.throwIfAborted()
      total += chunk.byteLength
      if (total > config.maxSourceBytes) return undefined
      chunks.push(chunk)
    }
    if (total !== ref.bytes) return undefined
    const content = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
    if (content.trim().length === 0) return undefined
    if (content.includes('\u0000')) return undefined
    return {
      absolutePath: `attachment:${ref.attachmentId}`,
      content,
      digest: contentDigest(content),
      bytes: Buffer.byteLength(content, 'utf8'),
    }
  } catch {
    signal?.throwIfAborted()
    return undefined
  }
}

/** Ordered candidate file names for one project directory. */
export function candidateNames(config: ResolvedConfig): string[] {
  return [...config.candidates, ...config.localCandidates]
}

interface Grouped {
  file: InstructionFile
  group: string
}

/**
 * Collapse files whose trimmed content matches an earlier file in the same
 * candidate group. The two user-global roots share one group; every project
 * directory forms its own.
 */
function dedupeByTrimmedContent(grouped: readonly Grouped[]): InstructionFile[] {
  const seen = new Map<string, Set<string>>()
  const kept: InstructionFile[] = []
  for (const { file, group } of grouped) {
    const digests = seen.get(group) ?? new Set<string>()
    if (digests.has(file.digest)) continue
    digests.add(file.digest)
    seen.set(group, digests)
    kept.push(file)
  }
  return kept
}

/**
 * Keep the first file for each model-facing path.
 *
 * A custom root that names a file the chain also discovers — for example
 * `root custom child/AGENTS.md` while working inside `child` — must render
 * once. The custom entry comes first, so later duplicates are dropped.
 * @param files - ordered files.
 * @returns files with one entry per display path.
 */
function dedupeByDisplayPath(files: readonly InstructionFile[]): InstructionFile[] {
  const seen = new Set<string>()
  return files.filter(file => {
    if (seen.has(file.displayPath)) return false
    seen.add(file.displayPath)
    return true
  })
}

/**
 * Discover the baseline instruction set for one session.
 * @param config - resolved policy and discovery configuration.
 * @param cwd - session working directory.
 * @param projectRoot - project root selected for this baseline.
 * @param fileSystem - optional provider.
 * @param signal - cancellation.
 * @returns baseline files in broad-to-specific order and a missing custom-root diagnostic.
 */
export async function discoverBaseline(
  config: ResolvedConfig,
  cwd: string,
  projectRoot: string,
  fileSystem: FileSystem | undefined,
  signal: AbortSignal | undefined,
  attachments?: AttachmentStoreLike,
): Promise<BaselineDiscovery> {
  const grouped: Grouped[] = []
  let customProblem: { kind: 'missing' | 'outside'; file: string } | null = null

  if (config.policy.global) {
    for (const root of [
      { home: config.dshHome, display: config.dshHomeDisplay },
      { home: config.agentsHome, display: config.agentsHomeDisplay },
    ]) {
      const absolutePath = join(root.home, USER_GLOBAL_FILE)
      const file = await readInstructionFile(absolutePath, config, fileSystem, signal)
      if (file === undefined) continue
      grouped.push({
        group: 'user-global',
        file: { ...file, displayPath: `${root.display}/${USER_GLOBAL_FILE}`, chain: 'global' },
      })
    }
  }

  for (const directory of ancestorChain(projectRoot, cwd)) {
    const absoluteDir = resolve(directory)
    const isRoot = absoluteDir === resolve(projectRoot)
    if (isRoot && config.policy.root === 'off') continue
    if (isRoot && config.policy.root === 'custom' && config.policy.file !== null) {
      const configured = config.policy.file
      const attachment = decodeAttachmentFile(configured)
      if (attachment !== undefined) {
        const file = await readAttachmentFile(attachment, config, attachments, signal)
        if (file === undefined) {
          customProblem = { kind: 'missing', file: displayFileValue(configured) }
          continue
        }
        grouped.push({
          group: 'attachment',
          file: { ...file, displayPath: attachmentDisplayPath(attachment.name), chain: 'project' },
        })
        continue
      }
      // A relative custom path is written from the session's viewpoint, so the
      // working directory wins over the project root when both could hold it.
      const fromCwd = isAbsolute(configured) ? resolve(configured) : resolve(cwd, configured)
      const absolutePath = isAbsolute(configured) || await pathExists(fromCwd, fileSystem, signal)
        ? fromCwd
        : resolve(projectRoot, configured)
      if (!isInside(projectRoot, absolutePath)) {
        customProblem = { kind: 'outside', file: configured }
        continue
      }
      const file = await readInstructionFile(absolutePath, config, fileSystem, signal)
      if (file === undefined) {
        // Keep walking the rest of the chain: a missing custom root only drops
        // the root scope, it does not disable the session's instructions.
        customProblem = { kind: 'missing', file: configured }
        continue
      }
      grouped.push({
        group: `dir:${absoluteDir}`,
        file: {
          ...file,
          displayPath: isInside(projectRoot, absolutePath)
            ? projectDisplayPath(projectRoot, absolutePath)
            : configured,
          chain: 'project',
        },
      })
      continue
    }
    for (const candidate of candidateNames(config)) {
      const absolutePath = join(absoluteDir, candidate)
      const file = await readInstructionFile(absolutePath, config, fileSystem, signal)
      if (file === undefined) continue
      grouped.push({
        group: `dir:${absoluteDir}`,
        file: {
          ...file,
          displayPath: projectDisplayPath(projectRoot, absolutePath),
          chain: 'project',
        },
      })
    }
  }

  return { files: dedupeByDisplayPath(dedupeByTrimmedContent(grouped)), customProblem }
}

/**
 * Discover one project directory's candidate files for nested discovery.
 * @param config - resolved configuration.
 * @param directory - absolute directory below the session working directory.
 * @param projectRoot - project root, used for display paths.
 * @param fileSystem - optional provider.
 * @param signal - cancellation.
 * @returns files in candidate order, deduplicated within this directory.
 */
export async function discoverScope(
  config: ResolvedConfig,
  directory: string,
  projectRoot: string,
  fileSystem: FileSystem | undefined,
  signal: AbortSignal | undefined,
): Promise<InstructionFile[]> {
  const grouped: Grouped[] = []
  for (const candidate of candidateNames(config)) {
    const absolutePath = join(directory, candidate)
    const file = await readInstructionFile(absolutePath, config, fileSystem, signal)
    if (file === undefined) continue
    grouped.push({
      group: `dir:${resolve(directory)}`,
      file: {
        ...file,
        displayPath: projectDisplayPath(projectRoot, absolutePath),
        chain: 'project',
      },
    })
  }
  return dedupeByTrimmedContent(grouped)
}
