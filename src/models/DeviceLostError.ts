export const DEVICE_LOSS_OUTCOME_CODE = "device_lost";

export class DeviceLostError extends Error {
  readonly code = DEVICE_LOSS_OUTCOME_CODE;

  constructor(
    readonly deviceId: string,
    reason: string,
    readonly incidentId?: string,
  ) {
    super(reason);
    this.name = "DeviceLostError";
  }
}
