import { z } from "zod/v4";
import { ToolResponseSerialization } from "../ToolResponseSerialization";
import { boundStructuredField, truncateBodyText } from "../../utils/truncateBodyText";
import { logger } from "../../utils/logger";
import { errorMessage } from "../../utils/describeUnknownError";
import { isDeviceSessionAcquisitionTool } from "../../daemon/deviceSessionResult";
import { isRecord } from "../pipeline/isRecord";
import { resolveObserveProjection, type FinalizationState } from "./observationRendering";
import type {
  FinalizeToolResponseContext,
  ObservationArtifactMetadata,
  ObservationArtifactMode,
  ObservationArtifactPayload,
} from "./contracts";

export const DEFAULT_OBSERVATION_INLINE_MAX_BYTES = 64 * 1024;

const OBSERVE_WAIT_METADATA_KEYS = [
  "awaitedElement",
  "awaitDuration",
  "awaitTimeout",
  "matched",
  "settled",
  "timedOut",
  "timeoutReason",
  "polls",
  "waitMs",
  "matchedElement",
  "candidates",
] as const;

export function artifactRenderedPayload(
  state: FinalizationState,
  hasStructured: boolean,
  serialization: ToolResponseSerialization,
) {
  const { ctx, payload, isObserveTool, hasArtifactableObservation } = state;
  let { sanitizedPayload } = state;

  if (
    ctx.artifactWriter &&
    !ctx.internal &&
    hasArtifactableObservation &&
    sanitizedPayload &&
    shouldArtifactObservationPayload(ctx, sanitizedPayload, hasStructured, serialization)
  ) {
    if (isObserveTool) {
      // Keep compact wait status inline: without it, an artifacted `observe`
      // response hides whether the requested condition matched or timed out.
      sanitizedPayload = {
        ...pickObserveWaitMetadata(sanitizedPayload),
        ...writeObservationArtifact(ctx, sanitizedPayload),
      };
    } else {
      const inlinePayload = sanitizedPayload;
      const observation = inlinePayload.observation;
      sanitizedPayload = artifactWriteOrInline(
        ctx,
        "observation",
        () => ({
          ...inlinePayload,
          observation:
            isObserveDiff(observation) && resolveObserveProjection(ctx.args) !== "full"
              ? writeObserveDiffBodyArtifact(ctx, observation)
              : writeObservationArtifact(ctx, observation),
        }),
        inlinePayload,
      );
    }
  }

  if (artifactMode(ctx) === "always") {
    sanitizedPayload ??= artifactWriteOrInline(
      ctx,
      "response",
      () => artifactNonObservationPayload(ctx, payload),
      undefined,
    );
  }

  return sanitizedPayload;
}

/**
 * @param rendering.hasStructured - Whether the response carries structuredContent.
 * @param rendering.serialization - How the inline payload is serialized for the size check.
 */
export function boundRenderedPayload(
  ctx: FinalizeToolResponseContext,
  payload: Record<string, unknown>,
  sanitizedPayload: Record<string, unknown> | undefined,
  {
    hasStructured,
    serialization,
  }: { hasStructured: boolean; serialization: ToolResponseSerialization },
) {
  // Hard ceiling (issue #6870). Spilling `observation` bounds only the
  // observation: `observationDiff` rides at the TOP level beside it, and so does
  // every other tool field, so a response could still be handed to the client
  // far over the inline limit — which a one-shot `--cli` transport then cut
  // mid-string into unparseable JSON. With a writer available, spill whatever
  // residue is still oversized and keep only the headline fields inline, so the
  // client always gets complete, parseable JSON plus a pointer to the rest.
  // A caller that passes `resourceLink: true` asks for that spill (and its
  // resource_link block) at any size (#13942).
  const boundedCandidate = sanitizedPayload ?? payload;
  if (
    ctx.artifactWriter &&
    !ctx.internal &&
    (ctx.args?.resourceLink === true ||
      exceedsInlineLimit(boundedCandidate, hasStructured, serialization))
  ) {
    try {
      sanitizedPayload = spillOversizedPayload(ctx, boundedCandidate, hasStructured, serialization);
    } catch (error) {
      // The operation itself already succeeded; only the spill failed (a full or
      // read-only tool-output directory). Throwing here would return NO result
      // for work the device has already done, which for a side-effecting tool
      // invites a duplicate retry. Fall back to the pre-#6870 behaviour — serve
      // the payload un-spilled — and leave a trace, since the response then
      // exceeds the ceiling. The `--cli` renderer still refuses to cut JSON
      // mid-string and emits its own truncation notice instead.
      logger.warn(
        `finalizeToolResponse: could not spill the oversized ${ctx.name} response: ${errorMessage(error)}`,
        error,
      );
    }
  }
  return sanitizedPayload;
}

