import type { ReleaseCommitFence, SessionReleaseOptions } from "./sessionManager";

/**
 * The one options bag for releasing a session: the release options listeners see, plus the two
 * request-only controls. `allowExpired` and `commitFence` are consumed at the entry point and never
 * reach release listeners.
 */
export interface ReleaseSessionRequest extends SessionReleaseOptions {
  /** Release a session already past its idle expiry instead of treating it as gone. */
  allowExpired?: boolean;
  /**
   * Re-evaluated synchronously immediately before the session is removed; returning false stops
   * the release (#7031).
   */
  commitFence?: ReleaseCommitFence;
}
