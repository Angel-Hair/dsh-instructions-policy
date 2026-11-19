/**
 * Model-facing rendering.
 *
 * When the running shipped loader is importable its renderer produces the
 * baseline verbatim, so the prompt format always matches the installed version.
 * The built-in fallback mirrors the shipped 0.2.x framing: one budget over the
 * complete baseline message, broader files dropped before the most specific
 * file is truncated, and a visible budget notice naming what changed.
 *
 * Every renderer reports what the text actually carries, not what discovery
 * found: a budget can omit a whole file, and the caller must not record an
 * instruction the model never saw.
 *
 * @module dsh-instructions-policy/render
 */
import { byteLength, escapeClosingTag, truncateUtf8 } from "./toolkit.js";
const FRAME_OPEN = '<system-reminder>';
const FRAME_CLOSE = '</system-reminder>';
const INTRO = 'The following workspace instructions may be relevant to your work. '
    + 'Use them as guidance when applicable. More specific instructions take precedence over broader ones. '
    + 'They do not override system, developer, or direct user instructions.';
const REPLACEMENT_INTRO = 'This complete workspace instruction baseline replaces all earlier workspace instruction baselines. '
    + INTRO;
const EMPTY_REPLACEMENT = 'This complete workspace instruction baseline replaces all earlier workspace instruction baselines. '
    + 'No workspace instructions are currently active.';
const ADDITIONAL_GUIDANCE = 'Use them as guidance when relevant; more specific instructions take precedence. '
    + 'They do not override system, developer, or direct user instructions.';
function sectionText(file) {
    return `Instructions from: ${file.displayPath}\n\n${escapeClosingTag(file.content)}`;
}
function frame(sections) {
    return [FRAME_OPEN, ...sections, FRAME_CLOSE].join('\n\n');
}
function budgetNotice(maxBytes, omitted, truncation) {
    if (omitted.length === 0 && truncation === null)
        return undefined;
    const parts = [];
    if (omitted.length > 0)
        parts.push(`omitted ${omitted.join(', ')}`);
    if (truncation !== null) {
        parts.push(`truncated ${truncation.displayPath} from ${truncation.originalBytes} to ${truncation.includedBytes} bytes`);
    }
    return `Workspace instruction budget ${maxBytes} bytes: ${parts.join('; ')}`;
}
function buildBaselineText(options) {
    const notice = budgetNotice(options.maxBytes, options.omitted, options.truncation);
    const sections = [
        ...notice === undefined ? [] : [notice],
        options.intro,
        ...options.files.map(sectionText),
    ];
    return frame(sections);
}
/**
 * Render one bounded frame: the budget notice naming what was dropped, then the
 * surviving sections.
 * @param maxBytes - budget for the complete frame.
 * @param sections - rendered section bodies in order.
 * @param omitted - display paths dropped to fit.
 * @param truncation - the one file whose content was cut, when any.
 * @returns the frame, or undefined when it cannot fit.
 */
function frameWithin(maxBytes, sections, omitted, truncation) {
    const notice = budgetNotice(maxBytes, omitted, truncation);
    const text = frame([...notice === undefined ? [] : [notice], ...sections]);
    return byteLength(text) <= maxBytes ? text : undefined;
}
/** Render the baseline without the shipped renderer. */
function fallbackBaseline(files, maxBytes, replacePreviousBaseline) {
    const ordered = [
        ...files.filter(file => file.chain === 'global'),
        ...files.filter(file => file.chain === 'project'),
    ];
    if (ordered.length === 0) {
        return replacePreviousBaseline ? { text: frame([EMPTY_REPLACEMENT]), included: [] } : undefined;
    }
    const intro = replacePreviousBaseline ? REPLACEMENT_INTRO : INTRO;
    for (let start = 0; start < ordered.length; start += 1) {
        const included = ordered.slice(start);
        const text = buildBaselineText({
            intro,
            maxBytes,
            files: included,
            omitted: ordered.slice(0, start).map(file => file.displayPath),
            truncation: null,
        });
        if (byteLength(text) <= maxBytes)
            return { text, included };
    }
    const mostSpecific = ordered[ordered.length - 1];
    if (mostSpecific === undefined)
        return undefined;
    const omitted = ordered.slice(0, -1).map(file => file.displayPath);
    const originalBytes = byteLength(mostSpecific.content);
    let best;
    let low = 0;
    let high = originalBytes;
    while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        const content = truncateUtf8(mostSpecific.content, middle);
        const includedBytes = byteLength(content);
        const text = buildBaselineText({
            intro,
            maxBytes,
            files: [{ ...mostSpecific, content }],
            omitted,
            truncation: { displayPath: mostSpecific.displayPath, originalBytes, includedBytes },
        });
        if (byteLength(text) <= maxBytes) {
            best = { text, includedBytes };
            low = middle + 1;
        }
        else {
            high = middle - 1;
        }
    }
    if (best === undefined)
        return undefined;
    // The heading alone carries no instruction content: report the file as omitted
    // rather than claim the model received it.
    return { text: best.text, included: best.includedBytes > 0 ? [mostSpecific] : [] };
}
/**
 * Render the baseline instruction set.
 * @param files - discovered files in broad-to-specific order.
 * @param maxBytes - budget for the complete rendered baseline.
 * @param replacePreviousBaseline - whether this baseline replaces an earlier one.
 * @param official - the running shipped renderer, when available.
 * @returns rendered text plus the files it carries, or undefined when there is nothing to say.
 */
