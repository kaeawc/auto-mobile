import { serverConfig } from "../utils/ServerConfig";

/**
 * Why `structuredContent` is intentionally omitted for a tool result:
 * - `"no-schema"` — the tool declares no `outputSchema`, so `structuredContent`
 *   is dropped unconditionally (#2759).
 * - `"flag"` — a schema tool stripped because the
 *   `--tool-results-no-structured-content` flag is on (#2899).
 */
export type StructuredContentOmissionReason = "no-schema" | "flag";

/**
 * Single source of truth for the wire-boundary omission decision (issue #2962).
 * Returns the reason `structuredContent` is intentionally omitted, or `null` when
 * it is retained (a schema tool with the flag off). Both the strip
 * (`stripToolResultStructuredContent`) and the `index.ts` debug trace consume this
 * one decision, so a stripped-vs-accidentally-missing `structuredContent` is
 * distinguishable in the field.
 *
 * `"no-schema"` takes precedence over `"flag"`: a no-schema tool is stripped
 * unconditionally regardless of the flag, so its omission reason is always
 * `"no-schema"`. Equivalent to the pre-#2962 `!hasOutputSchema || flag` gate.
 *
 * @param hasOutputSchema Whether the tool declares an `outputSchema`.
 * @param flagEnabled     The `--tool-results-no-structured-content` flag state;
 *                        defaults to the live `serverConfig` value.
 */
export function structuredContentOmissionReason(
  hasOutputSchema: boolean,
  flagEnabled: boolean = serverConfig.isToolResultsNoStructuredContentEnabled(),
): StructuredContentOmissionReason | null {
  if (!hasOutputSchema) {
    return "no-schema";
  }
  if (flagEnabled) {
    return "flag";
  }
  return null;
}

/**
 * True when `response` is an MCP tool-call envelope that actually carries a
 * `structuredContent` tree — i.e. stripping it would remove something.
 * Non-envelope, primitive, `null`, and already-`structuredContent`-free responses
 * are false. Shared by the strip and the `index.ts` debug trace so the trace only
 * fires when a field was really dropped (not merely because the policy would).
 */
export function responseCarriesStructuredContent(response: unknown): boolean {
  return (
    response !== null &&
    typeof response === "object" &&
    "structuredContent" in (response as Record<string, unknown>)
  );
}

/**
 * Wire-boundary policy for the duplicated `structuredContent` tree on MCP
 * tool-result envelopes. Handlers pre-serialize the payload into
 * `content[0].text` alongside `structuredContent` (see
 * `createStructuredToolResponse`), so the two are byte-identical duplicates —
 * dropping `structuredContent` halves the wire payload with no information loss.
 *
 * The omission decision is pre-resolved by `structuredContentOmissionReason` and
 * passed in as `reason` (issue #2962), rather than re-derived here, so the strip
 * and the `index.ts` debug trace share a single evaluation of the policy:
 * - any reason (`"no-schema"` #2759, `"flag"` #2899) → drop `structuredContent`;
 * - `null` → retain it (a schema tool with the flag off).
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
 * @param response The MCP tool-call envelope (or anything envelope-shaped).
 * @param reason   The pre-resolved omission reason from
 *                 `structuredContentOmissionReason(...)`; `null` retains the field.
 */
export function stripToolResultStructuredContent<T>(
  response: T,
  reason: StructuredContentOmissionReason | null,
): T {
  if (reason !== null && responseCarriesStructuredContent(response)) {
    delete (response as Record<string, unknown>).structuredContent;
  }
  return response;
}
