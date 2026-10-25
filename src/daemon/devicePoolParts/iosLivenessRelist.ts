import { holderOf, isIdle } from "../deviceBinding";
import type { PooledDevice } from "../devicePoolTypes";
import type { IdleDeviceReaper } from "../idleDeviceReaper";
import { sequenceBackoff } from "../../utils/Backoff";
import { getAbortSignal } from "../../utils/AbortContext";
import { logger } from "../../utils/logger";
import { TransitionalWaitBudget } from "../../utils/TransitionalWaitBudget";
import type { Timer } from "../../utils/SystemTimer";
import {
  IOS_LIVENESS_REDISCOVERY_DELAYS_MS,
  type TargetDeviceDiscoverySnapshot,
} from "./contracts";

/**
 * One exact-device bind's re-listing budget for a failed `simctl list` (#15289). A listing
 * timeout in a boot burst proves nothing about the target, so the bind waits a cancellable
 * backoff delay (under the caller's own signal) and lists again; once the delays run out the
 * liveness assertion raises the typed retryable refusal.
 */
export class IosLivenessRelist {
  private retries = 0;
  private readonly wait: TransitionalWaitBudget;

  constructor(
    private readonly deviceId: string,
    private readonly timer: Timer,
    private readonly reaper: Pick<IdleDeviceReaper, "getIdleDeviceLivenessStatus">,
  ) {
    this.wait = new TransitionalWaitBudget({
      timer,
      getSignal: getAbortSignal,
      backoff: sequenceBackoff(IOS_LIVENESS_REDISCOVERY_DELAYS_MS),
      budgetMs: Number.MAX_SAFE_INTEGER,
    });
  }

  /** True after waiting, when the caller should discard its snapshot and list again. */
  async waitIfUnverified(
    capturedEntry: PooledDevice | undefined,
    platform: string | undefined,
    snapshot: TargetDeviceDiscoverySnapshot,
  ): Promise<boolean> {
    if (
      (capturedEntry?.platform ?? platform) !== "ios" ||
      // A held device is reused without a liveness verdict, so there is nothing to retry.
      (capturedEntry !== undefined && (!isIdle(capturedEntry) || holderOf(capturedEntry))) ||
      this.retries >= IOS_LIVENESS_REDISCOVERY_DELAYS_MS.length ||
      this.reaper.getIdleDeviceLivenessStatus(
        { id: this.deviceId, platform: "ios" },
        snapshot.iosLiveness,
      ) !== "unknown"
    ) {
      return false;
    }
    this.retries += 1;
    logger.warn(
      `[DevicePool] iOS liveness listing failed for ${this.deviceId}; re-listing ` +
        `(${this.retries}/${IOS_LIVENESS_REDISCOVERY_DELAYS_MS.length})`,
    );
    return this.wait.waitForNextAttempt();
  }
}
