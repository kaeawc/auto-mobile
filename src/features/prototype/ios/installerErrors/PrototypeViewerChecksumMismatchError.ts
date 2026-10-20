import { ActionableError } from "../../../../models/ActionableError";

export class PrototypeViewerChecksumMismatchError extends ActionableError {
  readonly code = "prototype_template_checksum_mismatch";
  constructor(
    readonly expected: string,
    readonly actual: string,
  ) {
    super(
      `Prototype viewer checksum verification failed. Expected: ${expected}, Got: ${actual}. The downloaded archive was deleted; retry with a trusted release or build a local template.`,
    );
  }
}
