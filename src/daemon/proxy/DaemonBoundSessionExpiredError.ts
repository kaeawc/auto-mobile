import { ActionableError } from "../../models";
import type { NonIosApplePlatform } from "../../models/Platform";
import {
  DEVICE_SESSION_RECOVERY_PROMPT,
  deviceSessionRecoveryPrompt,
} from "./sessionRecoveryPrompt";
import type { SessionReleaseSnapshot } from "../sessionManager/releaseTypes";

/**
 * Raised after a daemon release proves that this transport's device-session
 * identity is terminal. The transport must never silently resurrect its UUID
 * against another device; an explicit getAndroid/getApple on the same transport
 * acquires a new session (#5689), which is what the message tells the agent (#10702).
 * A watchOS, tvOS or visionOS session is told to call startDevice with its platform instead
 * (#19186), once the proxy has named the session's platform with {@link forPlatform}.
 */
export class DaemonBoundSessionExpiredError extends ActionableError {
  readonly sessionUuid: string;
  readonly reason: string;
  readonly release?: SessionReleaseSnapshot;
  /** The lost session's platform, when it is one getAndroid and getApple cannot acquire. */
  platform?: NonIosApplePlatform;

  constructor(sessionUuid: string, reason: string, release?: SessionReleaseSnapshot) {
    super(DaemonBoundSessionExpiredError.messageFor(sessionUuid, reason));
    this.name = "DaemonBoundSessionExpiredError";
    this.sessionUuid = sessionUuid;
    this.reason = reason;
    this.release = release;
  }

  private static messageFor(
    sessionUuid: string,
    reason: string,
    platform?: NonIosApplePlatform,
  ): string {
    const prompt =
      platform === undefined
        ? DEVICE_SESSION_RECOVERY_PROMPT
        : deviceSessionRecoveryPrompt(platform);
    return (
      `Device session ${sessionUuid} expired or was released (${reason}) and cannot be used ` +
      `again. ${prompt}`
    );
  }

  /** Name the lost session's platform, so the recovery prose names a tool that can acquire it. */
  forPlatform(platform: NonIosApplePlatform): this {
    this.platform = platform;
    this.message = DaemonBoundSessionExpiredError.messageFor(
      this.sessionUuid,
      this.reason,
      platform,
    );
    return this;
  }
}
