import { hierarchyUpdatedAtToMillis } from "./observeTimestamp";
import type { ViewHierarchyResult } from "../../models";
import { ActionableError } from "../../models/ActionableError";
import { defaultIdGenerator, type IdGenerator } from "../../utils/IdGenerator";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import { SearchableHierarchy, type SearchableEntry } from "../utility/SearchableNode";

export interface HierarchyCaptureRequest {
  freshness: "cached-ok" | "fresh" | "settled";
  minTimestamp?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
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

  constructor(
    private readonly platform: "android" | "ios",
    private readonly reader: HierarchyCaptureReader,
    private readonly timer: Timer = defaultTimer,
    private readonly ids: IdGenerator = defaultIdGenerator,
  ) {}

  async capture(request: HierarchyCaptureRequest): Promise<HierarchySnapshot> {
    request.signal?.throwIfAborted();
    const source = await this.read(request);
    request.signal?.throwIfAborted();
    if (source.hierarchy?.error) {
      throw new ActionableError(`Unable to capture hierarchy: ${source.hierarchy.error}`);
    }
    const updatedAt = hierarchyUpdatedAtToMillis(source);
    if (
      request.minTimestamp !== undefined &&
      request.minTimestamp > 0 &&
      (updatedAt === undefined || updatedAt < request.minTimestamp)
    ) {
      throw new ActionableError("Hierarchy capture did not satisfy the device timestamp floor");
    }
    let snapshot = this.snapshots.get(source);
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
        nodes: this.searchable.project(hierarchy),
      };
      this.snapshots.set(source, snapshot);
    }
    return { ...snapshot, requestedFreshness: request.freshness };
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
