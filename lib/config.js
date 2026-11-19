/**
 * Row configuration and policy normalization.
 *
 * Configuration is the preset row's `config`. A misconfiguration fails at
 * activation instead of silently changing what the model sees.
 *
 * @module dsh-instructions-policy/config
 */
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { LOCALE_MODES } from "./i18n.js";
import { resolveUserRoot, AGENTS_HOME_ENV, DSH_HOME_ENV } from "./toolkit.js";
/** Default byte budget for each instruction chain. */
export const DEFAULT_MAX_BYTES = 65_536;
/** Default per-file read cap. */
export const DEFAULT_MAX_SOURCE_BYTES = 1_048_576;
/** Directories that identify the project root while walking upward. */
export const DEFAULT_PROJECT_ROOT_MARKERS = ['.git'];
/** Base instruction file names loaded in every project directory. */
export const DEFAULT_CANDIDATES = ['AGENTS.md', 'CLAUDE.md'];
/** Local overlay file names loaded after the base candidates. */
export const DEFAULT_LOCAL_CANDIDATES = ['AGENTS.local.md', 'CLAUDE.local.md'];
/**
 * Merge the host row's defaults with the replaced row's own config.
 * The preset row wins where it speaks; the host row supplies the policy.
 * @param host - this bundle row's config.
 * @param row - the replaced preset row's config.
 * @returns merged config passed to the policy loader or projection.
 */
export function mergePolicyConfig(host, row) {
    return {
        ...(host ?? {}),
        ...(row ?? {}),
        policy: { ...(host?.policy ?? {}), ...(row?.policy ?? {}) },
    };
}
/** Raised when a row cannot be used as written. */
export class ConfigError extends Error {
    constructor(message) {
        super(`dsh-instructions-policy: ${message}`);
        this.name = 'ConfigError';
    }
}
function requireString(value, field) {
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new ConfigError(`\`${field}\` must be a non-empty string`);
    }
    return value.trim();
}
function optionalByteBudget(value, fallback) {
    if (value === undefined)
        return fallback;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        throw new ConfigError('`maxBytes` must be a non-negative finite number');
    }
    return value;
}
function optionalPositiveNumber(value, field, fallback) {
    if (value === undefined)
        return fallback;
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        throw new ConfigError(`\`${field}\` must be a positive finite number`);
    }
    return value;
}
function stringList(value, field, fallback) {
    if (value === undefined)
        return [...fallback];
    if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item.trim().length === 0)) {
        throw new ConfigError(`\`${field}\` must be an array of non-empty strings`);
    }
    return [...value].map(item => item.trim());
}
/**
 * Resolve row configuration into the runtime configuration.
 * @param raw - the preset row's `config`, or undefined when it omits one.
 * @returns normalized configuration.
 * @throws ConfigError when a field cannot be used.
 */
export function resolveConfig(raw) {
    const config = raw ?? {};
    const policyInput = config.policy ?? {};
    const root = policyInput.root ?? 'default';
    if (root !== 'default' && root !== 'custom' && root !== 'off') {
        throw new ConfigError('`policy.root` must be "default", "custom", or "off"');
    }
    const file = policyInput.file === undefined || policyInput.file === null
        ? null
        : requireString(policyInput.file, 'policy.file');
    if (root === 'custom' && file === null) {
        throw new ConfigError('`policy.file` is required when `policy.root` is "custom"');
    }
    const dshHome = resolveUserRoot(undefined, DSH_HOME_ENV, '.dsh');
    const agentsHome = resolveUserRoot(undefined, AGENTS_HOME_ENV, '.agents');
    const locale = config.locale ?? 'auto';
    if (!LOCALE_MODES.includes(locale)) {
        throw new ConfigError('`locale` must be "auto", "zh", or "en"');
    }
    return {
        policy: {
            root,
            file,
            global: policyInput.global ?? true,
            nested: policyInput.nested ?? true,
        },
        locale: locale,
        maxBytes: optionalByteBudget(config.maxBytes, DEFAULT_MAX_BYTES),
        maxSourceBytes: optionalPositiveNumber(config.maxSourceBytes, 'maxSourceBytes', DEFAULT_MAX_SOURCE_BYTES),
        projectRootMarkers: stringList(config.projectRootMarkers, 'projectRootMarkers', DEFAULT_PROJECT_ROOT_MARKERS),
        candidates: stringList(config.candidates, 'candidates', DEFAULT_CANDIDATES),
        localCandidates: stringList(config.localCandidates, 'localCandidates', DEFAULT_LOCAL_CANDIDATES),
        dshHome,
        agentsHome,
        dshHomeDisplay: homeLabel(dshHome, '.dsh', '~/.dsh', DSH_HOME_ENV),
        agentsHomeDisplay: homeLabel(agentsHome, '.agents', '~/.agents', AGENTS_HOME_ENV),
    };
}
function homeLabel(resolved, defaultDirectory, defaultLabel, envName) {
    // The default root is the OS home plus the directory name; the symbolic label
    // keeps absolute machine paths out of the prompt.
    return resolved === resolve(join(homedir(), defaultDirectory)) ? defaultLabel : `$${envName}`;
}
