import { ActionableError } from "../../models/ActionableError";

/** Typed failures of the health seeding contract (#14215, #18801). */
/**
 * `verification_failed`: the save succeeded but a sample type did not read back.
 * `read_failed`: a `health.read` query failed for a reason other than authorization.
 */
export type HealthSeedErrorCode =
  | "unavailable"
  | "permission_denied"
  | "unsupported"
  | "verification_failed"
  | "read_failed";

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