export function renderBaseline(files, maxBytes, replacePreviousBaseline, official) {
    // The shipped renderer frames the intro even when no file was discovered, so a
    // baseline with nothing in it stays silent here instead of teaching an empty
    // frame; an explicit replacement still reports that no instructions remain.
    if (files.length === 0 && !replacePreviousBaseline)
        return undefined;
    const inherited = official?.renderAgentInstructions;
    if (typeof inherited === 'function') {
        const rendered = inherited(files.map(file => ({
            absolutePath: file.absolutePath,
            displayPath: file.displayPath,
            content: file.content,
        })), {
            maxBytes,
            ...replacePreviousBaseline ? { replacePreviousBaseline: true } : {},
        });
        if (rendered.text.length === 0)
            return undefined;
        const dropped = new Set();
        const drop = (displayPath, absolutePath) => {
            if (displayPath !== undefined)
                dropped.add(displayPath);
            if (absolutePath !== undefined)
                dropped.add(absolutePath);
        };
        for (const file of rendered.omitted ?? [])
            drop(file.displayPath, file.absolutePath);
        // A truncation that keeps zero content leaves only the heading and the budget
        // notice; like the shipped loader, do not claim the model received the file.
        for (const file of rendered.truncated ?? []) {
            if (file.includedBytes === 0 && file.originalBytes > 0)
                drop(file.displayPath, undefined);
        }
        return {
            text: rendered.text,
            included: files.filter(file => !dropped.has(file.displayPath) && !dropped.has(file.absolutePath)),
        };
    }
    return fallbackBaseline(files, maxBytes, replacePreviousBaseline);
}
/** Model-facing applicability sentence for a project directory. */
function applicability(displayPath) {
    const slash = displayPath.lastIndexOf('/');
    const directory = slash === -1 ? '.' : displayPath.slice(0, slash);
    return directory === '.'
        ? `These instructions apply to work under the project root. ${ADDITIONAL_GUIDANCE}`
        : `These instructions apply to work under \`${directory}\`. ${ADDITIONAL_GUIDANCE}`;
}
function nestedSection(change) {
    const file = change.file;
    if (change.action === 'replace') {
        return [
            `Updated instructions from: ${file.displayPath}`,
            '',
            'This file changed after it was loaded. Use the following content instead of the previously loaded instructions from this file.',
            '',
            escapeClosingTag(file.content),
        ].join('\n');
    }
    return [
        `Additional instructions from: ${file.displayPath}`,
        '',
        applicability(file.displayPath),
        '',
        escapeClosingTag(file.content),
    ].join('\n');
}
/**
 * Render one batch of nested additions, bounded by the byte budget.
 *
 * Precedence matches the baseline: broader transitions are dropped first and
 * the most specific one may be truncated, so a large file still reaches the
 * model instead of disappearing. Only the transitions the text carries are
 * returned for recording.
 * @param changes - ordered transitions to render.
 * @param maxBytes - budget for the complete batch.
 * @returns the framed text and its represented transitions, or undefined when nothing fits.
 */
export function renderNested(changes, maxBytes) {
    if (changes.length === 0)
        return undefined;
    const sections = changes.map(change => nestedSection(change));
    for (let start = 0; start < changes.length; start += 1) {
        const text = frameWithin(maxBytes, sections.slice(start), changes.slice(0, start).map(change => change.file.displayPath), null);
        if (text !== undefined)
            return { text, changes: changes.slice(start) };
    }
    const last = changes[changes.length - 1];
    if (last === undefined)
        return undefined;
    const omitted = changes.slice(0, -1).map(change => change.file.displayPath);
    const originalBytes = byteLength(last.file.content);
    let best;
    let low = 0;
    let high = originalBytes;
    while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        const content = truncateUtf8(last.file.content, middle);
        const includedBytes = byteLength(content);
        const text = frameWithin(maxBytes, [nestedSection({ action: last.action, file: { ...last.file, content } })], omitted, { displayPath: last.file.displayPath, originalBytes, includedBytes });
        if (text !== undefined) {
            best = { text, includedBytes };
            low = middle + 1;
        }
        else {
            high = middle - 1;
        }
    }
    // A heading with no surviving content is a budget notice, not the instruction.
    if (best === undefined || best.includedBytes === 0)
        return undefined;
    return { text: best.text, changes: [last] };
}
function removalSection(displayPath) {
    return [
        `Instructions removed: ${displayPath}`,
        '',
        'The previously loaded instructions from this file no longer apply.',
    ].join('\n');
}
/** Notice for removals the budget could not spell out one by one. */
function removalRemainder(rest) {
    return `Instructions removed: ${rest} more file${rest === 1 ? '' : 's'} omitted to fit the configured byte budget.`;
}
/**
 * Render removal notices for instructions that no longer apply.
 *
 * The batch is bounded like every other message. Paths that do not fit are left
 * out of `removed`, so the fold keeps them visible and reports them again on a
 * later step instead of silently dropping the notice.
 * @param displayPaths - model-facing paths to retract.
 * @param maxBytes - budget for the complete notice.
 * @returns the framed notice and the paths it names, or undefined when nothing fits.
 */
export function renderRemovals(displayPaths, maxBytes) {
    if (displayPaths.length === 0)
        return undefined;
    const sections = displayPaths.map(removalSection);
    for (let keep = sections.length; keep > 0; keep -= 1) {
        const rest = sections.length - keep;
        const body = [
            ...sections.slice(0, keep),
            ...rest === 0 ? [] : [removalRemainder(rest)],
        ];
        const text = frame(body);
        if (byteLength(text) <= maxBytes)
            return { text, removed: displayPaths.slice(0, keep) };
    }
    return undefined;
}
