import { isRecord } from "../pipeline/isRecord";
import { boundsKey } from "../../features/observe/output/resultOutput/hierarchy";
import { requiredOutputSchemaKeys } from "./responseArtifacts";
import type { FinalizeToolResponseContext } from "./contracts";

/**
 * Stateless reductions of an agent-facing success envelope. Unlike the
 * action-metadata compaction, they need no session, baseline store or output
 * flag: each one removes a field the client cannot act on, so it must hold for
 * every delivery mode (#18348).
 */

/**
 * Whether `payload` is a success the client will read, not an internal
 * tool-to-tool call (PlanExecutor reads the full payload) or a failure, which
 * keeps every diagnostic it carries.
 */
export function isAgentFacingSuccess(
  ctx: FinalizeToolResponseContext,
  payload: Record<string, unknown>,
  envelope: object,
): boolean {
  return (
    ctx.internal !== true &&
    payload.success !== false &&
    payload.error === undefined &&
    (envelope as { isError?: boolean }).isError !== true
  );
}

/**
 * Drop the per-command `timing` tree from an acquisition success (#11636, #18348).
 * The handler attaches it while `debug-perf` is on, and that feature flag is
 * persisted: one earlier `--debug-perf` run or `AUTOMOBILE_DEBUG_PERF=1` keeps it
 * on for every later daemon, so a handler-side gate alone does not keep the tree
 * out of a default client's response. `readiness.elapsedMs` carries the total.
 * Applies to tools declaring the `omitsAcquisitionTiming` trait.
 */
export function withoutAcquisitionTiming(
  ctx: FinalizeToolResponseContext,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  if (ctx.omitsAcquisitionTiming !== true || !("timing" in payload)) {
    return payload;
  }
  const next = { ...payload };
  delete next.timing;
  return next;
}

/**
 * Attributes that name a node. Everything else on a raw element (its `node`
 * subtree, `actions`, `hierarchyDepth`, focus/selection state, a regenerated
 * synthetic `view-id`) can differ between two reads of the same node.
 */
const ACTION_ELEMENT_IDENTITY_KEYS = [
  "class",
  "package",
  "resource-id",
  "test-tag",
  "text",
  "content-desc",
  "ios-accessibility-identifier",
  "ios-accessibility-label",
] as const;

/** A re-read can omit an attribute the other read reported as empty. */
function identityValue(value: unknown): unknown {
  return value === "" ? undefined : value;
}

/**
 * `element` and `selectedElement.matchedElement` are often the same node read
 * from captures moments apart, so a deep-equality test let both through
 * (#11637, #17464). Compare what names the node and where it is instead.
 */
export function isSameActionElement(element: unknown, matched: unknown): boolean {
  if (!isRecord(element) || !isRecord(matched)) {
    return false;
  }
  return (
    boundsKey(element.bounds) === boundsKey(matched.bounds) &&
    ACTION_ELEMENT_IDENTITY_KEYS.every(
      (key) => identityValue(element[key]) === identityValue(matched[key]),
    )
  );
}

/**
 * Drop `element` when it names the node `selectedElement.matchedElement` already
 * carries (#17464 item 3). A promoted tap target that is a different node keeps
 * `element`, and so does a tool whose output contract requires it.
 */
export function withoutDuplicateActionElement(
  payload: Record<string, unknown>,
  outputSchema: unknown,
): Record<string, unknown> {
  if (
    payload.element === undefined ||
    !isRecord(payload.selectedElement) ||
    !isSameActionElement(payload.element, payload.selectedElement.matchedElement) ||
    requiredOutputSchemaKeys(outputSchema).includes("element")
  ) {
    return payload;
  }
  const next = { ...payload };
  delete next.element;
  return next;
}

/**
 * Apply every stateless reduction to the payload delivered inline. Returns
 * `current` unchanged (possibly `undefined`, meaning "serve the original
 * envelope") when nothing was removed.
 */
export function reduceAgentFacingEnvelope(
  ctx: FinalizeToolResponseContext,
  payload: Record<string, unknown>,
  envelope: object,
  current: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!isAgentFacingSuccess(ctx, payload, envelope)) {
    return current;
  }
  const inline = current ?? payload;
  const reduced = withoutDuplicateActionElement(
    withoutAcquisitionTiming(ctx, inline),
    ctx.outputSchema,
  );
  return reduced === inline ? current : reduced;
}
