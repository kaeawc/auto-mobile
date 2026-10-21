import { ActionableError } from "../models/ActionableError";

/**
 * An upsert that must not revive an ended UUID ({@link UpsertActiveSessionOptions.unlessTerminal},
 * #11498) found the row released for a terminal reason. Nothing was written: the session the
 * caller holds has been terminally released, whoever wrote the release.
 */
export class DeviceSessionTerminallyReleasedError extends ActionableError {
  constructor(readonly sessionUuid: string) {
    super(
      `Device session ${sessionUuid} was terminally released; its row was not made active again.`,
    );
    this.name = "DeviceSessionTerminallyReleasedError";
  }
}
