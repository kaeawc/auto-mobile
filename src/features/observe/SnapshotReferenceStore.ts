import { createHash, type Hash } from "node:crypto";
import { stableStringify } from "../../utils/stableStringify";
import { isDeepStrictEqual } from "node:util";
import {
  nodeAttributes,
  nodeBounds,
  type ViewHierarchyNode,
} from "../../models/ViewHierarchyResult";
import { isSystemUiStatusBarId } from "../../utils/androidStatusBar";
import { getRawViewHierarchy } from "../../utils/viewHierarchySearch";
import {
  captureFidelityTruncationReasons,
  isHostOutputTruncationReason,
} from "./truncationReasons";
import type { ObserveResult } from "../../models/ObserveResult";
import { deviceIncarnationToken } from "../../utils/deviceIncarnation";
import { defaultIdGenerator, type IdGenerator } from "../../utils/IdGenerator";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";

const LIFETIME_MS = 5 * 60_000;
const MAX_REFERENCES = 128;

import type { SnapshotReference } from "../../models/SnapshotReference";

export type { SnapshotReference };

export type SnapshotReferenceCaptureResult =
  | { status: "captured"; reference: SnapshotReference }
  | { status: "unavailable"; missing: string[] };

// These capture-only fields are documented by the observation diff as nondeterministic between
// captures of one unchanged Android screen. They cannot establish that a coordinate was retargeted.
const VOLATILE_TAP_LAYOUT_FIELDS = new Set([
  "extras",
  "view-id",
  "occlusionState",
  "occludedBy",
  "occludedByViewId",
]);

function withoutVolatileTapLayoutFields(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(withoutVolatileTapLayoutFields);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !VOLATILE_TAP_LAYOUT_FIELDS.has(key))
      .map(([key, child]) => [key, withoutVolatileTapLayoutFields(child)]),
  );
}

function hasTruncatedTapLayout(observation: ObserveResult): boolean {
  return Boolean(
    captureFidelityTruncationReasons(observation.truncationReasons).length ||
    captureFidelityTruncationReasons(observation.viewHierarchy?.truncationReasons).length,
  );
}

function hasHostOutputTruncation(observation: ObserveResult): boolean {
  return Boolean(
    observation.truncationReasons?.some(isHostOutputTruncationReason) ||
    observation.viewHierarchy?.truncationReasons?.some(isHostOutputTruncationReason) ||
    observation.viewHierarchy?.windows?.some((window) =>
      window.truncationReasons?.some(isHostOutputTruncationReason),
    ),
  );
}

function hasTruncatedSnapshotLayout(observation: ObserveResult): boolean {
  return (
    hasTruncatedTapLayout(observation) ||
    (hasHostOutputTruncation(observation) &&
      (!observation.viewHierarchy || !getRawViewHierarchy(observation.viewHierarchy))) ||
    Boolean(
      observation.viewHierarchy?.windows?.some(
        (window) =>
          captureFidelityTruncationReasons(window.truncationReasons ?? undefined).length > 0,
      ),
    )
  );
}

function tapTargetingLayout(observation: ObserveResult) {
  const rotation = observation.rotation ?? observation.viewHierarchy?.rotation;
  if (
    !Number.isInteger(rotation) ||
    !observation.viewHierarchy ||
    hasTruncatedTapLayout(observation)
  ) {
    return null;
  }

  const hierarchy = observation.viewHierarchy;
  return {
    screenSize: {
      width: observation.screenSize?.width,
      height: observation.screenSize?.height,
    },
    rotation,
    systemInsets: observation.systemInsets,
    insets: observation.insets,
    activeWindow: {
      appId: observation.activeWindow?.appId,
      activityName: observation.activeWindow?.activityName,
    },
    screenIdentity: observation.screenIdentity
      ? {
          platform: observation.screenIdentity.platform,
          source: observation.screenIdentity.source,
          key: observation.screenIdentity.key,
        }
      : undefined,
    hierarchy: {
      tree: withoutVolatileTapLayoutFields(hierarchy.hierarchy),
      windows: withoutVolatileTapLayoutFields(hierarchy.windows),
      packageName: hierarchy.packageName,
      foregroundActivity: hierarchy.foregroundActivity,
      screenWidth: hierarchy.screenWidth,
      screenHeight: hierarchy.screenHeight,
      pixelWidth: hierarchy.pixelWidth,
      pixelHeight: hierarchy.pixelHeight,
      nativeScale: hierarchy.nativeScale,
      rotation: hierarchy.rotation,
      systemInsets: hierarchy.systemInsets,
      insets: hierarchy.insets,
    },
  };
}

