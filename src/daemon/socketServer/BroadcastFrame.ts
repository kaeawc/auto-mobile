import { logger } from "../../utils/logger";
import { errorMessage } from "../../utils/describeUnknownError";

/**
 * Stand-in subscription id used to serialize the broadcast template once. It is a plain
 * printable string (no control characters, nothing JSON escapes) so JSON.stringify emits it
 * verbatim. If it appears anywhere other than exactly once in the serialized frame (for
 * example inside payload data), `initialize` bails out and every message serializes normally.
 */
const PLACEHOLDER = "__automobile_broadcast_subscription_id_7f3a9c21__";

/** Serializes a broadcast once, replacing only its JSON-encoded subscription id. */
export class BroadcastFrame {
  private initialized = false;
  private template?: { prefix: string; suffix: string };

  constructor(private readonly build: (subscriptionId: string) => unknown) {}

  lineFor(subscriptionId: string, message: unknown): string {
    if (!this.initialized) {
      this.initialized = true;
      this.initialize();
    }
    if (this.template) {
      return this.template.prefix + JSON.stringify(subscriptionId) + this.template.suffix + "\n";
    }
    return JSON.stringify(message) + "\n";
  }

  private initialize(): void {
    try {
      const serialized = JSON.stringify(this.build(PLACEHOLDER));
      const token = JSON.stringify(PLACEHOLDER);
      if (serialized === undefined) {
        return;
      }
      const index = serialized.indexOf(token);
      if (index < 0 || serialized.indexOf(token, index + token.length) !== -1) {
        return;
      }
      this.template = {
        prefix: serialized.slice(0, index),
        suffix: serialized.slice(index + token.length),
      };
    } catch (error) {
      // Template serialization is optional; each real message still takes its normal error path.
      logger.debug(`Broadcast template unavailable: ${errorMessage(error)}`);
    }
  }
}
