/**
 * Workspace instruction policy for DeepSeek Harness.
 *
 * Replaces `@deepseek-ai/dsh-agent-instructions` inside one agent preset and
 * adds a policy layer: the project-root scope can be replaced by one configured
 * file, the user-global chain can be switched off, and subdirectory discovery
 * can be switched off. Everything else — the `<system-reminder>` framing,
 * per-chain byte budgets, change notification labels — stays identical to the
 * shipped plugin.
 *
 * Every step reconciles against the durable session log rather than against
 * private bookkeeping: what the model can see is what the log says it saw. That
 * keeps resume, compaction, and a policy change on one code path.
 *
 * @module dsh-instructions-policy
 */
import { resolveConfig } from "./config.js";
import { discoverBaseline, discoverScope, findProjectRoot, projectDisplayPath } from "./discovery.js";
import { messagesFor, resolveCommandLocale } from "./i18n.js";
import { replayPolicy } from "./policy.js";
import { renderBaseline, renderNested, renderRemovals } from "./render.js";
import { createSessionState, scanVisibleInstructions, syncVisibleInstructions, } from "./state.js";
import { createInstructionMessage, descendantDirsBetween, displayFileValue, encodeAttachmentFile, filePathArgument, parseAttachArgs, } from "./toolkit.js";
/** Loader name of this plugin. */
export const name = 'instructions-policy';
/** Services this plugin waits for; `fs` is optional and read through `ctx.get`. */
export const inject = ['workingDirectory'];
const FILE_TOOLS = new Set(['read', 'write', 'edit']);
function isReject(decision) {
    return decision.kind === 'reject';
}
/** Model-facing policy snapshot carried by every instruction message. */
function policyRecord(policy) {
    return { root: policy.root, file: policy.file, global: policy.global, nested: policy.nested };
}
/** Durable source shared by every instruction message. */
function sourceRecord(policy, projectRoot) {
    return {
        kind: 'agent-instructions',
        form: 'instructions',
        policy: policyRecord(policy),
        projectRoot,
    };
}
function baselineIdentity(options) {
    return JSON.stringify({
        cwd: projectDisplayPath(options.projectRoot, options.cwd),
        projectRootMarkers: options.config.projectRootMarkers,
        candidates: options.config.candidates,
        localCandidates: options.config.localCandidates,
        policy: {
            root: options.policy.root,
            file: options.policy.file,
            global: options.policy.global,
        },
        maxBytes: options.config.maxBytes,
        maxSourceBytes: options.config.maxSourceBytes,
    });
}
function directoryOfDisplayPath(displayPath) {
    const slash = displayPath.lastIndexOf('/');
    return slash === -1 ? '.' : displayPath.slice(0, slash);
}
function withCustomNotice(text, problem, projectRoot) {
    if (problem === null)
        return text;
    // `root` names the project root, not the workspace: a file can be inside the
    // workspace and still outside the chain this policy governs.
    const reason = problem.kind === 'outside'
        ? `is outside the project root (\`${projectRoot}\`)`
        : 'was not found';
    const notice = `<system-reminder>\nConfigured root instruction file \`${problem.file}\` ${reason}, so no root instructions were loaded.\n</system-reminder>`;
    return text === undefined ? notice : `${text}\n\n${notice}`;
}
/** Read the session policy, replaying the command log only when it grew. */
function currentPolicy(session, state, config) {
    const events = typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : [];
    if (state.policy === undefined || events.length !== state.policySeq) {
        state.policySeq = events.length;
        state.policy = replayPolicy(events, config.policy);
    }
    return state.policy;
}
/** Record the directories crossed since the last step, then forget the touches. */
function absorbTouchedDirs(state, cwd) {
    const dirs = new Set();
    for (const touched of state.touched) {
        for (const dir of descendantDirsBetween(cwd, touched)) {
            dirs.add(dir);
            state.knownDirs.add(dir);
        }
    }
    state.touched.clear();
    return dirs;
}
/** Compose the messages a step should enter with. */
async function compose(ctx, config, states, agent, signal, official) {
    if (config.maxBytes <= 0)
        return [];
    const workingDirectory = ctx.get('workingDirectory');
    if (workingDirectory === undefined)
        return [];
    const fileSystem = ctx.get('fs');
    const session = agent.session;
    let state = states.get(session);
    if (state === undefined) {
        state = createSessionState();
        states.set(session, state);
    }
    const policy = currentPolicy(session, state, config);
    const visible = syncVisibleInstructions(session, state);
    const effective = { ...config, policy };
    const cwd = await workingDirectory.ensure(agent, signal);
    const projectRoot = await findProjectRoot(cwd, config.projectRootMarkers, fileSystem, signal);
    const identity = baselineIdentity({ cwd, projectRoot, policy, config });
    const messages = [];
    if (visible.baselineIdentity !== identity) {
        const material = await loadBaselineMaterial(effective, visible, cwd, projectRoot, fileSystem, ctx.get('attachments'), signal, official);
        if (material !== undefined) {
            messages.push(buildBaselineMessage(material, policy, visible, identity, projectRoot));
        }
    }
    if (policy.nested) {
        // Only a nested toggle re-checks directories the current step did not touch.
        // Budget drops and compaction restore follow the shipped loader: they wait
        // for the directory to be touched again.
        const reenabled = state.nestedActive === false;
        messages.push(...await composeNested(effective, policy, state, visible, cwd, projectRoot, fileSystem, signal, reenabled));
        state.nestedActive = true;
    }
    else {
        absorbTouchedDirs(state, cwd);
        const removals = [...visible.loaded.keys()].filter(scope => !visible.baselineScopes.has(scope));
        const rendered = renderRemovals(removals, config.maxBytes);
        if (rendered !== undefined) {
            messages.push(createInstructionMessage(rendered.text, {
                ...sourceRecord(policy, projectRoot),
                changes: rendered.removed.map(path => ({ action: 'remove', scope: path, path })),
            }));
        }
        state.nestedActive = false;
    }
    return messages;
}
/** Discover and render the baseline under the current policy. */
async function loadBaselineMaterial(config, visible, cwd, projectRoot, fileSystem, attachments, signal, official) {
    const discovery = await discoverBaseline(config, cwd, projectRoot, fileSystem, signal, attachments);
    const rendered = renderBaseline(discovery.files, config.maxBytes, visible.baselineIdentity !== undefined, official);
    const body = withCustomNotice(rendered?.text, discovery.customProblem, projectRoot);
    if (body === undefined)
        return undefined;
    return { body, included: rendered?.included ?? [] };
}
/** Build a complete baseline message, recording every scope the text carries. */
function buildBaselineMessage(material, policy, visible, identity, projectRoot) {
    // Only the files the rendered text actually carries may be recorded: the budget
    // can drop a whole file, and claiming it would make the log (and the chip) say
    // the model saw instructions it never received.
    const nextScopes = new Set(material.included.map(file => file.displayPath));
    const changes = [];
    for (const scope of visible.baselineScopes) {
        if (nextScopes.has(scope))
            continue;
        changes.push({ action: 'remove', scope, path: visible.loaded.get(scope)?.path ?? scope });
    }
    for (const file of material.included) {
        changes.push({
            action: visible.loaded.has(file.displayPath) ? 'replace' : 'set',
            scope: file.displayPath,
            path: file.displayPath,
            digest: file.digest,
        });
    }
    return createInstructionMessage(material.body, {
        ...sourceRecord(policy, projectRoot),
        baseline: true,
        baselineIdentity: identity,
        changes,
    });
}
/** Compose nested additions, replacements, and removals for the directories in scope. */
async function composeNested(config, policy, state, visible, cwd, projectRoot, fileSystem, signal, includeKnownDirs) {
    const dirs = absorbTouchedDirs(state, cwd);
    if (includeKnownDirs)
        for (const dir of state.knownDirs)
            dirs.add(dir);
    if (dirs.size === 0)
        return [];
    const changes = [];
    const removals = [];
    for (const dir of [...dirs].sort()) {
        const displayDir = projectDisplayPath(projectRoot, dir);
        const files = await discoverScope(config, dir, projectRoot, fileSystem, signal);
        const present = new Set(files.map(file => file.displayPath));
        for (const scope of visible.loaded.keys()) {
            if (visible.baselineScopes.has(scope))
                continue;
            if (directoryOfDisplayPath(scope) !== displayDir || present.has(scope))
                continue;
            removals.push(scope);
        }
        for (const file of files) {
            const previous = visible.loaded.get(file.displayPath);
            if (previous?.digest === file.digest)
                continue;
            changes.push({ action: previous === undefined ? 'set' : 'replace', file });
        }
    }
    const messages = [];
    const source = sourceRecord(policy, projectRoot);
    const nested = renderNested(changes, config.maxBytes);
    if (nested !== undefined) {
        messages.push(createInstructionMessage(nested.text, {
            ...source,
            changes: nested.changes.map(change => ({
                action: change.action,
                scope: change.file.displayPath,
                path: change.file.displayPath,
                digest: change.file.digest,
            })),
        }));
    }
    const renderedRemovals = renderRemovals(removals, config.maxBytes);
    if (renderedRemovals !== undefined) {
        messages.push(createInstructionMessage(renderedRemovals.text, {
            ...source,
            changes: renderedRemovals.removed.map(path => ({ action: 'remove', scope: path, path })),
        }));
    }
    return messages;
}
/** Human-readable policy summary, with optional resolved session details. */
function describePolicy(policy, locked, details, m) {
    const rootValue = policy.root === 'custom'
        ? m.rootCustom(policy.file === null ? '' : displayFileValue(policy.file))
        : policy.root === 'off' ? m.rootOff : m.rootDefault;
    return [
        m.title,
        `${m.rootLabel}: ${rootValue}`,
        `${m.globalLabel}: ${policy.global ? m.on : m.off}`,
        `${m.nestedLabel}: ${policy.nested ? m.on : m.off}`,
        ...details,
        locked ? m.lockedNotice : m.changeHint,
    ].join('\n');
}
/**
 * Resolve the project root and the files the current policy loads.
 *
 * `/instructions show` is the only place that answers "which directory does
 * root mean" and "what is actually loaded", so the reader can see the project
 * root instead of inferring it from the label. The baseline render reports the
 * files the next baseline would carry; files already appended from subdirectories
 * are folded from the visible session log and listed with them.
 * @param ctx - plugin context carrying the working directory and filesystem.
 * @param config - resolved configuration.
 * @param policy - policy replayed for this session.
 * @param agent - agent whose session is read.
 * @param official - shipped renderer, when available.
 * @param m - command-result copy for the resolved locale.
 * @returns display lines, or none when the runtime cannot resolve them.
 */
