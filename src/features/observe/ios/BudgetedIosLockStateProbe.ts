import type { IosLockStateProbe, IosLockStateReading } from "./IosLockStateProbe";
import { raceWithDeadline } from "../../../utils/raceWithDeadline";
import type { Timer } from "../../../utils/SystemTimer";
import { logger } from "../../../utils/logger";
import { errorMessage } from "../../../utils/describeUnknownError";

export class BudgetedIosLockStateProbe implements IosLockStateProbe {
  constructor(
    private readonly inner: IosLockStateProbe,
    private readonly timer: Timer,
    private readonly observeBudgetMs = 750,
  ) {}

  async read(deviceId: string, signal?: AbortSignal): Promise<IosLockStateReading> {
    const pending = new Error("iOS lock-state reading pending");
    try {
      return await raceWithDeadline(() => this.inner.read(deviceId), {
        timer: this.timer,
        signal,
        timeoutMs: this.observeBudgetMs,
        label: "iOS lock-state observation",
        timeoutError: () => pending,
      });
    } catch (error) {
      if (signal?.aborted) {
        // Cancellation detaches this caller; the shared read continues.
        logger.debug("[iOS] Lock-state caller aborted");
        return { kind: "unknown", reason: "pending", message: "caller aborted" };
      }
      if (error === pending) {
        // The shared probe remains in flight and will populate the cache.
        logger.debug("[iOS] Lock-state probe still pending after observe budget");
        return { kind: "unknown", reason: "pending" };
      }
      logger.warn(`[iOS] Budgeted lock-state probe failed: ${errorMessage(error)}`, error);
      return { kind: "unknown", reason: "error", message: errorMessage(error) };
    }
  }
}
