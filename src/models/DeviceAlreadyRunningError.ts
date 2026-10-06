import { ActionableError } from "./ActionableError";
import type { Platform } from "./Platform";

/**
 * A boot was refused because the device is already booted. Typed so callers
 * that can adopt the running device (iOS startDevice behind a sibling boot)
 * branch on the class rather than the message text.
 */
export class DeviceAlreadyRunningError extends ActionableError {
  constructor(
    message: string,
    readonly platform: Platform,
    readonly deviceId?: string,
  ) {
    super(message);
  }
}
