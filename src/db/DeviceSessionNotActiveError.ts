import { ActionableError } from "../models/ActionableError";

/**
 * An activity write matched no active row (#11129): a peer expired it, or it was released. The
 * write did not persist, so callers must not treat it as stored.
 */
export class DeviceSessionNotActiveError extends ActionableError {
  constructor(readonly sessionUuid: string) {
    super(`Device session ${sessionUuid} has no active row to record activity or ownership on.`);
    this.name = "DeviceSessionNotActiveError";
  }
}
