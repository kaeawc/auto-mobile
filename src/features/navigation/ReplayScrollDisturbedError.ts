import { ReplayTransientError } from "./ReplayTransientError";

/**
 * A replay refused because an earlier failed search in the same call left the list
 * scrolled to an unknown position: an edge addressed by recorded coordinates would tap
 * whatever is there now.
 */
export class ReplayScrollDisturbedError extends ReplayTransientError {
  constructor(message: string) {
    super(message, false);
  }
}