async function describeSessionDetails(ctx, config, policy, agent, official, m) {
    const workingDirectory = ctx.get('workingDirectory');
    if (workingDirectory === undefined)
        return [];
    try {
        const cwd = await workingDirectory.ensure(agent);
        const fileSystem = ctx.get('fs');
        const projectRoot = await findProjectRoot(cwd, config.projectRootMarkers, fileSystem, undefined);
        const discovery = await discoverBaseline({ ...config, policy }, cwd, projectRoot, fileSystem, undefined, ctx.get('attachments'));
        const rendered = config.maxBytes <= 0
            ? undefined
            : renderBaseline(discovery.files, config.maxBytes, false, official);
        const included = rendered?.included ?? [];
        const includedPaths = new Set(included.map(file => file.displayPath));
        // Nested scopes are owned by the session log, not by fresh baseline discovery
        // below cwd. Include the ones the model currently sees so `files:` agrees
        // with the chip projection.
        const visible = scanVisibleInstructions(agent.session);
        const nestedLoaded = [...visible.loaded.keys()]
            .filter(scope => !visible.baselineScopes.has(scope) && !includedPaths.has(scope));
        const files = [...includedPaths, ...nestedLoaded];
        const lines = [m.projectRoot(projectRoot)];
        lines.push(m.files(files));
        if (config.maxBytes <= 0) {
            lines.push(m.budgetDisabled);
        }
        else {
            const excluded = discovery.files
                .filter(file => !includedPaths.has(file.displayPath))
                .map(file => file.displayPath);
            if (excluded.length > 0)
                lines.push(m.notLoaded(excluded));
        }
        if (discovery.customProblem !== null) {
            const kind = discovery.customProblem.kind === 'missing' ? m.problemMissing : m.problemOutside;
            lines.push(`${m.rootFileProblemLabel}: ${discovery.customProblem.file} (${kind})`);
        }
        return lines;
    }
    catch (error) {
        return [m.detailsUnavailable(error instanceof Error ? error.message : String(error))];
    }
}
/**
 * Validate one uploaded attachment and turn it into a replayable policy file.
 *
 * The file is not copied into the workspace: the policy names the durable
 * attachment, so discovery reads the stored bytes and a resumed session
 * re-derives the same policy from the command log.
 */
