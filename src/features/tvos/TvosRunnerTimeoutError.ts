import { ActionableError } from "../../models/ActionableError";

/**
 * A command reached the runner and got no answer before its deadline. The connection is closed
 * so later calls fail at once instead of queueing behind the stuck command (#17310).
 */
export class TvosRunnerTimeoutError extends ActionableError {
  constructor(commandType: string, timeoutMs: number) {
    super(
      `The tvOS runner did not answer ${commandType} within ${timeoutMs}ms and was disconnected; ` +
        "it can stick while XCTest waits for an app that is not in front. " +
        "Call startDevice to restart the runner, then retry.",
    );
  }
}