/**
 * Run an artifact write whose failure must not erase a completed action (#10080).
 *
 * For a tool that can mutate the device the action has already run, so throwing
 * here would return `isError` for work that happened and invite a duplicate retry
 * (the same rule the hard-ceiling spill follows, #6870). On failure warn and serve
 * `inline` instead. Read-only tools keep the loud failure.
 */
function artifactWriteOrInline<T>(
  ctx: FinalizeToolResponseContext,
  what: string,
  write: () => T,
  inline: T,
): T {
  if (ctx.loudArtifactWrites === true) {
    return write();
  }
  try {
    return write();
  } catch (error) {
    logger.warn(
      `finalizeToolResponse: could not write the ${what} artifact for ${ctx.name}; serving it inline: ${errorMessage(error)}`,
      error,
    );
    return inline;
  }
}

function pickObserveWaitMetadata(payload: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    OBSERVE_WAIT_METADATA_KEYS.filter((key) => payload[key] !== undefined).map((key) => [
      key,
      payload[key],
    ]),
  );
}

/**
 * The fields kept inline when an oversized residue is spilled wholesale (#6870).
 *
 * A client that gets only an artifact pointer still has to know whether the tool
 * succeeded and, if not, why — reading the spilled file to learn that a tap
 * failed would be a worse contract than the oversized payload it replaced.
 */
const INLINE_RESIDUE_KEYS = ["success", "error", ...OBSERVE_WAIT_METADATA_KEYS] as const;
const DEVICE_SESSION_RESIDUE_KEYS = ["sessionUuid", "sessionId"] as const;

/**
 * Per-field cap on what a retained residue field may contribute (#6870).
 *
 * The retained fields are headlines, not payloads, but nothing stops one of them
 * from being huge on its own: a stack trace lands in `error`, and a `countStable`
 * wait that never matched returns every candidate it saw. Copying such a field
 * back verbatim would blow the very ceiling the spill exists to enforce. At
 * {@link INLINE_RESIDUE_KEYS}.length plus the two device-session fields caps the
 * largest acquisition residue at ~48 KB,
 * comfortably inside {@link DEFAULT_OBSERVATION_INLINE_MAX_BYTES} once the
 * artifact envelope is added.
 */
const INLINE_RESIDUE_FIELD_LIMIT = 4 * 1024;

/**
 * Keep the headline fields inline, each bounded: an oversized string is cut to
 * the cap (still a string, so `error` stays readable), and an oversized
 * structure is replaced with the canonical `{ _truncated, bytes }` marker. The
 * complete value is always in the artifact the caller writes alongside this.
 */
function pickInlineResidue(
  ctx: FinalizeToolResponseContext,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const requiredArrayKeys = new Set(requiredOutputSchemaArrayKeys(ctx.outputSchema));
  return Object.fromEntries(
    inlineResidueKeys(ctx)
      .filter((key) => payload[key] !== undefined)
      .map((key) => [key, boundResidueField(payload[key], requiredArrayKeys.has(key))]),
  );
}

/**
 * Replace an over-ceiling payload with its artifact pointer plus a bounded
 * residue of the headline fields.
 */
function spillOversizedPayload(
  ctx: FinalizeToolResponseContext,
  payload: Record<string, unknown>,
  hasStructured: boolean,
  serialization: ToolResponseSerialization,
): Record<string, unknown> {
  // The request-local writer shares the complete rendering with the size probe.
  const artifact = writeJsonArtifact(ctx, "ToolResponse", payload);
  const spilled = { ...pickInlineResidue(ctx, payload), ...artifact };
  // The per-field cap is counted in UTF-16 code units, so multi-byte text can
  // still serialize past the ceiling across every retained field. Fall back to
  // markers-only, whose size does not depend on the input at all.
  return exceedsInlineLimit(spilled, hasStructured, serialization)
    ? { ...markerResidue(ctx, payload), ...artifact }
    : spilled;
}