async function importAttachment(ctx, config, rest, m) {
    const ref = parseAttachArgs(rest);
    if (ref === undefined) {
        return { kind: 'error', text: m.usageAttach };
    }
    const attachments = ctx.get('attachments');
    if (attachments === undefined) {
        return { kind: 'error', text: m.importUnavailable };
    }
    const extension = ref.name.slice(ref.name.lastIndexOf('.')).toLowerCase();
    if (!['.md', '.markdown', '.txt'].includes(extension)) {
        return { kind: 'error', text: m.unsupportedType };
    }
    if (ref.bytes > config.maxSourceBytes) {
        return { kind: 'error', text: m.exceedsSource };
    }
    try {
        const chunks = [];
        let total = 0;
        for await (const chunk of attachments.readFileStream(ref)) {
            total += chunk.byteLength;
            if (total > config.maxSourceBytes) {
                return { kind: 'error', text: m.exceedsSource };
            }
            chunks.push(chunk);
        }
        if (total !== ref.bytes) {
            return { kind: 'error', text: m.lengthMismatch };
        }
        const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
        if (text.includes('\u0000')) {
            return { kind: 'error', text: m.notText };
        }
        if (text.trim().length === 0) {
            return { kind: 'error', text: m.empty };
        }
        return { kind: 'imported', file: encodeAttachmentFile(ref) };
    }
    catch (error) {
        return { kind: 'error', text: m.importFailed(error instanceof Error ? error.message : String(error)) };
    }
}
/** Handle one `/instructions` command. */
async function runInstructionsCommand(ctx, config, invocation, official) {
    // The command result is the only reader-facing text this plugin owns, so the
    // language follows the reader; model-visible frames stay English.
    const m = messagesFor(resolveCommandLocale(config.locale, { configEditor: ctx.get('configEditor') }));
    const session = invocation.agent.session;
    const events = typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : [];
    const current = replayPolicy(events, config.policy);
    // A turn or step already started: root/file/user-global are creation-time facts.
    const locked = events.some(event => event.type === 'turn/start' || event.type === 'step/start');
    const input = invocation.rawInput.trim();
    const [verb = '', ...rest] = input.split(/\s+/);
    const value = rest.join(' ');
    const commit = (next) => ({ kind: 'success', text: describePolicy(next, locked, [], m) });
    if (verb === '' || verb === 'show') {
        const details = await describeSessionDetails(ctx, config, current, invocation.agent, official, m);
        return { kind: 'success', text: describePolicy(current, locked, details, m) };
    }
    if (verb === 'nested') {
        if (value !== 'on' && value !== 'off')
            return { kind: 'error', text: m.usageNested };
        return commit({ ...current, nested: value === 'on' });
    }
    if (locked) {
        return { kind: 'error', text: m.lockedError };
    }
    if (verb === 'global') {
        if (value !== 'on' && value !== 'off')
            return { kind: 'error', text: m.usageGlobal };
        return commit({ ...current, global: value === 'on' });
    }
    if (verb === 'root') {
        if (value.startsWith('attach ')) {
            const imported = await importAttachment(ctx, config, value.slice('attach '.length).trim(), m);
            if (imported.kind !== 'imported')
                return imported;
            return commit({ ...current, root: 'custom', file: imported.file });
        }
        if (value === 'default')
            return commit({ ...current, root: 'default', file: null });
        if (value === 'off')
            return commit({ ...current, root: 'off', file: null });
        if (value.startsWith('custom ')) {
            const file = value.slice('custom '.length).trim();
            if (file.length === 0)
                return { kind: 'error', text: m.usageCustomRoot };
            return commit({ ...current, root: 'custom', file });
        }
        return { kind: 'error', text: m.usageRoot };
    }
    return { kind: 'error', text: m.usageShow };
}
/**
 * Install the policy loader.
 * @param ctx - plugin context.
 * @param raw - preset row configuration.
 * @param official - the running shipped loader, when its module was importable.
 * @throws when the row configuration cannot be used.
 */
