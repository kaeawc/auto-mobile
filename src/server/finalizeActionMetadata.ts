import { OBSERVE_WAIT_METADATA_KEYS, isRecord } from "./finalizeShared";
import type { FinalizeToolResponseContext } from "./finalizeToolResponse";
import type { ObserveResult } from "../models/ObserveResult";
import { serverConfig } from "../utils/ServerConfig";
import { observationOfPayload, stringifyToolResponse } from "../utils/toolUtils";
import { isDeepStrictEqual } from "node:util";
import { requiredOutputSchemaKeys } from "./finalizeInlineLimit";

/** Skipped for a response the client will never receive (#10081). */
export function commitDeliveredActionMetadata(
  ctx: FinalizeToolResponseContext,
  originalPayload: Record<string, unknown>,
  servedPayload: Record<string, unknown>,
): void {
  if (ctx.delivered !== false && canRecordActionMetadata(ctx)) {
    recordInlineActionMetadata(
      servedPayload,
      ctx,
      actionMetadataDeviceId(originalPayload, ctx.name),
    );
  }
}

/** Skipped for a response the client will never receive (#10081). */
export function commitDeliveredBaseline(
  ctx: FinalizeToolResponseContext,
  pending: { sessionUuid: string; observation: ObserveResult } | undefined,
  display: {
    revision: number | undefined;
    key: string | undefined;
    generation: number | undefined;
  },
): void {
  if (ctx.delivered === false) {
    return;
  }
  if (pending) {
    ctx.baselineStore!.set(pending.sessionUuid, pending.observation, display.revision);
  } else if (ctx.sessionUuid && display.revision !== undefined) {
    ctx.baselineStore?.setDisplayRevision?.(
      ctx.sessionUuid,
      display.revision,
      display.key,
      display.generation,
    );
  }
}

/** Only these independently compared blocks are omitted; join keys and screen identity stay inline. */
const ACTION_METADATA_FIELDS = [
  "insets",
  "systemInsets",
  "backStack",
  "gfxMetrics",
  "displayedTimeMetrics",
  "deviceLock",
  "accessibilityState",
  "freshness",
] as const;

const HIERARCHY_METADATA_FIELDS = ["insets", "systemInsets"] as const;

function canRecordActionMetadata(ctx: FinalizeToolResponseContext): boolean {
  return (
    (ctx.actionsCompactMetadata ?? serverConfig.isActionsCompactMetadataEnabled()) &&
    !ctx.internal &&
    !!ctx.sessionUuid &&
    !!ctx.baselineStore?.getActionMetadata &&
    !!ctx.baselineStore.setActionMetadata
  );
}

export function canCompactActionMetadata(
  ctx: FinalizeToolResponseContext,
  payload: Record<string, unknown>,
  envelope: object,
): boolean {
  return (
    canRecordActionMetadata(ctx) &&
    ctx.name !== "observe" &&
    payload.success !== false &&
    payload.error === undefined &&
    (envelope as { isError?: boolean }).isError !== true
  );
}

function actionMetadataBlocks(
  payload: Record<string, unknown>,
  name: string,
): Record<string, unknown> {
  const observation = observationOfPayload(name, payload);
  if (!isRecord(observation)) {
    return {};
  }
  const blocks: Record<string, unknown> = {};
  for (const field of ACTION_METADATA_FIELDS) {
    if (observation[field] !== undefined) {
      blocks[field] = observation[field];
    }
  }
  if (isRecord(observation.viewHierarchy)) {
    for (const field of HIERARCHY_METADATA_FIELDS) {
      if (observation.viewHierarchy[field] !== undefined) {
        blocks[`viewHierarchy.${field}`] = observation.viewHierarchy[field];
      }
    }
  }
  return blocks;
}

function actionMetadataDeviceId(
  payload: Record<string, unknown>,
  name: string,
): string | undefined {
  const observation = observationOfPayload(name, payload);
  const deviceId = isRecord(observation) ? observation.deviceId : undefined;
  return typeof deviceId === "string" && deviceId.length > 0 ? deviceId : undefined;
}

function hasDuplicateActionElement(
  payload: Record<string, unknown>,
  outputSchema: unknown,
): boolean {
  return (
    payload.element !== undefined &&
    isRecord(payload.selectedElement) &&
    isDeepStrictEqual(payload.element, payload.selectedElement.matchedElement) &&
    !requiredOutputSchemaKeys(outputSchema).includes("element")
  );
}

/**
 * Per-capture stamps inside an otherwise static block. They change on every call
 * and nothing reads them, so they must not keep an unchanged block inline.
 * `freshness` is deliberately absent: its `ageMs` is documented for a consumer
 * working to a tighter budget, so any change there is a real change.
 */
