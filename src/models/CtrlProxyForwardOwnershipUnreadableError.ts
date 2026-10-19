import { ActionableError } from "./ActionableError";

export class CtrlProxyForwardOwnershipUnreadableError extends ActionableError {
  constructor(deviceId: string, reason: string) {
    super(
      `Cannot read CtrlProxy forward ownership on ${deviceId}: adb forward --list failed (${reason}); retry before driving this device.`,
    );
  }
}