export function apply(ctx, raw, official) {
    const config = resolveConfig(raw);
    const states = new WeakMap();
    const tails = new WeakMap();
    const serialize = (session, task) => {
        const previous = tails.get(session) ?? Promise.resolve();
        const next = previous.then(task, task);
        tails.set(session, next.then(() => undefined, () => undefined));
        return next;
    };
    ctx.on('tools/result', (exec, result) => {
        if (result.isError === true)
            return;
        if (!FILE_TOOLS.has(exec.name))
            return;
        const agent = exec.agent;
        if (agent === undefined)
            return;
        const path = filePathArgument(exec.arguments);
        if (path === undefined)
            return;
        let state = states.get(agent.session);
        if (state === undefined) {
            state = createSessionState();
            states.set(agent.session, state);
        }
        state.touched.add(path);
    });
    ctx.on('agent/pre-step', async (payload, next) => {
        const decision = await next();
        if (isReject(decision))
            return decision;
        // A first step with nothing to enter is a no-step turn: the shipped loader
        // keeps its context pending instead of turning the turn into a request.
        // Later steps still compose, so a compacted baseline is restored mid-turn.
        if (payload.step === 1 && decision.messages.length === 0)
            return decision;
        let messages;
        try {
            messages = await serialize(payload.agent.session, () => compose(ctx, config, states, payload.agent, payload.signal, official));
        }
        catch (error) {
            if (!payload.signal.aborted)
                ctx.logger.warn('instructions-policy: compose failed: %o', error);
            return decision;
        }
        if (messages.length === 0)
            return decision;
        const lastClaimed = decision.messages.findLastIndex(message => payload.messages.includes(message));
        const at = lastClaimed < 0 ? decision.messages.length : lastClaimed + 1;
        return { ...decision, messages: decision.messages.toSpliced(at, 0, ...messages) };
    });
    const commands = ctx.get('commands');
    if (commands !== undefined) {
        ctx.effect?.(() => commands.register({
            name: 'instructions',
            description: "Show or change this session's AGENTS.md policy",
            // Without an advertised input, DSH treats this as a bare command and
            // executes it as soon as the composer sees the token, so
            // `/instructions root off` never becomes arguments. The hint is also the
            // composer's placeholder after the claimed command chip.
            input: { hint: 'show | root default|off|custom <path> | global on|off | nested on|off' },
            handler: (invocation) => runInstructionsCommand(ctx, config, invocation, official),
        }));
    }
}