function inlineResidueKeys(ctx: FinalizeToolResponseContext): readonly string[] {
  const fixedKeys = isDeviceSessionAcquisitionTool(ctx.name)
    ? [...INLINE_RESIDUE_KEYS, ...DEVICE_SESSION_RESIDUE_KEYS]
    : INLINE_RESIDUE_KEYS;
  return [...new Set([...fixedKeys, ...requiredOutputSchemaKeys(ctx.outputSchema)])];
}

/**
 * Finds required top-level fields on an output Zod object without treating an
 * absent or non-object schema as an error. Zod v4 keeps `.passthrough()` and
 * refinements on ZodObject itself; pipes and transparent wrappers may instead
 * expose their output or unwrapped schema separately.
 */
export function requiredOutputSchemaKeys(schema: unknown): readonly string[] {
  const objectSchema = unwrapOutputObjectSchema(schema);
  if (!objectSchema) {
    return [];
  }
  return Object.entries(objectSchema.shape)
    .filter(([, fieldSchema]) => !fieldSchema.isOptional())
    .map(([key]) => key);
}

/** Required output fields whose declared value is an array. */
function requiredOutputSchemaArrayKeys(schema: unknown): readonly string[] {
  const objectSchema = unwrapOutputObjectSchema(schema);
  if (!objectSchema) {
    return [];
  }
  return Object.entries(objectSchema.shape)
    .filter(([, fieldSchema]) => !fieldSchema.isOptional() && fieldSchema instanceof z.ZodArray)
    .map(([key]) => key);
}

function unwrapOutputObjectSchema(schema: unknown): z.ZodObject | undefined {
  let candidate = schema;
  const seen = new Set<unknown>();
  while (candidate && typeof candidate === "object" && !seen.has(candidate)) {
    seen.add(candidate);
    if (candidate instanceof z.ZodObject) {
      return candidate;
    }
    if (candidate instanceof z.ZodPipe) {
      candidate = candidate.out;
      continue;
    }
    const unwrap = (candidate as { unwrap?: unknown }).unwrap;
    candidate = typeof unwrap === "function" ? unwrap.call(candidate) : undefined;
  }
  return undefined;
}

/**
 * The last-resort residue: non-scalar fields are replaced with the
 * `{ _truncated, bytes }` marker, except arrays become empty arrays to retain
 * their declared schema shape. The inline size is therefore a fixed function of
 * the field COUNT rather than of the payload. Scalars (a `success` boolean, a
 * `polls` count) are the headline a client actually acts on and are always tiny.
 */
function markerResidue(
  ctx: FinalizeToolResponseContext,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    inlineResidueKeys(ctx)
      .filter((key) => payload[key] !== undefined)
      .map((key) => [
        key,
        Array.isArray(payload[key])
          ? []
          : typeof payload[key] === "object" || typeof payload[key] === "string"
            ? boundStructuredField(payload[key], false, 0)
            : payload[key],
      ]),
  );
}

function boundResidueField(value: unknown, preserveArrayShape: boolean = false): unknown {
  if (typeof value === "string") {
    return value.length <= INLINE_RESIDUE_FIELD_LIMIT
      ? value
      : `${truncateBodyText(value, INLINE_RESIDUE_FIELD_LIMIT)}${RESIDUE_TRUNCATION_SUFFIX}`;
  }
  if (preserveArrayShape && Array.isArray(value)) {
    return boundResidueArray(value);
  }
  return boundStructuredField(value, false, INLINE_RESIDUE_FIELD_LIMIT);
}

function boundResidueArray(value: unknown[]): unknown[] {
  if (boundStructuredField(value, false, INLINE_RESIDUE_FIELD_LIMIT) === value) {
    return value;
  }

  // Required array fields must remain arrays after a #6950/#6981 spill, unlike
  // boundStructuredField's telemetry marker behavior; retain real prefix values
  // only, because the artifact already contains the complete untruncated array.
  let low = 0;
  let high = value.length;
  while (low < high) {
    const end = Math.ceil((low + high) / 2);
    const serialized = JSON.stringify(value.slice(0, end));
    if (serialized !== undefined && serialized.length <= INLINE_RESIDUE_FIELD_LIMIT) {
      low = end;
    } else {
      high = end - 1;
    }
  }
  return value.slice(0, low);
}

