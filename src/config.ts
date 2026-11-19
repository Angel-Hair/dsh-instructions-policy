/**
 * Row configuration and policy normalization.
 *
 * Configuration is the preset row's `config`. A misconfiguration fails at
 * activation instead of silently changing what the model sees.
 *
 * @module dsh-instructions-policy/config
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { LOCALE_MODES, type LocaleMode } from './i18n.ts'
import { resolveUserRoot, AGENTS_HOME_ENV, DSH_HOME_ENV } from './toolkit.ts'

/** Default byte budget for each instruction chain. */
export const DEFAULT_MAX_BYTES = 65_536

/** Default per-file read cap. */
export const DEFAULT_MAX_SOURCE_BYTES = 1_048_576

/** Directories that identify the project root while walking upward. */
export const DEFAULT_PROJECT_ROOT_MARKERS = ['.git'] as const

/** Base instruction file names loaded in every project directory. */
export const DEFAULT_CANDIDATES = ['AGENTS.md', 'CLAUDE.md'] as const

/** Local overlay file names loaded after the base candidates. */
export const DEFAULT_LOCAL_CANDIDATES = ['AGENTS.local.md', 'CLAUDE.local.md'] as const

/** How the project-root instruction scope is chosen. */
export type RootMode = 'default' | 'custom' | 'off'

/** The instruction policy, fixed for one mounting. */
export interface Policy {
  /** `default` loads the root directory's candidate files; `custom` replaces that scope with {@link file}. */
  root: RootMode
  /** Project-root-relative (or absolute) file used when `root` is `custom`. */
  file: string | null
  /** Whether `$DSH_HOME/AGENTS.md` and `$DSH_AGENTS_HOME/AGENTS.md` load. */
  global: boolean
  /** Whether touching a deeper directory adds that directory's instruction files. */
  nested: boolean
}

/** Row configuration as written in a preset. */
export interface RawConfig {
  policy?: {
    root?: string
    file?: string | null
    global?: boolean
    nested?: boolean
  }
  /** Language of `/instructions` results; model-visible text stays English. */
  locale?: string
  maxBytes?: number
  maxSourceBytes?: number
  projectRootMarkers?: string[]
  candidates?: string[]
  localCandidates?: string[]
}

/**
 * Merge the host row's defaults with the replaced row's own config.
 * The preset row wins where it speaks; the host row supplies the policy.
 * @param host - this bundle row's config.
 * @param row - the replaced preset row's config.
 * @returns merged config passed to the policy loader or projection.
 */
export function mergePolicyConfig(host: RawConfig | undefined, row: RawConfig | undefined): RawConfig {
  return {
    ...(host ?? {}),
    ...(row ?? {}),
    policy: { ...(host?.policy ?? {}), ...(row?.policy ?? {}) },
  }
}

/** Normalized configuration used by discovery and rendering. */
export interface ResolvedConfig {
  policy: Policy
  /** Language of `/instructions` results, or `auto` to follow the reader. */
  locale: LocaleMode
  maxBytes: number
  maxSourceBytes: number
  projectRootMarkers: string[]
  candidates: string[]
  localCandidates: string[]
  /** Absolute harness home (`$DSH_HOME` or `~/.dsh`). */
  dshHome: string
  /** Absolute shared agents root (`$DSH_AGENTS_HOME` or `~/.agents`). */
  agentsHome: string
  /** Model-facing label of {@link dshHome}. */
  dshHomeDisplay: string
  /** Model-facing label of {@link agentsHome}. */
  agentsHomeDisplay: string
}

/** Raised when a row cannot be used as written. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(`dsh-instructions-policy: ${message}`)
    this.name = 'ConfigError'
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ConfigError(`\`${field}\` must be a non-empty string`)
  }
  return value.trim()
}

function optionalByteBudget(value: unknown, fallback: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new ConfigError('`maxBytes` must be a non-negative finite number')
  }
  return value
}

function optionalPositiveNumber(value: unknown, field: string, fallback: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new ConfigError(`\`${field}\` must be a positive finite number`)
  }
  return value
}

function stringList(value: unknown, field: string, fallback: readonly string[]): string[] {
  if (value === undefined) return [...fallback]
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item.trim().length === 0)) {
    throw new ConfigError(`\`${field}\` must be an array of non-empty strings`)
  }
  return [...value].map(item => item.trim())
}

/**
 * Resolve row configuration into the runtime configuration.
 * @param raw - the preset row's `config`, or undefined when it omits one.
 * @returns normalized configuration.
 * @throws ConfigError when a field cannot be used.
 */
export function resolveConfig(raw: RawConfig | undefined): ResolvedConfig {
  const config = raw ?? {}
  const policyInput = config.policy ?? {}

  const root = policyInput.root ?? 'default'
  if (root !== 'default' && root !== 'custom' && root !== 'off') {
    throw new ConfigError('`policy.root` must be "default", "custom", or "off"')
  }
  const file = policyInput.file === undefined || policyInput.file === null
    ? null
    : requireString(policyInput.file, 'policy.file')
  if (root === 'custom' && file === null) {
    throw new ConfigError('`policy.file` is required when `policy.root` is "custom"')
  }

  const dshHome = resolveUserRoot(undefined, DSH_HOME_ENV, '.dsh')
  const agentsHome = resolveUserRoot(undefined, AGENTS_HOME_ENV, '.agents')

  const locale = config.locale ?? 'auto'
  if (!LOCALE_MODES.includes(locale as LocaleMode)) {
    throw new ConfigError('`locale` must be "auto", "zh", or "en"')
  }

  return {
    policy: {
      root,
      file,
      global: policyInput.global ?? true,
      nested: policyInput.nested ?? true,
    },
    locale: locale as LocaleMode,
    maxBytes: optionalByteBudget(config.maxBytes, DEFAULT_MAX_BYTES),
    maxSourceBytes: optionalPositiveNumber(config.maxSourceBytes, 'maxSourceBytes', DEFAULT_MAX_SOURCE_BYTES),
    projectRootMarkers: stringList(config.projectRootMarkers, 'projectRootMarkers', DEFAULT_PROJECT_ROOT_MARKERS),
    candidates: stringList(config.candidates, 'candidates', DEFAULT_CANDIDATES),
    localCandidates: stringList(config.localCandidates, 'localCandidates', DEFAULT_LOCAL_CANDIDATES),
    dshHome,
    agentsHome,
    dshHomeDisplay: homeLabel(dshHome, '.dsh', '~/.dsh', DSH_HOME_ENV),
    agentsHomeDisplay: homeLabel(agentsHome, '.agents', '~/.agents', AGENTS_HOME_ENV),
  }
}

function homeLabel(resolved: string, defaultDirectory: string, defaultLabel: string, envName: string): string {
  // The default root is the OS home plus the directory name; the symbolic label
  // keeps absolute machine paths out of the prompt.
  return resolved === resolve(join(homedir(), defaultDirectory)) ? defaultLabel : `$${envName}`
}
