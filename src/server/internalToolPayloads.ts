import { ObserveToolPayload, SwipeOnToolPayload } from "../models";
import { StructuredToolResponse } from "../utils/toolUtils";

/**
 * Single source of truth mapping each internally-consumed tool name to its
 * concrete `structuredContent` payload type (issue #3222, follow-up to #2932 /
 * PR #3217).
 *
 * The registry stores every handler as `Promise<any>`; a fully generic registry
 * that threads a payload generic through all ~130 register sites is explicitly
 * out of scope. This map is the sanctioned smaller step: for the handful of
 * tools whose envelope is read *internally* (not just returned to the MCP
 * client), it lets `ToolRegistry.callInternalTyped(name, …)` resolve to the
 * concrete-payload envelope and lets `narrowInternalToolEnvelope` name the one
 * `any`→typed crossing at the in-flight pipeline read sites — so both replace
 * the earlier unchecked envelope cast.
 *
 * Keep each payload a *closed* type (no string index signature): `getStructuredField`
 * relies on `keyof TPayload` staying narrow to catch field typos at compile time.
 */
export interface InternalToolPayloads {
  swipeOn: SwipeOnToolPayload;
  observe: ObserveToolPayload;
}

/** A tool name whose envelope is read internally and mapped to a payload type. */
export type InternalToolName = keyof InternalToolPayloads;

/**
 * Runtime-validated narrowing of an in-flight pipeline response to the concrete
 * envelope for tool `name` (issue #3222). It backs both internal read paths:
 * the `DefaultAfterToolCallHandler` sites (which read the heterogeneous pipeline
 * result `any` directly, where no typed lookup is available) and
 * `ToolRegistry.callInternalTyped` (which narrows the `callInternal` result).
 * End-to-end typing without any runtime check would require the full generic
 * registry that is out of scope.
 *
 * Unlike the old identity cast, this validates the shape: a null/undefined,
 * non-object, or `structuredContent`-less value returns `undefined` rather than
 * a mistyped envelope. That preserves the read sites' existing behavior —
 * `getStructuredField` already yields `undefined` for those cases — while giving
 * the `any`→typed crossing a single checked home. The `name` argument selects
 * the payload type via {@link InternalToolPayloads}; it is intentionally unused
 * at runtime (the payloads share the envelope shape).
 */
export const narrowInternalToolEnvelope = <K extends InternalToolName>(
  _name: K,
  response: unknown,
): StructuredToolResponse<InternalToolPayloads[K]> | undefined => {
  if (!response || typeof response !== "object") {
    return undefined;
  }
  const structuredContent = (response as { structuredContent?: unknown }).structuredContent;
  if (!structuredContent || typeof structuredContent !== "object") {
    return undefined;
  }
  return response as StructuredToolResponse<InternalToolPayloads[K]>;
};
