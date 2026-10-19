import { ActionableError } from "./ActionableError";

/** A health marker refuses allocation until recovery succeeds or the device is replaced (#12112). */
export const DEVICE_UNHEALTHY_CODE = "device_unhealthy";

export interface UnhealthyDeviceEvidence {
  readonly deviceId: string;
  readonly reason: string;
  readonly recovering: boolean;
  readonly retryAfterMs?: number;
}

/** Every health reason has the same refusal, with retry intent derived from live recovery (#12112). */
export class DeviceUnhealthyError extends ActionableError {
  readonly code = DEVICE_UNHEALTHY_CODE;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly recovering: boolean;
  readonly deviceId?: string;
  readonly reason?: string;
  readonly devices: readonly UnhealthyDeviceEvidence[];

  constructor(devices: readonly UnhealthyDeviceEvidence[], message: string) {
    super(message);
    this.name = "DeviceUnhealthyError";
    if (devices.length === 0) {
      throw new Error("DeviceUnhealthyError requires at least one unhealthy device");
    }
    this.devices = devices.map(({ deviceId, reason, recovering, retryAfterMs }) => ({
      deviceId,
      reason,
      recovering,
      ...(recovering && retryAfterMs !== undefined && Number.isFinite(retryAfterMs)
        ? { retryAfterMs: Math.max(1, Math.ceil(retryAfterMs)) }
        : {}),
    }));
    this.recovering = this.retryable = this.devices.some((device) => device.recovering);
    const bounds = this.devices.flatMap((device) =>
      device.retryAfterMs === undefined ? [] : [device.retryAfterMs],
    );
    if (bounds.length > 0) {
      this.retryAfterMs = Math.min(...bounds);
    }
    if (this.devices.length === 1) {
      this.deviceId = this.devices[0]!.deviceId;
      this.reason = this.devices[0]!.reason;
    }
  }

  toPayload(): Record<string, unknown> {
    return {
      code: this.code,
      ...(this.deviceId === undefined ? {} : { deviceId: this.deviceId, reason: this.reason }),
      recovering: this.recovering,
      retryable: this.retryable,
      ...(this.retryAfterMs === undefined ? {} : { retryAfterMs: this.retryAfterMs }),
      devices: this.devices,
    };
  }
}
