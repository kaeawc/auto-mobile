import { ActionableError } from "./ActionableError";

/** Typed response `code` for an SDK-provider read refused because the app has no process (#11350). */
export const APP_NOT_RUNNING_CODE = "app_not_running";

/**
 * A read through the app's SDK content provider would start the app's process, which is a control
 * action. On a device another session holds, a non-owner reader is refused instead: starting the
 * holder's app changes state the holder did not ask for. Not retryable as-is: the app stays
 * stopped until the holder launches it.
 */
export class AppNotRunningError extends ActionableError {
  readonly code = APP_NOT_RUNNING_CODE;
  readonly retryable = false;

  constructor(
    readonly appId: string,
    readonly deviceId: string,
  ) {
    super(
      `${appId} is not running on device '${deviceId}', which is held by another session. ` +
        "Reading its data through the SDK would start its process, so the read was refused. " +
        "Wait for the holder to launch the app or release the device.",
    );
    this.name = "AppNotRunningError";
  }

  /** The wire evidence: the device, never the holder's session. */
  toPayload(): Record<string, unknown> {
    return { code: this.code, deviceId: this.deviceId, retryable: this.retryable };
  }
}
