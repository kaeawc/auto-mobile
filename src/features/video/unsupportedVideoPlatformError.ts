import { ActionableError } from "../../models";

/** A device descriptor can arrive off the wire with a platform outside the supported union. */
export function unsupportedVideoPlatformError(platform: string): ActionableError {
  return new ActionableError(`Unsupported platform for video recording: ${platform}`);
}
