/**
 * Host half: redirect the shipped instruction loader for every preset.
 *
 * DSH composes a profile from its bundle patches and per-agent presets. The
 * shipped `agent-instructions` row lives inside each preset's child list, so a
 * replacement plugin would normally have to copy that list (and go stale on
 * every DSH upgrade). Instead this row wraps the Loader module import seam:
 * whenever any entry imports `@deepseek-ai/dsh-agent-instructions`, the Loader
 * receives this package policy-aware module instead. No preset file, no
 * snapshot.
 *
 * The seam is `ctx.loader.internal.import`, the same method the Loader uses for
 * every plugin entry. It is not a documented public API; see DESIGN.md.
 *
 * The wrapper is installed as an accessor, not a one-shot assignment: another
 * plugin that replaces `loader.internal` wholesale (the client module graph
 * does) still goes through the redirect.
 *
 * @module dsh-instructions-policy
 */
var __rewriteRelativeImportExtension = (this && this.__rewriteRelativeImportExtension) || function (path, preserveJsx) {
    if (typeof path === "string" && /^\.\.?\//.test(path)) {
        return path.replace(/\.(tsx)$|((?:\.d)?)((?:\.[^./]+?)?)\.([cm]?)ts$/i, function (m, tsx, d, ext, cm) {
            return tsx ? preserveJsx ? ".jsx" : ".js" : d && (!ext || !cm) ? m : (d + ext + "." + cm.toLowerCase() + "js");
        });
    }
    return path;
};
import { createRequire } from 'node:module';
import { mergePolicyConfig } from "./config.js";
import { installPolicyProjection } from "./projection.js";
/** Loader name of the host row. */
export const name = 'instructions-policy-host';
/** The Loader seam and the projection registry this row contributes to. */
export const inject = ['loader', 'sessionProjections'];
/** Package whose module gets replaced in every preset. */
const UPSTREAM = '@deepseek-ai/dsh-agent-instructions';
const WRAPPED = Symbol.for('dsh-instructions-policy.wrapped');
const INSTALLED = Symbol.for('dsh-instructions-policy.installed');
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/**
 * Count the agent-preset rows that mount the shipped instruction row.
 *
 * Presets are ordinary Loader rows whose `config.plugins` list the child rows
 * an Agent gets; the shipped instruction row lives in that list, so the count
 * answers "will anything ever import the module this row replaces" before the
 * first session exists.
 * @param loader - Loader service with an entry listing.
 * @returns the number of preset rows that mount the upstream row.
 */
function countPresetMounts(loader) {
    let mounts = 0;
    for (const entry of loader.entries?.() ?? []) {
        const config = entry.options.config;
        if (!isRecord(config) || !Array.isArray(config['plugins']))
            continue;
        for (const row of config['plugins']) {
            if (isRecord(row) && row['name'] === UPSTREAM)
                mounts += 1;
        }
    }
    return mounts;
}
/**
 * Read the version of the replaced package from its own manifest.
 * @param parentURL - resolution base of the importing entry.
 * @returns the version, or undefined when the manifest cannot be resolved.
 */
function upstreamVersion(parentURL) {
    try {
        const manifest = createRequire(parentURL)(`${UPSTREAM}/package.json`);
        return typeof manifest.version === 'string' ? manifest.version : undefined;
    }
    catch {
        return undefined;
    }
}
export { mergePolicyConfig } from "./config.js";
/**
 * Wrap one module loader so the shipped instruction package resolves to this
 * package's policy loader.
 *
 * A Proxy, not `Object.create`: other methods read with the original receiver,
 * so a class using private fields keeps working.
 * @param target - the loader seam to wrap.
 * @param onIntercept - called once per redirected import.
 * @param replacement - resolves the module namespace handed to the Loader.
 * @returns the wrapped seam.
 */
function wrapLoader(target, onIntercept, replacement) {
    const redirect = (specifier, parentURL, attributes) => {
        if (specifier !== UPSTREAM)
            return target.import(specifier, parentURL, attributes);
        onIntercept();
        return replacement(specifier, parentURL, attributes);
    };
    return new Proxy(target, {
        get(object, property) {
            if (property === 'import')
                return redirect;
            const value = Reflect.get(object, property, object);
            return typeof value === 'function' ? value.bind(object) : value;
        },
    });
}
/**
 * Install the redirect, or restore the original loader on plugin disposal.
 * @param ctx - plugin context carrying the Loader service.
 * @param config - this host row's config; the stable home for policy defaults.
 */
