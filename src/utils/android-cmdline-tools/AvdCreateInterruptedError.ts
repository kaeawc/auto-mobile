import { ActionableError } from "../../models";

/**
 * `avdmanager create avd` was killed (timeout or signal) before it reported an
 * outcome, so the AVD may exist half-written. Unlike a clean non-zero exit
 * (`success: false`), the caller must treat the AVD as possibly created and
 * roll it back (#11155).
 */
export class AvdCreateInterruptedError extends ActionableError {
  constructor(
    public readonly avdName: string,
    detail: string,
  ) {
    super(`Failed to create AVD ${avdName}: ${detail}. The AVD may have been partially created.`);
    this.name = "AvdCreateInterruptedError";
  }
}
