import { ActionableError } from "../models/ActionableError";

/** A guarded release matched no writable row; this is a refusal, not a storage failure. */
export class DeviceSessionRowNotReleasableError extends ActionableError {
  constructor(readonly sessionUuid: string) {
    super(
      `Device session ${sessionUuid} was not released: its row is terminal or owned by a live peer.`,
    );
    this.name = "DeviceSessionRowNotReleasableError";
  }
}