const ACTION_METADATA_VOLATILE_FIELDS: Partial<
  Record<(typeof ACTION_METADATA_FIELDS)[number], readonly string[]>
> = { backStack: ["capturedAt"] };

/** Blocks whose per-call warning shape must stay visible even when unchanged. */
function isAlwaysSentActionBlock(field: string, block: unknown): boolean {
  if (field === "freshness") {
    return !isRecord(block) || block.isFresh !== true;
  }
  if (field === "gfxMetrics") {
    return isRecord(block) && block.isStable === false;
  }
  // The error-fallback shape (partial) is otherwise identical call to call once capturedAt is ignored.
  return field === "backStack" && isRecord(block) && block.partial === true;
}

/** Wire form of a block with its volatile keys removed, so in-memory `undefined` keys cannot differ from the recorded JSON round-trip. */
function comparableActionBlock(field: string, block: unknown): unknown {
  const wire: unknown = JSON.parse(stringifyToolResponse(block));
  const volatile =
    ACTION_METADATA_VOLATILE_FIELDS[field as keyof typeof ACTION_METADATA_VOLATILE_FIELDS];
  if (!isRecord(wire) || !volatile) {
    return wire;
  }
  return Object.fromEntries(Object.entries(wire).filter(([key]) => !volatile.includes(key)));
}

function isUnchangedActionBlock(field: string, block: unknown, previous: unknown): boolean {
  if (block === undefined || previous === undefined || isAlwaysSentActionBlock(field, block)) {
    return false;
  }
  return isDeepStrictEqual(
    comparableActionBlock(field, block),
    comparableActionBlock(field, previous),
  );
}

export function compactActionMetadata(
  payload: Record<string, unknown>,
  ctx: FinalizeToolResponseContext,
): Record<string, unknown> {
  let next = payload;
  if (hasDuplicateActionElement(payload, ctx.outputSchema)) {
    next = { ...payload };
    delete next.element;
  }
  const deviceId = actionMetadataDeviceId(payload, ctx.name);
  if (!deviceId || !isRecord(payload.observation)) {
    return next;
  }
  const previous = ctx.baselineStore!.getActionMetadata!(ctx.sessionUuid!, deviceId);
  if (!previous) {
    return next;
  }
  const observation = payload.observation;
  const omittedFields = ACTION_METADATA_FIELDS.filter((field) =>
    isUnchangedActionBlock(field, observation[field], previous[field]),
  );
  const sourceHierarchy = isRecord(observation.viewHierarchy)
    ? observation.viewHierarchy
    : undefined;
  const omittedHierarchyFields = HIERARCHY_METADATA_FIELDS.filter(
    (field) =>
      sourceHierarchy?.[field] !== undefined &&
      isDeepStrictEqual(sourceHierarchy[field], previous[`viewHierarchy.${field}`]),
  );
  if (omittedFields.length === 0 && omittedHierarchyFields.length === 0) {
    return next;
  }

  const compactedObservation = { ...observation };
  for (const field of omittedFields) {
    delete compactedObservation[field];
  }
  if (omittedHierarchyFields.length > 0) {
    const hierarchy = { ...sourceHierarchy };
    for (const field of omittedHierarchyFields) {
      delete hierarchy[field];
    }
    compactedObservation.viewHierarchy = hierarchy;
  }
  return { ...next, observation: compactedObservation };
}

/** Record only final inline blocks, including observe and errors; artifacts do not count. */
function recordInlineActionMetadata(
  payload: Record<string, unknown>,
  ctx: FinalizeToolResponseContext,
  deviceId: string | undefined,
): void {
  if (!deviceId) {
    return;
  }
  const blocks = actionMetadataBlocks(payload, ctx.name);
  const previous = ctx.baselineStore!.getActionMetadata!(ctx.sessionUuid!, deviceId);
  if (Object.keys(blocks).length === 0 && previous) {
    return;
  }
  // An empty snapshot on a device switch invalidates the old device without
  // claiming delivery of any artifacted/stripped block.
  // Detach values from the response and use the text serializer's wire representation.
  const snapshot: Record<string, unknown> = JSON.parse(stringifyToolResponse(blocks));
  ctx.baselineStore!.setActionMetadata!(ctx.sessionUuid!, deviceId, { ...previous, ...snapshot });
}

export function pickObserveWaitMetadata(payload: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    OBSERVE_WAIT_METADATA_KEYS.filter((key) => payload[key] !== undefined).map((key) => [
      key,
      payload[key],
    ]),
  );
}
