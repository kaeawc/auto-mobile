import type { NonIosApplePlatform } from "../../models/Platform";
import { deviceSessionRecoveryPrompt } from "./sessionRecoveryPrompt";

/**
 * Raised when a call that does NOT reference a specific device session reaches a
 * connection whose only binding — one MINTED by a device-acquisition RESULT, and
 * therefore never named by the client — has been terminally released. Naming a
 * stale UUID the caller never referenced would misattribute the loss; instead
 * this reports the CURRENT connection state and directs the caller to acquire a
 * fresh session (issue #5689). A watchOS, tvOS or visionOS session is told to call
 * startDevice with its platform instead (#19234), once the proxy has named the released
 * session's platform with {@link forPlatform}.
 */
export class DaemonConnectionSessionReleasedError extends Error {
  readonly reason: string;
  /** The released session, kept only to look up its platform; never shown to the caller. */
  readonly sessionUuid?: string;
  /** The released session's platform, when it is one getAndroid and getApple cannot acquire. */
  platform?: NonIosApplePlatform;

  constructor(reason: string, sessionUuid?: string) {
    super(DaemonConnectionSessionReleasedError.messageFor(reason));
    this.name = "DaemonConnectionSessionReleasedError";
    this.reason = reason;
    this.sessionUuid = sessionUuid;
  }

  /** Name the released session's platform, so the recovery prose names a tool that can acquire it. */
  forPlatform(platform: NonIosApplePlatform): this {
    this.platform = platform;
    this.message = DaemonConnectionSessionReleasedError.messageFor(this.reason, platform);
    return this;
  }

  private static messageFor(reason: string, platform?: NonIosApplePlatform): string {
    return (
      `This MCP connection has no active device session (the previous session was released: ${reason}). ` +
      deviceSessionRecoveryPrompt(platform)
    );
  }
}
