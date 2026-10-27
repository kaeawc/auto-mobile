import { ActionableError } from "../models/ActionableError";

export const AMBIGUOUS_DEVICE_TARGET_CODE = "ambiguous_device_target";

/** The caller must choose among the devices already found by the routing scan. */
export class AmbiguousDeviceTargetError extends ActionableError {
  readonly code = AMBIGUOUS_DEVICE_TARGET_CODE;
  readonly retryable = false;
  readonly candidates: readonly { deviceId: string; platform: string }[];

  constructor(message: string, candidates: readonly { deviceId: string; platform: string }[]) {
    super(`${message} (code ${AMBIGUOUS_DEVICE_TARGET_CODE})`);
    this.name = "AmbiguousDeviceTargetError";
    this.candidates = candidates.map(({ deviceId, platform }) => ({ deviceId, platform }));
  }

  toPayload(): Record<string, unknown> {
    return { code: this.code, candidates: this.candidates, retryable: false };
  }
}
