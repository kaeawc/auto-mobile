/**
 * Owns the in-flight registry for host-proxied prototype requests (#12527): the per-device
 * concurrency limit and cancellation by prototype or by device.
 */
import { logger } from "../../utils/logger";
import { MAX_PROTOTYPE_REQUESTS_IN_FLIGHT } from "./prototypeRequestLimits";
import type {
  PrototypeHttpExecutor,
  PrototypeHttpOutcome,
  PrototypeHttpRequest,
} from "./PrototypeHttpExecutor";

/** What the event coordinator needs to end requests; narrow on purpose. */
export interface PrototypeRequestCancellation {
  cancelPrototype(deviceId: string, prototypeId: string): void;
  cancelDevice(deviceId: string): void;
}

interface InFlight {
  deviceId: string;
  prototypeId: string;
  controller: AbortController;
}

export class PrototypeRequestCoordinator implements PrototypeRequestCancellation {
  private readonly inFlight = new Set<InFlight>();

  constructor(
    private readonly executor: PrototypeHttpExecutor,
    private readonly maxInFlight: number = MAX_PROTOTYPE_REQUESTS_IN_FLIGHT,
  ) {}

  inFlightCount(deviceId?: string): number {
    return [...this.inFlight].filter(
      (entry) => deviceId === undefined || entry.deviceId === deviceId,
    ).length;
  }

  async run(
    target: { deviceId: string; prototypeId: string },
    request: PrototypeHttpRequest,
  ): Promise<PrototypeHttpOutcome> {
    if (this.inFlightCount(target.deviceId) >= this.maxInFlight) {
      return {
        ok: false,
        error: {
          code: "too_many_in_flight",
          message: `At most ${this.maxInFlight} requests may be in flight per device.`,
        },
        durationMs: 0,
      };
    }
    const entry: InFlight = { ...target, controller: new AbortController() };
    this.inFlight.add(entry);
    try {
      return await this.executor.execute(request, entry.controller.signal);
    } finally {
      this.inFlight.delete(entry);
    }
  }

  cancelPrototype(deviceId: string, prototypeId: string): void {
    this.cancelWhere((entry) => entry.deviceId === deviceId && entry.prototypeId === prototypeId);
  }

  cancelDevice(deviceId: string): void {
    this.cancelWhere((entry) => entry.deviceId === deviceId);
  }

  private cancelWhere(match: (entry: InFlight) => boolean): void {
    for (const entry of [...this.inFlight].filter(match)) {
      logger.debug(`[PrototypeRequest] cancelling ${entry.deviceId}/${entry.prototypeId}`);
      entry.controller.abort();
    }
  }
}
