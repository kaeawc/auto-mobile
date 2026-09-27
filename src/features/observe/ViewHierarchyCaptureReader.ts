import { ActionableError } from "../../models/ActionableError";
import type { SettleObserve } from "./interfaces/SettleObserve";
import type { ViewHierarchyResult } from "../../models";
import { NoOpPerformanceTracker } from "../../utils/PerformanceTracker";
import type { HierarchyCaptureReader, HierarchyCaptureRequest } from "./HierarchyCapture";
import type { ViewHierarchy } from "./interfaces/ViewHierarchy";

/** Adapter preserving the existing reader injection while making cache policy explicit. */
export class ViewHierarchyCaptureReader implements HierarchyCaptureReader {
  constructor(
    private readonly hierarchy: Pick<ViewHierarchy, "getViewHierarchy" | "filterOffscreenNodes">,
    private readonly sync: (request: HierarchyCaptureRequest) => Promise<ViewHierarchyResult>,
    private readonly visible: (hierarchy: ViewHierarchyResult) => ViewHierarchyResult,
    private readonly settle?: SettleObserve,
  ) {}

  readCached(request: HierarchyCaptureRequest): Promise<ViewHierarchyResult> {
    return this.hierarchy.getViewHierarchy(
      {},
      new NoOpPerformanceTracker(),
      true,
      request.minTimestamp ?? 0,
      request.signal,
      request.timeoutMs,
    );
  }

  readFresh(request: HierarchyCaptureRequest): Promise<ViewHierarchyResult> {
    return this.sync(request);
  }

  async readSettled(request: HierarchyCaptureRequest): Promise<ViewHierarchyResult> {
    if (!this.settle) {
      throw new ActionableError("Settled hierarchy capture requires a settlement adapter");
    }
    const result = await this.settle.execute({
      timeoutMs: request.timeoutMs,
      initialMinTimestampMs: request.minTimestamp,
      signal: request.signal,
      skipPerformanceAudit: true,
      skipRecompositionTracking: true,
    });
    if (!result.settled || !result.observation.viewHierarchy) {
      throw new ActionableError(`Hierarchy did not settle: ${result.terminalReason}`);
    }
    return result.observation.viewHierarchy;
  }

  projectVisible(hierarchy: ViewHierarchyResult): ViewHierarchyResult {
    return this.visible(hierarchy);
  }
}
