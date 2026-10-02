import { describe, expect, test } from "bun:test";
import { TerminalSessionError, type SessionReleaseSnapshot } from "../../src/daemon/sessionManager";
import { sessionOwnershipLostPayload } from "../../src/server/deviceSessionResult";

describe("sessionOwnershipLostPayload", () => {
  const release: SessionReleaseSnapshot = {
    sessionId: "session-123",
    deviceId: "emulator-5554",
    releaseReason: "heartbeat-timeout",
    releasedAtMs: 20_000,
    terminal: true,
    heartbeat: {
      lastHeartbeatMs: 9_000,
      hasReceivedHeartbeat: true,
      timeoutMs: 20_000,
      ageMs: 21_001,
    },
  };

  test.each(["heartbeat-timeout", "missing-first-heartbeat"])(
    "appends the recorded heartbeat diagnostics to the terminal message for %s",
    (releaseReason) => {
      const error = new TerminalSessionError(release.sessionId, {
        ...release,
        releaseReason,
        heartbeat: {
          ...release.heartbeat,
          hasReceivedHeartbeat: releaseReason === "heartbeat-timeout",
        },
      });

      expect(
        sessionOwnershipLostPayload({
          message: error.message,
          sessionUuid: error.sessionUuid,
          reason: error.release.releaseReason,
          release: error.release,
        }),
      ).toEqual({
        error: {
          code: "session_ownership_lost",
          message:
            error.message +
            " No heartbeat for 21001 ms (limit 20000 ms; set AUTOMOBILE_SESSION_HEARTBEAT_TIMEOUT_MS to change).",
          sessionUuid: "session-123",
          reason: releaseReason,
          retryable: true,
          recovery: {
            action: "acquire_replacement_session",
            tools: ["getAndroid", "getApple"],
          },
          release: error.release,
        },
      });
    },
  );

  test.each(["identity-recovery-target-busy", "explicit-release"])(
    "preserves the terminal message exactly for %s",
    (releaseReason) => {
      const error = new TerminalSessionError(release.sessionId, { ...release, releaseReason });
      expect(
        sessionOwnershipLostPayload({
          message: error.message,
          sessionUuid: error.sessionUuid,
          reason: error.release.releaseReason,
          release: error.release,
        }).error.message,
      ).toBe(error.message);
    },
  );

  test("omits the release key when the proxy has no snapshot", () => {
    expect(
      sessionOwnershipLostPayload({
        message: "Ownership lost.",
        sessionUuid: "session-123",
        reason: "heartbeat-timeout",
      }),
    ).toEqual({
      error: {
        code: "session_ownership_lost",
        message: "Ownership lost.",
        sessionUuid: "session-123",
        reason: "heartbeat-timeout",
        retryable: true,
        recovery: {
          action: "acquire_replacement_session",
          tools: ["getAndroid", "getApple"],
        },
      },
    });
  });
});
