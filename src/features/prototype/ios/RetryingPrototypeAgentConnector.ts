import { fixedBackoff, type BackoffPolicy } from "../../../utils/Backoff";
import { errorMessage } from "../../../utils/describeUnknownError";
import { logger } from "../../../utils/logger";
import type { Timer } from "../../../utils/SystemTimer";
import { type PrototypeAgentConnector, type PrototypeAgentSocket } from "./prototypeAgentClient";

export const DEFAULT_CONNECT_ATTEMPTS = 10;

export const DEFAULT_CONNECT_RETRY_DELAY_MS = 200;

/**
 * Retries refused connections while the app's agent starts its listener. Only `connect` is
 * retried; a handshake failure is a real error and surfaces at once.
 */
export class RetryingPrototypeAgentConnector implements PrototypeAgentConnector {
  constructor(
    private readonly connector: PrototypeAgentConnector,
    private readonly timer: Timer,
    private readonly attempts: number = DEFAULT_CONNECT_ATTEMPTS,
    private readonly backoff: BackoffPolicy = fixedBackoff(DEFAULT_CONNECT_RETRY_DELAY_MS),
  ) {}

  async connect(port: number): Promise<PrototypeAgentSocket> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.attempts; attempt++) {
      try {
        return await this.connector.connect(port);
      } catch (error) {
        lastError = error;
        if (attempt < this.attempts) {
          // A refused connection is expected until the agent's listener is up; retry.
          logger.debug(
            `[prototype-agent] connect to ${port} attempt ${attempt} failed: ${errorMessage(error)}`,
          );
          await this.timer.sleep(this.backoff.delayForAttempt(attempt));
        }
      }
    }
    throw lastError;
  }
}
