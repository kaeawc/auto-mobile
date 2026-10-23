import { runOutsideRequestContext } from "../../../utils/AbortContext";
import type { IosLockStateProbe, IosLockStateReading } from "./IosLockStateProbe";
import { raceWithDeadline } from "../../../utils/raceWithDeadline";
import type { Timer } from "../../../utils/SystemTimer";
import { logger } from "../../../utils/logger";
import { errorMessage } from "../../../utils/describeUnknownError";

export interface IosLockStateInvalidator {
  invalidate(deviceId: string): void;
}
interface Entry {
  epoch: number;
  reading?: IosLockStateReading;
  expiresAt: number;
  flight?: Promise<IosLockStateReading>;
}

export class CachedIosLockStateProbe implements IosLockStateProbe, IosLockStateInvalidator {
  private readonly entries = new Map<string, Entry>();
  private readonly settling = new Set<string>();
  private readonly epochs = new Map<string, number>();
  constructor(
    private readonly inner: IosLockStateProbe,
    private readonly timer: Timer,
    private readonly options: {
      knownTtlMs?: number;
      lockedTtlMs?: number;
      failureTtlMs?: number;
      settleTtlMs?: number;
    } = {},
  ) {}

  invalidate(deviceId: string): void {
    // Detached flights still resolve for existing callers, but cannot fill the new epoch.
    this.entries.delete(deviceId);
    this.settling.add(deviceId);
    this.epochs.set(deviceId, (this.epochs.get(deviceId) ?? 0) + 1);
  }

  async read(deviceId: string, signal?: AbortSignal): Promise<IosLockStateReading> {
    try {
      return await raceWithDeadline(() => this.sharedRead(deviceId), {
        timer: this.timer,
        signal,
        label: "iOS lock-state cache",
      });
    } catch (error) {
      if (signal?.aborted) {
        // Cancellation detaches this caller without cancelling the shared flight.
        logger.debug("[iOS] Lock-state cache caller aborted");
        return { kind: "unknown", reason: "pending", message: "caller aborted" };
      }
      logger.warn(`[iOS] Lock-state cache failed: ${errorMessage(error)}`, error);
      return { kind: "unknown", reason: "error", message: errorMessage(error) };
    }
  }

  private sharedRead(deviceId: string): Promise<IosLockStateReading> {
    let entry = this.entries.get(deviceId);
    if (entry?.reading) {
      if (this.timer.now() < entry.expiresAt) {
        return Promise.resolve(entry.reading);
      }
    }
    if (entry?.flight) {
      return entry.flight;
    }
    entry = { expiresAt: 0, epoch: this.epochs.get(deviceId) ?? 0 };
    this.entries.set(deviceId, entry);
    entry.flight = this.fill(deviceId, entry);
    return entry.flight;
  }

  private async fill(deviceId: string, entry: Entry): Promise<IosLockStateReading> {
    let reading: IosLockStateReading;
    try {
      // Caller signals must never cancel a flight shared with other observations.
      reading = await runOutsideRequestContext(async () => this.inner.read(deviceId));
    } catch (error) {
      logger.warn(`[iOS] Shared lock-state probe failed: ${errorMessage(error)}`, error);
      reading = { kind: "unknown", reason: "error", message: errorMessage(error) };
    }
    if ((this.epochs.get(deviceId) ?? 0) === entry.epoch) {
      let ttlMs = this.options.failureTtlMs ?? 5_000;
      if (reading.kind === "known") {
        ttlMs = reading.lock.locked
          ? (this.options.lockedTtlMs ?? 2_000)
          : (this.options.knownTtlMs ?? 30_000);
        // Only a known reading in the current epoch consumes settling. Never
        // lengthen a shorter locked TTL when capping the first transition read.
        if (this.settling.delete(deviceId)) {
          ttlMs = Math.min(ttlMs, this.options.settleTtlMs ?? 2_000);
        }
      }
      entry.reading = reading;
      entry.expiresAt = this.timer.now() + ttlMs;
      entry.flight = undefined;
    }
    return reading;
  }
}
