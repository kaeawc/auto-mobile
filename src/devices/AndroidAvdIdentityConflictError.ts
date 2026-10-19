import { ActionableError } from "../models";

/** More than one live emulator claims the requested stable AVD identity. */
export class AndroidAvdIdentityConflictError extends ActionableError {
  readonly code = "identity_conflict";

  constructor(
    readonly avdName: string,
    readonly candidateSerials: readonly string[],
  ) {
    super(
      `identity_conflict: Android AVD '${avdName}' is claimed by multiple running ` +
        `emulators: ${candidateSerials.join(", ")}. Pass an explicit deviceId (ADB serial) to select one.`,
    );
  }
}
