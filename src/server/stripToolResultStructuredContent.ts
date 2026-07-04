import { serverConfig } from "../utils/ServerConfig";

/**
 * Wire-boundary policy for the duplicated `structuredContent` tree on MCP
 * tool-result envelopes. Handlers pre-serialize the payload into
 * `content[0].text` alongside `structuredContent` (see
 * `createStructuredToolResponse`), so the two are byte-identical duplicates —
 * dropping `structuredContent` halves the wire payload with no information loss.
 *
 * `structuredContent` is dropped when EITHER (issue #2899 + #2759):
 * - the tool declares no `outputSchema` — per MCP (2025-06-18) `structuredContent`
 *   is only meaningful for a tool that advertises an `outputSchema`, so it is
 *   pure duplication for no-schema tools (`observe`, the largest payload, is one)
 *   and is dropped **unconditionally**; or
 * - the `--tool-results-no-structured-content` flag is set — which also drops it
 *   for schema tools (and `getToolDefinitions` drops their `outputSchema`
 *   advertisement under the same flag, so the server never advertises structured
 *   output it will not return).
 *
 * Equivalently, `structuredContent` is kept only for a schema tool while the flag
 * is off.
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
 *   `finalizeToolResponse`.
 *
 * Non-envelope, primitive, and already-`structuredContent`-free responses pass
 * through unchanged — a safe no-op.
 *
 * @param response        The MCP tool-call envelope (or anything envelope-shaped).
 * @param hasOutputSchema Whether the tool declares an `outputSchema`
 *                        (`toolHasOutputSchema(tool)` at the call site).
 */
export function stripToolResultStructuredContent<T>(response: T, hasOutputSchema: boolean): T {
  const shouldStrip = !hasOutputSchema || serverConfig.isToolResultsNoStructuredContentEnabled();
  if (
    shouldStrip &&
    response !== null &&
    typeof response === "object" &&
    "structuredContent" in (response as Record<string, unknown>)
  ) {
    delete (response as Record<string, unknown>).structuredContent;
  }
  return response;
}
