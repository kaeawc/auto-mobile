import type { ReleaseCommitFence, Session, SessionReleaseOptions } from "./sessionManager";

/**
 * The one options bag for releasing a session: the release options listeners see, plus
 * request-only controls. `allowExpired`, `commitFence`, and `expectedOwner` are consumed at the
 * entry point and never reach release listeners.
 */
export interface ReleaseSessionRequest extends SessionReleaseOptions {
  /** Release only this recorded session incarnation, and only while it still owns this device. */
  expectedOwner?: { session: Session; deviceId: string };
  /** Release a session already past its idle expiry instead of treating it as gone. */
  allowExpired?: boolean;
  /**
   * Re-evaluated synchronously immediately before the session is removed; returning false stops
   * the release (#7031).
   */
  commitFence?: ReleaseCommitFence;
}
