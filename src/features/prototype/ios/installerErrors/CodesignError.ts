import { ActionableError } from "../../../../models/ActionableError";

export class CodesignError extends ActionableError {
  readonly code = "prototype_codesign";
  constructor(
    readonly step: "sign" | "verify",
    cause?: unknown,
  ) {
    super(`Could not ${step} the prototype viewer signature`, { cause });
  }
}
