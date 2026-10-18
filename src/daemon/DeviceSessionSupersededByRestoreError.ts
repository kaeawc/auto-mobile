import { ActionableError } from "../models/ActionableError";
import type { RetiredDeviceSession } from "./deviceSessionRegistry";

/** Restore retirement is distinct from an unknown or disconnected epoch. */
export class DeviceSessionSupersededByRestoreError extends ActionableError {
  readonly code = "DEVICE_SESSION_SUPERSEDED_BY_RESTORE";

  constructor(
    deviceSessionUuid: string,
    readonly retired: RetiredDeviceSession,
  ) {
    super(
      `deviceSessionUuid '${deviceSessionUuid}' was superseded by a snapshot restore. ` +
        "Get the current deviceSessionUuid from the deviceSnapshot restore result, the " +
        "device_session_started frame, daemon/listDeviceSessions, or the device description's runtime.deviceSessionUuid.",
    );
  }
}
