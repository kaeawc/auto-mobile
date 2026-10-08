import { ActionableError } from "./ActionableError";

export interface RotationSettingManagedDetails {
  key: "user_rotation" | "accelerometer_rotation";
  expected: number;
  actual: string | null;
  retryable: false;
}

/**
 * A rotation setting read back differently after a restore on a device whose window manager
 * owns rotation per device state (a foldable). Retrying the write cannot verify while the
 * window manager keeps its own value, so callers must not retry.
 */
export class RotationSettingManagedError extends ActionableError {
  readonly details: RotationSettingManagedDetails;
  constructor(details: Omit<RotationSettingManagedDetails, "retryable">) {
    super(
      `Restoration of ${details.key}=${details.expected} read back ${details.actual ?? "unset"}: this device's window manager manages rotation per device state (fold posture), so the setting cannot be restored by writing it. Not retrying.`,
    );
    this.name = "RotationSettingManagedError";
    this.details = { ...details, retryable: false };
  }
}