export function hasSameTapTargetingLayout(
  previous: ObserveResult,
  refreshed: ObserveResult,
): boolean {
  const previousLayout = tapTargetingLayout(previous);
  const refreshedLayout = tapTargetingLayout(refreshed);
  return (
    previousLayout !== null &&
    refreshedLayout !== null &&
    isDeepStrictEqual(previousLayout, refreshedLayout)
  );
}
interface SnapshotGeometry {
  deviceId: string;
  incarnation: string | undefined;
  displayKey: string;
  displayRole: string;
  displayPosture: string | undefined;
  width: number;
  height: number;
  rotation: number;
  nativeScale: number;
  runnerEpoch: string | undefined;
  appId: string | undefined;
  hierarchyPackage: string | undefined;
  activityName: string;
  windowType: string | undefined;
  focusedWindowPresent: boolean;
  focusedWindowId: number | undefined;
  focusedWindowType: number | undefined;
  focusedWindowPackage: string | undefined;
  focusedWindowBounds: string | undefined;
}

function hasPositiveSize(size: ObserveResult["screenSize"]): boolean {
  return (
    Number.isFinite(size.width) && Number.isFinite(size.height) && size.width > 0 && size.height > 0
  );
}

function hasPositiveScale(scale: number | undefined): scale is number {
  return typeof scale === "number" && Number.isFinite(scale) && scale > 0;
}

/** Android: UUID:counter; iOS: UUID:generation:semanticHash. */
function frameContextEpoch(token: string): string | undefined {
  const match = /^([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}):\d+(?::[0-9a-f]+)?$/i.exec(token);
  return match?.[1]?.toLowerCase();
}

/** Missing capture preconditions, in stable diagnostic order; empty means mintable. */
export function snapshotReferenceUnavailable(observation: ObserveResult): string[] {
  const missing: string[] = [];
  if (!observation.display?.key) {
    missing.push("display");
  }
  if (!hasPositiveSize(observation.screenSize)) {
    missing.push("screenSize");
  }
  const rotation = observation.rotation ?? observation.viewHierarchy?.rotation;
  if (!Number.isInteger(rotation)) {
    missing.push("rotation");
  }
  if (!hasPositiveScale(observation.viewHierarchy?.nativeScale)) {
    missing.push("nativeScale");
  }
  if (!observation.viewHierarchy?.frameContext) {
    missing.push("frameContext");
  }
  if (hasTruncatedSnapshotLayout(observation)) {
    missing.push("completeHierarchy");
  }
  return missing;
}

function focusedWindowContext(
  observation: ObserveResult,
): Pick<
  SnapshotGeometry,
  | "focusedWindowId"
  | "focusedWindowType"
  | "focusedWindowPackage"
  | "focusedWindowBounds"
  | "focusedWindowPresent"
> {
  const focused = observation.viewHierarchy?.windows?.find((window) => window.isFocused);
  const bounds = focused?.bounds;
  return {
    focusedWindowPresent: focused !== undefined,
    focusedWindowId: focused?.id,
    focusedWindowType: focused?.type,
    focusedWindowPackage: focused?.packageName,
    focusedWindowBounds: bounds
      ? JSON.stringify([bounds.left, bounds.top, bounds.right, bounds.bottom])
      : undefined,
  };
}

