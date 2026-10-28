import { DaemonUnavailableError } from "../client/client";

/**
 * An observation-only connection (a heartbeat or liveness recovery) found a lifecycle-capable
 * connection attempt in flight and did not join it. Nothing was sent to the daemon, so this is not
 * evidence that the daemon stopped acknowledging heartbeats (#10508).
 */
export class LifecycleConnectionInFlightError extends DaemonUnavailableError {
  constructor() {
    super("Lifecycle-capable daemon connection is in flight; retry observation-only recovery");
    this.name = "LifecycleConnectionInFlightError";
  }
}
