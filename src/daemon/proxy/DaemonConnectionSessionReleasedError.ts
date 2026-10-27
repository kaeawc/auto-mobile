import { DEVICE_SESSION_RECOVERY_PROMPT } from "./sessionRecoveryPrompt";

/**
 * Raised when a call that does NOT reference a specific device session reaches a
 * connection whose only binding — one MINTED by a device-acquisition RESULT, and
 * therefore never named by the client — has been terminally released. Naming a
 * stale UUID the caller never referenced would misattribute the loss; instead
 * this reports the CURRENT connection state and directs the caller to acquire a
 * fresh session (issue #5689).
 */
export class DaemonConnectionSessionReleasedError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(
      `This MCP connection has no active device session (the previous session was released: ${reason}). ` +
        DEVICE_SESSION_RECOVERY_PROMPT,
    );
    this.name = "DaemonConnectionSessionReleasedError";
    this.reason = reason;
  }
}
