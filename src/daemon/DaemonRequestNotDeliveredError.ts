import { DaemonUnavailableError } from "./DaemonUnavailableError";

/**
 * The request frame was never written to the daemon socket: connecting failed,
 * or no socket existed at send time. Replaying cannot duplicate a device action,
 * unlike a plain `DaemonUnavailableError` raised after the frame was written
 * (issue #6382).
 */
export class DaemonRequestNotDeliveredError extends DaemonUnavailableError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DaemonRequestNotDeliveredError";
  }
}
