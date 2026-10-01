import type { ObserveResult } from "../../models/ObserveResult";
import { deviceIncarnationToken } from "../../utils/deviceIncarnation";
import { defaultIdGenerator, type IdGenerator } from "../../utils/IdGenerator";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";

const LIFETIME_MS = 5 * 60_000;
const MAX_REFERENCES = 128;

export interface SnapshotReference {
  snapshotId: string;
  expiresAt: number;
}

export type SnapshotReferenceCaptureResult =
  | { status: "captured"; reference: SnapshotReference }
  | { status: "unavailable"; missing: string[] };

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
  if (typeof rotation !== "number" || !Number.isInteger(rotation)) {
    missing.push("rotation");
  }
  if (!hasPositiveScale(observation.viewHierarchy?.nativeScale)) {
    missing.push("nativeScale");
  }
  if (!observation.viewHierarchy?.frameContext) {
    missing.push("frameContext");
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

/** Process-local, bounded references to observed full-screen geometry. */
export class SnapshotReferenceStore {
  private readonly entries = new Map<string, SnapshotGeometry & SnapshotReference>();

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
    this.entries.set(reference.snapshotId, { ...captured, ...reference });
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