/** Marks a residue string as cut, so a client never reads a partial value as whole. */
const RESIDUE_TRUNCATION_SUFFIX = "… [truncated; complete value in the tool-output artifact]";

function artifactMode(ctx: FinalizeToolResponseContext): ObservationArtifactMode {
  return ctx.artifactMode ?? "always";
}

/** Whether the payload, as the client will actually receive it, is over the ceiling. */
function exceedsInlineLimit(
  payload: Record<string, unknown>,
  hasStructured: boolean,
  serialization: ToolResponseSerialization,
): boolean {
  return (
    emittedByteLength(payload, hasStructured, serialization) > DEFAULT_OBSERVATION_INLINE_MAX_BYTES
  );
}

/**
 * Bytes this payload will actually put on the wire (#6870 review).
 *
 * The text part is rendered with `stringifyToolResponse`, whose replacer drops
 * every property named `extras`. But `structuredContent` is assigned the
 * UNSTRIPPED payload object and is serialized by the transport with a plain
 * `JSON.stringify`, extras included. Measuring only the stripped rendering let a
 * result whose bulk is accessibility `extras` measure as a handful of bytes and
 * sail straight past the hard ceiling while 70 KB of structured content went to
 * the client. Measure the larger of the two renderings, so the gate bounds
 * whichever representation is actually emitted.
 */
function emittedByteLength(
  payload: Record<string, unknown>,
  hasStructured: boolean,
  serialization: ToolResponseSerialization,
): number {
  const strippedBytes = Buffer.byteLength(serialization.text(payload), "utf8");
  if (!hasStructured) {
    return strippedBytes;
  }
  return Math.max(strippedBytes, structuredByteLength(payload, strippedBytes, serialization));
}

function structuredByteLength(
  payload: Record<string, unknown>,
  fallback: number,
  serialization: ToolResponseSerialization,
): number {
  try {
    return Buffer.byteLength(serialization.artifact(payload), "utf8");
  } catch (error) {
    // A payload the transport itself cannot serialize (a cycle, a BigInt) has no
    // structured byte count to compare against; the stripped rendering is the
    // only measurement available. Safe to swallow: this is sizing, not delivery.
    logger.debug(`finalizeToolResponse: structured payload is not measurable: ${error}`);
    return fallback;
  }
}

function shouldArtifactObservationPayload(
  ctx: FinalizeToolResponseContext,
  payload: Record<string, unknown>,
  hasStructured: boolean,
  serialization: ToolResponseSerialization,
): boolean {
  if (artifactMode(ctx) === "always") {
    return true;
  }

  // Measures the whole served payload — `observationDiff` and every other
  // top-level field included — not just the observation subtree.
  return exceedsInlineLimit(payload, hasStructured, serialization);
}

function writeObservationArtifact(
  ctx: FinalizeToolResponseContext,
  observationPayload: unknown,
): ObservationArtifactMetadata {
  return writeJsonArtifact(
    ctx,
    getObservationArtifactPayload(observationPayload),
    observationPayload,
  );
}

/**
 * Keep a diff's compact selector surface and capture metadata inline; only its
 * potentially unbounded body belongs in the artifact (#7217).
 */
function writeObserveDiffBodyArtifact(
  ctx: FinalizeToolResponseContext,
  observation: Record<string, unknown>,
): Record<string, unknown> {
  const { added, removed, changed, fields, ...inline } = observation;
  delete inline.isDiff;
  const body: Record<string, unknown> = { isDiff: true, added, removed, changed };
  if (fields !== undefined) {
    body.fields = fields;
  }
  // The artifact is fetched on its own through tool-output resources, so imported prototype
  // text in the body must carry the same untrusted-content notice as the inline shell.
  if (inline.importedPrototypeContent !== undefined) {
    body.importedPrototypeContent = inline.importedPrototypeContent;
  }
  return { ...inline, ...writeObservationArtifact(ctx, body) };
}

function isObserveDiff(observation: unknown): observation is Record<string, unknown> {
  return (
    observation !== null &&
    typeof observation === "object" &&
    (observation as Record<string, unknown>).isDiff === true
  );
}