function geometry(deviceId: string, observation: ObserveResult): SnapshotGeometry | undefined {
  if (snapshotReferenceUnavailable(observation).length > 0) {
    return undefined;
  }
  const { width, height } = observation.screenSize;
  return {
    deviceId,
    incarnation: deviceIncarnationToken(deviceId),
    displayKey: observation.display.key,
    displayRole: observation.display.role,
    displayPosture: observation.display.posture,
    width,
    height,
    // The shared precondition check above guarantees these frame fields are present.
    rotation: (observation.rotation ?? observation.viewHierarchy?.rotation)!,
    nativeScale: observation.viewHierarchy!.nativeScale!,
    // Frame-event generation may advance without changing geometry; bind only the runner epoch.
    runnerEpoch: frameContextEpoch(observation.viewHierarchy!.frameContext!),
    appId: observation.activeWindow?.appId || observation.viewHierarchy?.packageName,
    hierarchyPackage: observation.viewHierarchy?.packageName,
    activityName: observation.activeWindow?.activityName ?? "",
    windowType: observation.activeWindow?.type,
    ...focusedWindowContext(observation),
  };
}

function hasConflictingField(
  entry: SnapshotGeometry,
  current: SnapshotGeometry,
  key: keyof SnapshotGeometry,
): boolean {
  if (key === "runnerEpoch" || key === "focusedWindowPresent") {
    return false;
  }
  if ((key === "activityName" || key === "windowType") && (!entry[key] || !current[key])) {
    return false;
  }
  if (
    key.startsWith("focusedWindow") &&
    (!entry.focusedWindowPresent || !current.focusedWindowPresent)
  ) {
    return false;
  }
  return entry[key] !== current[key];
}

/** Fixed-order geometry avoids dependence on wire object property order. */
function snapshotBounds(bounds: unknown): unknown {
  if (bounds && typeof bounds === "object" && !Array.isArray(bounds)) {
    const rect = bounds as Record<string, unknown>;
    return [rect.left, rect.top, rect.right, rect.bottom];
  }
  return bounds;
}

/**
 * Hash structure, geometry, resource-id identity and tap affordances, including wrapped iOS attributes.
 * Interaction state includes visibility, actions and scrollability alongside clickable/enabled.
 * Text, descriptions, values, selection/state and capture IDs cannot retarget a coordinate.
 * Delimit each subtree so changing parentage/order cannot alias an identical flat node list.
 */
function hashSnapshotTree(hash: Hash, value: unknown): void {
  if (Array.isArray(value)) {
    for (const node of value) {
      hashSnapshotTree(hash, node);
    }
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }
  const node = value as ViewHierarchyNode;
  // Some Android captures carry an empty `$` alongside flat attributes.
  const attrs: Record<string, unknown> = { ...node, ...nodeAttributes(node) };
  if (isSystemUiStatusBarId(attrs["resource-id"])) {
    return;
  }
  hash.update("[");
  hash.update(
    JSON.stringify([
      attrs.className ?? attrs.class ?? attrs.type,
      attrs.role,
      snapshotBounds(nodeBounds(node)),
      attrs.clickable,
      attrs.enabled,
      attrs["visible-to-user"],
      attrs.scrollable,
      attrs["resource-id"],
      Array.isArray(attrs.actions) ? [...attrs.actions].sort() : attrs.actions,
    ]),
  );
  hashSnapshotTree(hash, node.node);
  hash.update("]");
}

