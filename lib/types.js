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
export {};
