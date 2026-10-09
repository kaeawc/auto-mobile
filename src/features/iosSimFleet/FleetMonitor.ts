import { logger } from "../../utils/logger";
import { SingleFlightInterval } from "../../utils/SingleFlightInterval";
import type { Timer } from "../../utils/SystemTimer";
import type { IosSimCapacityGate } from "./CapacityGate";

export const DEFAULT_FLEET_POLL_INTERVAL_MS = 10_000;

/**
 * Optional background sampler that keeps the gate's pressure history warm.
 * Ticks never overlap (a slow `ps` drops the next tick) and it holds no
 * session, device-epoch or runner state, so it can start and stop freely.
 */
export class IosSimFleetMonitor {
  private readonly interval: SingleFlightInterval;

  constructor(
    gate: Pick<IosSimCapacityGate, "refresh">,
    timer: Timer,
    intervalMs: number = DEFAULT_FLEET_POLL_INTERVAL_MS,
  ) {
    this.interval = new SingleFlightInterval(
      timer,
      intervalMs,
      async () => {
        await gate.refresh();
      },
      {
        onError: (error) => logger.warn("[IosSimFleetMonitor] sample failed", error),
      },
    );
  }

  start(): void {
    this.interval.start();
  }

  stop(): Promise<boolean> {
    return this.interval.stop();
  }
}
