/**
 * Owns the in-flight registry for host-proxied prototype requests (#12527): the per-device
 * concurrency limit and cancellation by prototype, by connection or by device.
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
  /** The socket the request arrived on; unset for requests not tied to one. */
  connection?: symbol;
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
    target: { deviceId: string; prototypeId: string; connection?: symbol },
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

  /** Real device removal: ends every request on the device, whichever connection sent it. */
  cancelDevice(deviceId: string): void {
    this.cancelWhere((entry) => entry.deviceId === deviceId);
  }

  /**
   * A socket closed: ends only the requests that came in on it, so another app (or a newer
   * connection) on the same device keeps its requests.
   */
  cancelConnection(connection: symbol): void {
    this.cancelWhere((entry) => entry.connection === connection);
  }

  private cancelWhere(match: (entry: InFlight) => boolean): void {
    for (const entry of [...this.inFlight].filter(match)) {
      logger.debug(`[PrototypeRequest] cancelling ${entry.deviceId}/${entry.prototypeId}`);
      entry.controller.abort();
    }
  }
}