export function apply(ctx, config) {
    const loader = ctx.get('loader');
    if (loader === undefined) {
        ctx.logger.warn('instructions-policy: loader service unavailable; instruction policy inactive');
        return;
    }
    const existing = loader[INSTALLED];
    if (existing !== undefined) {
        existing.setConfig(config);
        return;
    }
    const target = loader.internal;
    if (target === undefined) {
        ctx.logger.warn('instructions-policy: loader import seam unavailable; instruction policy inactive');
        return;
    }
    let hostConfig = config;
    let intercepted = 0;
    let announced = false;
    let replacedVersion;
    let replacement;
    const onIntercept = () => {
        intercepted += 1;
    };
    const policyModule = (specifier, parentURL, attributes) => {
        replacement ??= (async () => {
            // Load the running harness copy first: its exported renderer is the exact
            // prompt format of the installed version, with no copied code and no
            // pinned dependency. A missing or renamed package degrades to ours.
            let official;
            try {
                official = await target.import(specifier, parentURL, attributes);
            }
            catch (error) {
                ctx.logger.warn('instructions-policy: shipped loader unavailable (%s); using the built-in renderer', String(error));
            }
            if (!announced) {
                announced = true;
                replacedVersion = upstreamVersion(parentURL);
                ctx.logger.info?.('instructions-policy: replaced %s@%s at import', specifier, replacedVersion ?? 'unknown');
            }
            const namespace = await import(__rewriteRelativeImportExtension(new URL('./loader.js', import.meta.url).href));
            const policyApply = namespace.apply;
            if (typeof policyApply !== 'function')
                return namespace;
            return {
                ...namespace,
                apply: (pluginCtx, row) => policyApply(pluginCtx, mergePolicyConfig(hostConfig, row), official),
            };
        })();
        return replacement;
    };
    const wrap = (value) => (value[WRAPPED] === true ? value : wrapLoader(value, onIntercept, policyModule));
    const descriptor = Object.getOwnPropertyDescriptor(loader, 'internal');
    let current = wrap(target);
    Object.defineProperty(loader, 'internal', {
        configurable: true,
        enumerable: descriptor?.enumerable ?? true,
        get: () => current,
        set: (next) => {
            current = next === undefined ? undefined : wrap(next);
        },
    });
    const dispose = () => {
        if (descriptor === undefined)
            Reflect.deleteProperty(loader, 'internal');
        else
            Object.defineProperty(loader, 'internal', descriptor);
        Reflect.deleteProperty(loader, INSTALLED);
    };
    const record = {
        intercepted: () => intercepted,
        setConfig: (next) => { hostConfig = next; },
        dispose,
    };
    Object.defineProperty(loader, INSTALLED, { configurable: true, value: record });
    ctx.effect?.(() => () => {
        if (loader[INSTALLED] === record)
            dispose();
    });
    // Self-check at activation: presets are ordinary Loader rows, so the composed
    // tree already says whether any Agent will ever import the replaced module.
    // A mismatch here means the package name or the preset layout changed.
    let mounts;
    try {
        mounts = loader.entries === undefined ? undefined : countPresetMounts(loader);
    }
    catch {
        mounts = undefined;
    }
    if (mounts === 0) {
        ctx.logger.warn('instructions-policy: no agent preset mounts %s; instruction policy inactive', UPSTREAM);
    }
    else if (mounts === undefined) {
        ctx.logger.info?.('instructions-policy: redirecting %s to the policy loader', UPSTREAM);
    }
    else {
        ctx.logger.info?.('instructions-policy: redirecting %s for %d preset row(s)', UPSTREAM, mounts);
    }
    // The chip reads policy through one host projection instead of folding the
    // browser event window. The projection resolves its own preset-row defaults
    // from the composed Loader tree, so every preset keeps its row overrides.
    installPolicyProjection(ctx, ctx.get('sessionProjections'), {
        hostConfig,
        loader,
        warn: (...args) => ctx.logger.warn(...args),
    });
    // Self-check at the first step: a preset imports its instruction row before
    // the step runs, so no interception by now means the seam stopped working.
    let checked = false;
    ctx.on('agent/pre-step', async (_payload, next) => {
        const decision = await next();
        if (!checked) {
            checked = true;
            if (record.intercepted() === 0) {
                ctx.logger.warn('instructions-policy: no preset imported %s@%s; instruction policy inactive', UPSTREAM, replacedVersion ?? 'unknown');
            }
        }
        return decision;
    });
}
