import { ActionableError } from "../../models/ActionableError";

/** Typed failures of the health seeding contract (#14215, #18801). */
/** `verification_failed`: the save succeeded but a sample type did not read back. */
export type HealthSeedErrorCode =
  | "unavailable"
  | "permission_denied"
  | "unsupported"
  | "verification_failed";

export class HealthSeedError extends ActionableError {
  constructor(
    readonly code: HealthSeedErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message}`, options);
    this.name = "HealthSeedError";
  }
}
