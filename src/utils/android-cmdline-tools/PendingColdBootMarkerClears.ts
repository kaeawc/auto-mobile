import type { HostChildProcess as ChildProcess } from "../HostCommandExecutor";
import { errorMessage } from "../describeUnknownError";
import { logger } from "../logger";
import type { AvdColdBootMarkerStore } from "./AvdColdBootMarkerStore";

/**
 * Cold boot markers a launch applied, consumed only once that launch reaches boot readiness
 * (#17929). A launch that spawns and then exits early (an acceleration failure, a duplicate
 * AVD, a panic) forgets its pending clear, so the marker survives and the next launch cold
 * boots instead of loading the bad snapshot again.
 */
export class PendingColdBootMarkerClears {
  private readonly pending = new Map<string, ChildProcess>();

  constructor(private readonly markers: () => AvdColdBootMarkerStore) {}

  /** Records that `child` was launched with `-no-snapshot-load` because of the AVD's marker. */
  track(avdName: string, child: ChildProcess): void {
    this.pending.set(avdName, child);
    const forget = () => {
      if (this.pending.get(avdName) === child) {
        this.pending.delete(avdName);
      }
    };
    child.once("exit", forget);
    child.once("error", forget);
  }

  isPending(avdName: string): boolean {
    return this.pending.has(avdName);
  }

  /** Clears the marker when a still-running launch of this AVD applied it. */
  async clearAfterReady(avdName: string): Promise<void> {
    if (!this.pending.delete(avdName)) {
      return;
    }
    try {
      await this.markers().clear(avdName);
    } catch (error) {
      logger.warn(
        `Failed to clear cold boot marker for AVD '${avdName}': ${errorMessage(error)}`,
        error,
      );
    }
  }
}