function getObservationArtifactPayload(observationPayload: unknown): ObservationArtifactPayload {
  if (
    observationPayload &&
    typeof observationPayload === "object" &&
    (observationPayload as Record<string, unknown>).isDiff === true
  ) {
    return "ObserveDiff";
  }
  return "ObserveResult";
}

function writeJsonArtifact(
  ctx: FinalizeToolResponseContext,
  payload: ObservationArtifactPayload,
  data: unknown,
): ObservationArtifactMetadata {
  return ctx.artifactWriter!.writeJsonArtifact({
    tool: ctx.name,
    payload,
    data,
  });
}

function artifactNonObservationPayload(
  ctx: FinalizeToolResponseContext,
  payload: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!ctx.artifactWriter || ctx.internal) {
    return undefined;
  }

  switch (ctx.name) {
    case "executePlan":
      return artifactExecutePlanPayload(ctx, payload);
    case "getNetworkGraph":
      return artifactNetworkGraphPayload(ctx, payload);
    default:
      return undefined;
  }
}

function artifactExecutePlanPayload(
  ctx: FinalizeToolResponseContext,
  payload: Record<string, unknown>,
): Record<string, unknown> | undefined {
  let changed = false;
  const nextPayload: Record<string, unknown> = { ...payload };
  if (isRecord(payload.failedStep)) {
    const failureObservation = artifactPlanObservation(
      ctx,
      payload.failedStep.failureObservation,
      "ExecutePlanFailureObservation",
    );
    if (failureObservation) {
      nextPayload.failedStep = { ...payload.failedStep, failureObservation };
      changed = true;
    }
  }

  if (Array.isArray(payload.deviceFailures)) {
    nextPayload.deviceFailures = payload.deviceFailures.map((failure) => {
      if (!isRecord(failure)) {
        return failure;
      }
      const failureObservation = artifactPlanObservation(
        ctx,
        failure.failureObservation,
        "ExecutePlanFailureObservation",
      );
      if (!failureObservation) {
        return failure;
      }
      changed = true;
      return { ...failure, failureObservation };
    });
  }

  if (isRecord(payload.debug) && Array.isArray(payload.debug.steps)) {
    let debugChanged = false;
    const steps = payload.debug.steps.map((step) => {
      if (!isRecord(step) || !isRecord(step.details)) {
        return step;
      }

      let detailsChanged = false;
      let details = step.details;
      const stepObservation = artifactPlanObservation(
        ctx,
        details.stepObservation,
        "ExecutePlanDebugStepObservation",
      );
      if (stepObservation) {
        details = { ...details, stepObservation };
        detailsChanged = true;
      }

      const failureObservation = artifactPlanObservation(
        ctx,
        details.failureObservation,
        "ExecutePlanDebugFailureObservation",
      );
      if (failureObservation) {
        details = { ...details, failureObservation };
        detailsChanged = true;
      }

      if (!detailsChanged) {
        return step;
      }
      debugChanged = true;
      return { ...step, details };
    });

    if (debugChanged) {
      nextPayload.debug = { ...payload.debug, steps };
      changed = true;
    }
  }

  return changed ? nextPayload : undefined;
}

function artifactPlanObservation(
  ctx: FinalizeToolResponseContext,
  observation: unknown,
  payloadPrefix: string,
): Record<string, unknown> | undefined {
  if (!isRecord(observation)) {
    return undefined;
  }

  let changed = false;
  const next: Record<string, unknown> = { ...observation };
  if (observation.viewHierarchy !== undefined) {
    next.viewHierarchy = writeJsonArtifact(
      ctx,
      `${payloadPrefix}ViewHierarchy`,
      observation.viewHierarchy,
    );
    changed = true;
  }
  if (observation.rawViewHierarchy !== undefined) {
    next.rawViewHierarchy = writeJsonArtifact(
      ctx,
      `${payloadPrefix}RawViewHierarchy`,
      observation.rawViewHierarchy,
    );
    changed = true;
  }

  return changed ? next : undefined;
}

function artifactNetworkGraphPayload(
  ctx: FinalizeToolResponseContext,
  payload: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!Array.isArray(payload.graph)) {
    return undefined;
  }

  return {
    ...payload,
    graph: writeJsonArtifact(ctx, "NetworkGraph", payload.graph),
    graphSummary: {
      hostCount: payload.graph.length,
    },
  };
}