/** Constant-sized owned digests; no observation trees or mutable bounds are retained. */
function snapshotLayout(observation: ObserveResult) {
  const hierarchy = observation.viewHierarchy!;
  // Snapshot preconditions require the raw carrier whenever host output was capped.
  const layoutHierarchy = hasHostOutputTruncation(observation)
    ? getRawViewHierarchy(hierarchy)!
    : hierarchy;
  const hash = createHash("sha256");
  hash.update(
    stableStringify([
      observation.systemInsets,
      observation.insets,
      hierarchy.screenWidth,
      hierarchy.screenHeight,
      hierarchy.pixelWidth,
      hierarchy.pixelHeight,
      hierarchy.nativeScale,
      hierarchy.rotation,
      hierarchy.systemInsets,
      hierarchy.insets,
    ]),
  );
  hashSnapshotTree(hash, layoutHierarchy.hierarchy);
  let windows: string | undefined;
  if (layoutHierarchy.windows !== undefined) {
    const windowHash = createHash("sha256");
    for (const window of layoutHierarchy.windows) {
      windowHash.update(
        JSON.stringify([
          window.id,
          window.type,
          window.isActive,
          window.isFocused,
          snapshotBounds(window.bounds),
          window.windowLayer,
          window.packageName,
        ]),
      );
      hashSnapshotTree(windowHash, window.hierarchy);
    }
    windows = windowHash.digest("hex");
  }
  return { tree: hash.digest("hex"), windows };
}

function hasSameSnapshotLayout(
  captured: ReturnType<typeof snapshotLayout>,
  current: ReturnType<typeof snapshotLayout>,
): boolean {
  // Geometry rejects conflicting known window facts; missing optional metadata is tolerated.
  return (
    captured.tree === current.tree &&
    (captured.windows === undefined ||
      current.windows === undefined ||
      captured.windows === current.windows)
  );
}

/** Process-local, bounded references to observed geometry and tap-targeting layout. */
export class SnapshotReferenceStore {
  private readonly entries = new Map<
    string,
    SnapshotGeometry & SnapshotReference & { layout: ReturnType<typeof snapshotLayout> }
  >();

  constructor(
    private readonly timer: Pick<Timer, "now"> = defaultTimer,
    private readonly ids: IdGenerator = defaultIdGenerator,
  ) {}

  capture(deviceId: string, observation: ObserveResult): SnapshotReferenceCaptureResult {
    const captured = geometry(deviceId, observation);
    if (!captured) {
      return { status: "unavailable", missing: snapshotReferenceUnavailable(observation) };
    }
    this.cleanup();
    while (this.entries.size >= MAX_REFERENCES) {
      this.entries.delete(this.entries.keys().next().value!);
    }
    const reference = { snapshotId: this.ids.next(), expiresAt: this.timer.now() + LIFETIME_MS };
    this.entries.set(reference.snapshotId, {
      ...captured,
      ...reference,
      layout: snapshotLayout(observation),
    });
    return { status: "captured", reference };
  }

  staleReason(
    snapshotId: string,
    deviceId: string,
    observation: ObserveResult,
  ): string | undefined {
    const entry = this.entries.get(snapshotId);
    if (!entry) {
      return "Snapshot reference is unknown or evicted; re-observe.";
    }
    if (this.timer.now() >= entry.expiresAt) {
      this.entries.delete(snapshotId);
      return "Snapshot reference expired; re-observe.";
    }
    if (hasTruncatedSnapshotLayout(observation)) {
      return "Snapshot layout is unavailable. The hierarchy capture was incomplete; observe again, or use a selector or coordinates without a snapshotId.";
    }
    const current = geometry(deviceId, observation);
    if (!current) {
      return "Snapshot geometry or frame context is unavailable; re-observe.";
    }
    if (entry.runnerEpoch !== current.runnerEpoch) {
      return "Snapshot reference is stale (runner restarted); re-observe.";
    }
    for (const key of Object.keys(current) as Array<keyof SnapshotGeometry>) {
      if (hasConflictingField(entry, current, key)) {
        return `Snapshot reference is stale (${key} changed); re-observe.`;
      }
    }
    const currentLayout = snapshotLayout(observation);
    if (!hasSameSnapshotLayout(entry.layout, currentLayout)) {
      return "Snapshot reference is stale (tap-targeting layout changed); re-observe.";
    }
    return undefined;
  }

  get size(): number {
    return this.entries.size;
  }

  private cleanup(): void {
    for (const [id, entry] of this.entries) {
      if (this.timer.now() >= entry.expiresAt) {
        this.entries.delete(id);
      }
    }
  }
}

export const snapshotReferences = new SnapshotReferenceStore();
