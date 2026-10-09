import { ActionableError } from "./ActionableError";

/** Why a signing identity guard refused to let an app mutation start. */
export type SigningGuardReason =
  /** The installed package's complete signer set differs from the expected one. */
  | "mismatch"
  /** The package is not installed, so the expected identity cannot be confirmed. */
  | "absent"
  /** Presence could not be established (failed, timed-out or malformed lookup). */
  | "presence-unknown"
  /** The package is installed but its signing certificates could not be read. */
  | "signing-unavailable";

/**
 * Raised before any destructive step when a caller-requested signing identity check does not
 * pass. Nothing on the device has been changed when this is thrown.
 */
export class SigningGuardError extends ActionableError {
  constructor(
    readonly reason: SigningGuardReason,
    message: string,
    readonly details: {
      appId: string;
      userId: number;
      expectedSha256: string[];
      actualSha256?: string[];
    },
  ) {
    super(message);
    this.name = "SigningGuardError";
  }
}
