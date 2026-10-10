import { ActionableError } from "../models/ActionableError";

/**
 * Typed refusal for a call on a pinned MCP connection (one bound to a single device session at
 * construction) that names a different device or platform. The binding is fixed for the
 * connection's lifetime, so waiting or retrying cannot help: the caller needs another connection,
 * or must release the bound session first. Not retryable; wire disposition "fail".
 */
export const DEVICE_OUTSIDE_BOUND_SESSION_CODE = "device_outside_bound_session";

export class DeviceOutsideBoundSessionError extends ActionableError {
  readonly code = DEVICE_OUTSIDE_BOUND_SESSION_CODE;
  readonly retryable = false;

  constructor(
    readonly boundSessionUuid: string | undefined,
    readonly boundDevice: { deviceId: string; platform: string },
    readonly requested: { deviceId?: string; platform?: string },
  ) {
    super(
      `Bound device session ${boundSessionUuid} controls only ${boundDevice.platform} device ` +
        `'${boundDevice.deviceId}', but this call named ` +
        `${requested.deviceId ? `device '${requested.deviceId}'` : `platform '${requested.platform}'`}` +
        ` (code ${DEVICE_OUTSIDE_BOUND_SESSION_CODE}). Use a separate MCP connection for that ` +
        "device, release the bound session first, or omit the device selector to target the " +
        "bound device.",
    );
    this.name = "DeviceOutsideBoundSessionError";
  }

  /** The wire evidence: the bound session and the refused selector, never a credential. */
  toPayload(): Record<string, unknown> {
    return {
      code: this.code,
      boundSessionUuid: this.boundSessionUuid,
      boundDeviceId: this.boundDevice.deviceId,
      ...(this.requested.deviceId === undefined ? {} : { deviceId: this.requested.deviceId }),
      ...(this.requested.platform === undefined ? {} : { platform: this.requested.platform }),
      retryable: false,
    };
  }
}
