/**
 * Session-scoped policy derived from the command log.
 *
 * A `/instructions` run is already a durable `command/run` / `command/done`
 * pair, so the policy is replayed from those declared events instead of a
 * private record: no undeclared event type ever enters the session log, and a
 * resumed session rebuilds the same policy.
 *
 * @module dsh-instructions-policy/policy
 */
import { encodeAttachmentFile, parseAttachArgs } from "./toolkit.js";
/** Command name owned by this plugin. */
export const INSTRUCTIONS_COMMAND = 'instructions';
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/**
 * Apply one `/instructions` argument string to a policy.
 * @param policy - policy before this invocation.
 * @param args - raw input after the command name.
 * @returns the next policy, or undefined when the line changes nothing.
 */
export function applyInstructionsArgs(policy, args) {
    const input = (args ?? '').trim();
    if (input.length === 0)
        return undefined;
    const [verb = '', ...rest] = input.split(/\s+/);
    const value = rest.join(' ');
    if (verb === 'show')
        return undefined;
    if (verb === 'nested') {
        if (value !== 'on' && value !== 'off')
            return undefined;
        return { ...policy, nested: value === 'on' };
    }
    if (verb === 'global') {
        if (value !== 'on' && value !== 'off')
            return undefined;
        return { ...policy, global: value === 'on' };
    }
    if (verb === 'root') {
        if (value.startsWith('attach ')) {
            const ref = parseAttachArgs(value.slice('attach '.length));
            if (ref === undefined)
                return undefined;
            return { ...policy, root: 'custom', file: encodeAttachmentFile(ref) };
        }
        if (value === 'default')
            return { ...policy, root: 'default', file: null };
        if (value === 'off')
            return { ...policy, root: 'off', file: null };
        if (value.startsWith('custom ')) {
            const file = value.slice('custom '.length).trim();
            if (file.length === 0)
                return undefined;
            return { ...policy, root: 'custom', file };
        }
    }
    return undefined;
}
/**
 * Replay successful `/instructions` runs recorded in one session log.
 * @param events - complete event log in sequence order.
 * @param base - policy defaults when no successful run exists.
 * @returns the replayed policy.
 */
export function replayPolicy(events, base) {
    let policy = { ...base };
    const pending = new Map();
    for (const event of events) {
        if (event.type === 'command/run') {
            const data = isRecord(event.data) ? event.data : undefined;
            if (data !== undefined
                && data['name'] === INSTRUCTIONS_COMMAND
                && typeof data['commandId'] === 'string') {
                pending.set(data['commandId'], typeof data['args'] === 'string' ? data['args'] : undefined);
            }
            continue;
        }
        if (event.type !== 'command/done')
            continue;
        const data = isRecord(event.data) ? event.data : undefined;
        if (data === undefined || data['kind'] !== 'success')
            continue;
        const id = data['commandId'];
        if (typeof id !== 'string' || !pending.has(id))
            continue;
        const args = pending.get(id);
        pending.delete(id);
        const next = applyInstructionsArgs(policy, args);
        if (next !== undefined)
            policy = next;
    }
    return policy;
}
