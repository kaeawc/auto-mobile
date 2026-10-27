import { ActionableError } from "../models/ActionableError";

/**
 * A recovery's upsert of a claimed recoverable row (#11243) found the row no longer the incarnation
 * it claimed: a terminal release, a peer, or the claim's own hand-back changed it first. Nothing
 * was written.
 */
export class DeviceSessionRowChangedError extends ActionableError {
  constructor(readonly sessionUuid: string) {
    super(
      `Device session ${sessionUuid} changed while it was being recovered; the recovery did not ` +
        "persist it.",
    );
    this.name = "DeviceSessionRowChangedError";
  }
}
