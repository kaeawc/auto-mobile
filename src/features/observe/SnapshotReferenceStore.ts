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

interface SnapshotGeometry {
  deviceId: string;
  incarnation: string | undefined;
  displayKey: string;
  displayRole: string;
  displayPosture: string | undefined;
  displayRevision: number;
  width: number;
  height: number;
  rotation: number;
  nativeScale: number;
  frameContext: string;
}

function hasPositiveSize(size: ObserveResult["screenSize"]): boolean {
  return (
    Number.isFinite(size.width) && Number.isFinite(size.height) && size.width > 0 && size.height > 0
  );
}

function hasPositiveScale(scale: number | undefined): scale is number {
  return typeof scale === "number" && Number.isFinite(scale) && scale > 0;
}

function captureFrame(
  observation: ObserveResult,
): Pick<SnapshotGeometry, "rotation" | "nativeScale" | "frameContext"> | undefined {
  const rotation = observation.rotation ?? observation.viewHierarchy?.rotation;
  const frameContext = observation.viewHierarchy?.frameContext;
  const nativeScale = observation.viewHierarchy?.nativeScale;
  if (
    typeof rotation !== "number" ||
    !Number.isInteger(rotation) ||
    !hasPositiveScale(nativeScale) ||
    !frameContext
  ) {
    return undefined;
  }
  return { rotation, nativeScale, frameContext };
}

function geometry(deviceId: string, observation: ObserveResult): SnapshotGeometry | undefined {
  const frame = captureFrame(observation);
  if (
    !observation.display?.key ||
    !hasPositiveSize(observation.screenSize) ||
    observation.displayRevision === undefined ||
    !frame
  ) {
    return undefined;
  }
  const { width, height } = observation.screenSize;
  return {
    deviceId,
    incarnation: deviceIncarnationToken(deviceId),
    displayKey: observation.display.key,
    displayRole: observation.display.role,
    displayPosture: observation.display.posture,
    displayRevision: observation.displayRevision,
    width,
    height,
    ...frame,
  };
}

/** Process-local, bounded references to observed full-screen geometry. */
export class SnapshotReferenceStore {
  private readonly entries = new Map<string, SnapshotGeometry & SnapshotReference>();

  constructor(
    private readonly timer: Pick<Timer, "now"> = defaultTimer,
    private readonly ids: IdGenerator = defaultIdGenerator,
  ) {}

  capture(deviceId: string, observation: ObserveResult): SnapshotReference | undefined {
    const captured = geometry(deviceId, observation);
    if (!captured) {
      return undefined;
    }
    this.cleanup();
    while (this.entries.size >= MAX_REFERENCES) {
      this.entries.delete(this.entries.keys().next().value!);
    }
    const reference = { snapshotId: this.ids.next(), expiresAt: this.timer.now() + LIFETIME_MS };
    this.entries.set(reference.snapshotId, { ...captured, ...reference });
    return reference;
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
    for (const key of Object.keys(current) as Array<keyof SnapshotGeometry>) {
      if (entry[key] !== current[key]) {
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
