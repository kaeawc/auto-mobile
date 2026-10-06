import { projectActionableHierarchy } from "./HierarchyNormalization";
import { hierarchyUpdatedAtToMillis } from "./observeTimestamp";
import type { ViewHierarchyResult } from "../../models";
import { ActionableError } from "../../models/ActionableError";
import { defaultIdGenerator, type IdGenerator } from "../../utils/IdGenerator";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import { SearchableHierarchy, type SearchableEntry } from "../utility/SearchableNode";
import { resolveViewHierarchyForSearch } from "../utility/viewHierarchySearch";

export interface HierarchyCaptureRequest {
  /** Suppress all owner-visible effects of a session-free hierarchy request. */
  observerMode?: boolean;
  /** Aggregate observer replies must not seed an owner's active hierarchy or push stream. */
  preserveDisplayState?: boolean;
  freshness: "cached-ok" | "fresh" | "settled";
  /** Force iOS extraction rather than accepting the runner cache; pre-tap revalidation only. */
  requireFreshExtraction?: boolean;
  searchRaw?: boolean;
  minTimestamp?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Android logical display targeted by a per-call read. */
  displayId?: number;
}

export interface HierarchySnapshot {
  /** Host acquisition identity, not the device frameContext; only same-object snapshots reuse it. */
  captureId: string;
  platform: "android" | "ios";
  requestedFreshness: HierarchyCaptureRequest["freshness"];
  updatedAt?: number;
  receivedAt: number;
  hierarchy: ViewHierarchyResult;
  nodes: readonly SearchableEntry[];
  searchRaw?: boolean;
}

const capturedHierarchies = new WeakMap<ViewHierarchyResult, HierarchySnapshot>();
const acquisitionTimestamps = new WeakMap<ViewHierarchyResult, number>();
const observedSearchable = new SearchableHierarchy();

/** Keep device acquisition proof without labelling a mixed hierarchy as one frame. */
export function recordAcquisitionTimestamp(
  hierarchy: ViewHierarchyResult,
  updatedAt: number | undefined,
): void {
  if (updatedAt !== undefined) {
    acquisitionTimestamps.set(hierarchy, updatedAt);
  }
}

/** Internal provenance only: nothing is added to the serialized hierarchy contract. */
export function getHierarchySnapshot(
  hierarchy: ViewHierarchyResult | undefined,
): HierarchySnapshot | undefined {
  return hierarchy ? capturedHierarchies.get(hierarchy) : undefined;
}

export function identifyObservedHierarchy(
  platform: "android" | "ios",
  source: ViewHierarchyResult,
  freshness: HierarchyCaptureRequest["freshness"],
  timer: Timer = defaultTimer,
  ids: IdGenerator = defaultIdGenerator,
  captureIdentity?: string | { captureId?: string; iosMultiPanel?: boolean },
): HierarchySnapshot {
  const existing = getHierarchySnapshot(source);
  if (existing) {
    return existing;
  }
  const { captureId, iosMultiPanel = false } =
    (typeof captureIdentity === "string" ? { captureId: captureIdentity } : captureIdentity) ?? {};
  const hierarchy = projectActionableHierarchy(platform, source, iosMultiPanel);
  const snapshot: HierarchySnapshot = {
    captureId: captureId ?? ids.next(),
    platform,
    requestedFreshness: freshness,
    updatedAt: source.updatedAt,
    receivedAt: source.receivedAt ?? timer.now(),
    hierarchy,
    nodes: observedSearchable.project(hierarchy),
  };
  capturedHierarchies.set(source, snapshot);
  capturedHierarchies.set(hierarchy, snapshot);
  return snapshot;
}

/** Carry acquisition identity across an observe-only visibility projection. */
export function inheritHierarchySnapshot(
  source: ViewHierarchyResult | undefined,
  target: ViewHierarchyResult | undefined,
  iosMultiPanel = false,
): void {
  const existing = getHierarchySnapshot(source);
  if (!existing || !target || source === target) {
    return;
  }
  const hierarchy = projectActionableHierarchy(existing.platform, target, iosMultiPanel);
  const snapshot = { ...existing, hierarchy, nodes: observedSearchable.project(hierarchy) };
  capturedHierarchies.set(target, snapshot);
  capturedHierarchies.set(hierarchy, snapshot);
}

