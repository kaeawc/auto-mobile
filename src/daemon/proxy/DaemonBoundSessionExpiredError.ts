import { ActionableError } from "../../models";
import { DEVICE_SESSION_RECOVERY_PROMPT } from "./sessionRecoveryPrompt";
import type { SessionReleaseSnapshot } from "../sessionManager/releaseTypes";

/**
 * Raised after a daemon release proves that this transport's device-session
 * identity is terminal. The transport must never silently resurrect its UUID
 * against another device; an explicit getAndroid/getApple on the same transport
 * acquires a new session (#5689), which is what the message tells the agent (#10702).
 */
export class DaemonBoundSessionExpiredError extends ActionableError {
  readonly sessionUuid: string;
  readonly reason: string;
  readonly release?: SessionReleaseSnapshot;

  constructor(sessionUuid: string, reason: string, release?: SessionReleaseSnapshot) {
    super(
      `Device session ${sessionUuid} expired or was released (${reason}) and cannot be used ` +
        `again. ${DEVICE_SESSION_RECOVERY_PROMPT}`,
    );
    this.name = "DaemonBoundSessionExpiredError";
    this.sessionUuid = sessionUuid;
    this.reason = reason;
    this.release = release;
  }
}
