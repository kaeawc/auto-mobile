import {
  OBSERVE_WAIT_METADATA_KEYS,
  ToolResponseSerialization,
  exceedsInlineLimit,
} from "./finalizeShared";
import type { FinalizeToolResponseContext, ObservationArtifactMode } from "./finalizeToolResponse";
import { writeJsonArtifact } from "./finalizeArtifactWriters";
import { isDeviceSessionAcquisitionTool } from "./deviceSessionResult";
import { z } from "zod/v4";
import { boundStructuredField, truncateBodyText } from "../utils/truncateBodyText";

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
export function spillOversizedPayload(
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

export function artifactMode(ctx: FinalizeToolResponseContext): ObservationArtifactMode {
  return ctx.artifactMode ?? "always";
}
