import { ActionableError } from "../../models/ActionableError";

/**
 * A command issued after the runner connection was lost. It was never sent, so it reports its own
 * command rather than repeating whichever earlier failure disconnected the runner (#17384).
 */
export class TvosRunnerDisconnectedError extends ActionableError {
  constructor(
    commandType: string,
    readonly cause: ActionableError,
  ) {
    super(
      `The tvOS runner was already disconnected, so ${commandType} was not sent. ` +
        "Call startDevice to restart the runner, then retry.",
    );
  }
}