export interface HierarchyCapture {
  capture(request: HierarchyCaptureRequest): Promise<HierarchySnapshot>;
}

/** Reads own device/host freshness rules; settlement must come from a real settle adapter. */
export interface HierarchyCaptureReader {
  readCached(request: HierarchyCaptureRequest): Promise<ViewHierarchyResult>;
  readFresh(request: HierarchyCaptureRequest): Promise<ViewHierarchyResult>;
  readSettled?(request: HierarchyCaptureRequest): Promise<ViewHierarchyResult>;
  projectVisible(hierarchy: ViewHierarchyResult): ViewHierarchyResult;
}

export class DefaultHierarchyCapture implements HierarchyCapture {
  private readonly searchable = new SearchableHierarchy();
  private readonly snapshots = new WeakMap<
    ViewHierarchyResult,
    Omit<HierarchySnapshot, "requestedFreshness">
  >();
  private readonly rawSearchSnapshots = new WeakMap<
    ViewHierarchyResult,
    Omit<HierarchySnapshot, "requestedFreshness">
  >();

  constructor(
    private readonly platform: "android" | "ios",
    private readonly reader: HierarchyCaptureReader,
    private readonly timer: Timer = defaultTimer,
    private readonly ids: IdGenerator = defaultIdGenerator,
  ) {}

  async capture(request: HierarchyCaptureRequest): Promise<HierarchySnapshot> {
    request.signal?.throwIfAborted();
    // iOS raw search shares the displayed, offscreen-projected capture. Android
    // retains its explicit raw diagnostic projection.
    const searchRaw = this.platform === "android" && request.searchRaw === true;
    const source = await this.read({ ...request, searchRaw });
    request.signal?.throwIfAborted();
    if (source.hierarchy?.error) {
      throw new ActionableError(`Unable to capture hierarchy: ${source.hierarchy.error}`);
    }
    this.validateTimestampFloor(source, request.minTimestamp);
    const snapshots = searchRaw ? this.rawSearchSnapshots : this.snapshots;
    let snapshot = snapshots.get(source);
    if (!snapshot) {
      // Spread deliberately drops the non-enumerable raw-search carrier. The
      // actionable projection must never silently widen back to an offscreen tree.
      const hierarchy = { ...this.reader.projectVisible(source) };
      snapshot = {
        captureId: this.ids.next(),
        platform: this.platform,
        updatedAt: source.updatedAt,
        receivedAt: source.receivedAt ?? this.timer.now(),
        hierarchy,
        nodes: this.projectNodes(source, hierarchy, searchRaw),
        searchRaw,
      };
      snapshots.set(source, snapshot);
    }
    const result = { ...snapshot, requestedFreshness: request.freshness };
    capturedHierarchies.set(source, result);
    capturedHierarchies.set(result.hierarchy, result);
    return result;
  }

  private validateTimestampFloor(source: ViewHierarchyResult, minTimestamp?: number): void {
    const updatedAt = acquisitionTimestamps.get(source) ?? hierarchyUpdatedAtToMillis(source);
    if (
      minTimestamp !== undefined &&
      minTimestamp > 0 &&
      (updatedAt === undefined || updatedAt < minTimestamp)
    ) {
      throw new ActionableError("Hierarchy capture did not satisfy the device timestamp floor");
    }
  }

  private projectNodes(
    source: ViewHierarchyResult,
    hierarchy: ViewHierarchyResult,
    searchRaw: boolean | undefined,
  ): readonly SearchableEntry[] {
    return this.searchable.project(
      searchRaw ? (resolveViewHierarchyForSearch(source) ?? source) : hierarchy,
    );
  }

  private read(request: HierarchyCaptureRequest): Promise<ViewHierarchyResult> {
    if (request.freshness === "cached-ok") {
      return this.reader.readCached(request);
    }
    if (request.freshness === "fresh") {
      return this.reader.readFresh(request);
    }
    if (!this.reader.readSettled) {
      throw new ActionableError("Settled hierarchy capture requires a settlement adapter");
    }
    return this.reader.readSettled(request);
  }
}
