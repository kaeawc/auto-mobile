import { serverConfig } from "../utils/ServerConfig";

/**
 * Wire-boundary output policy for the `--tool-results-no-structured-content`
 * flag (issue #2899). When enabled, drops the `structuredContent` field from the
 * MCP tool-result envelope. Handlers pre-serialize the payload into
 * `content[0].text` alongside `structuredContent` (see
 * `createStructuredToolResponse`), so the two are byte-identical duplicates —
 * removing `structuredContent` halves the wire payload with no information loss.
 *
 * This is applied at the MCP CallTool serialization boundary, NOT inside a tool's
 * handler, and that placement is deliberate:
 *
 * - Internal callers that invoke a tool's handler directly (e.g.
 *   `DefaultUIStateSetup`'s `swipeOn` `found` detection) still receive
 *   `structuredContent` and keep working — the strip only affects what leaves the
 *   server toward the MCP client.
 * - It covers every tool regardless of registration path, including plain
 *   `register()` tools (`exportPlan`, `recordSteps`) that bypass
 *   `finalizeToolResponse`. That keeps the stripped set aligned with the
 *   `outputSchema` omitted from `tools/list` by `getToolDefinitions`, so the
 *   server never advertises structured output it will not return.
 *
 * Non-envelope, primitive, and already-`structuredContent`-free responses pass
 * through unchanged — a safe no-op.
 */
export function stripToolResultStructuredContent<T>(response: T): T {
  if (
    serverConfig.isToolResultsNoStructuredContentEnabled() &&
    response !== null &&
    typeof response === "object" &&
    "structuredContent" in (response as Record<string, unknown>)
  ) {
    delete (response as Record<string, unknown>).structuredContent;
  }
  return response;
}
