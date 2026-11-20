import { ActionableError } from "../../models/ActionableError";

/** Typed failures of the health seeding contract (#14215, #18801). */
export type HealthSeedErrorCode = "unavailable" | "permission_denied" | "unsupported";

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
