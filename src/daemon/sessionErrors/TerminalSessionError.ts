import type { SessionReleaseSnapshot } from "../sessionManager";

export const TERMINAL_RELEASE_IN_PROGRESS_DETAIL =
  "is being terminally released from its device; use a new session UUID";

export class TerminalSessionError extends Error {
  constructor(
    readonly sessionUuid: string,
    readonly release: SessionReleaseSnapshot,
  ) {
    super(
      (release.releaseReason === "explicit-release"
        ? `Session ${sessionUuid} was released and cannot be reused. `
        : `Session ${sessionUuid} is terminal after ${release.releaseReason} and cannot be reused. `) +
        "Acquire a new device with getAndroid or getApple.",
    );
    this.name = "TerminalSessionError";
  }
}
