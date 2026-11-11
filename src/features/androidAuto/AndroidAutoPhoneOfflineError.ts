import { ActionableError } from "../../models/ActionableError";

/**
 * adb never reported the phone as `device`, so no provisioning step ran and the phone is
 * unchanged, so a caller's failed rollback reports this error rather than its own.
 */
export class AndroidAutoPhoneOfflineError extends ActionableError {
  constructor(
    readonly deviceId: string,
    message: string,
  ) {
    super(message);
    this.name = "AndroidAutoPhoneOfflineError";
  }
}
