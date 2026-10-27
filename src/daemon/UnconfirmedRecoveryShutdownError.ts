import { ActionableError } from "../models";

export class UnconfirmedRecoveryShutdownError extends ActionableError {
  constructor(avdName: string, cause: unknown) {
    super(
      `Shutdown of Android emulator '${avdName}' is unconfirmed; recovery ownership remains quarantined`,
      { cause },
    );
  }
}
