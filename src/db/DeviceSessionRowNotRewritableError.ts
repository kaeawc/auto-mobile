import { ActionableError } from "../models/ActionableError";

/** A superseded-release rewrite found another terminal release or a live peer's row (#11557). */
export class DeviceSessionRowNotRewritableError extends ActionableError {
  constructor(readonly sessionUuid: string) {
    super(
      `Device session ${sessionUuid} was not rewritten: its row holds another terminal release ` +
        "or a live peer daemon owns it.",
    );
    this.name = "DeviceSessionRowNotRewritableError";
  }
}
