/**
 * Shared marker for internal tool-to-tool calls (issues #3053 / #3087).
 *
 * Some tools invoke the *wrapped* `tool.handler` (the one that runs
 * `finalizeToolResponse`) on behalf of an internal caller rather than the agent —
 * PlanExecutor steps, and the navigation/setup replays in
 * `DefaultUIStateSetup` / `NavigateTo`. Under `--actions-diff-observe` /
 * `--actions-no-observe` those calls would otherwise be diffed or stripped and,
 * worse, would advance the agent-facing diff baseline
 * (`SessionCacheData.lastRenderedObservation`) with an observation the agent never
 * saw. Marking the call opts it out: finalize emits the full sanitized
 * observation and never touches the baseline.
 *
 * The wrapped handler reads `INTERNAL_NO_DIFF_PARAM` off its args at entry (see
 * `toolRegistry.registerDeviceAware`), and `McpCallRecorder.INTERNAL_PARAMS`
 * strips it from recordings. Both reference this constant so the literal has a
 * single source of truth.
 */
export const INTERNAL_NO_DIFF_PARAM = "__internalNoDiff";

/**
 * Return a shallow copy of `args` marked as an internal tool-to-tool call. Every
 * internal wrapped-handler invocation should route its args through this helper
 * so the opt-in is uniform and the per-call-site footgun (forgetting the marker,
 * or mis-typing the key) is removed.
 *
 * Non-mutating on purpose: navigation replays reuse a nav-graph edge's stored
 * `interaction.args`, so setting the marker in place would permanently taint
 * shared graph state. Returning a copy keeps the caller's object untouched.
 */
export function markInternalToolCall<T extends Record<string, unknown>>(
  args: T
): T & { [INTERNAL_NO_DIFF_PARAM]: true } {
  return { ...args, [INTERNAL_NO_DIFF_PARAM]: true };
}
