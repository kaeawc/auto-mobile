import { shapeToolCallError } from "../../src/server/shapeToolCallError";
import { SessionRecoveryAssignmentError } from "../../src/models/SessionRecoveryAssignmentError";
import { describe, expect, test } from "bun:test";
import { TerminalSessionError, type SessionReleaseSnapshot } from "../../src/daemon/sessionManager";
import {
  sessionOwnershipLostPayload,
  declaresDeviceSessionInvalid,
  terminalSessionRefusalFields,
} from "../../src/server/deviceSessionResult";

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
          retryable: false,
          nextAction: "acquire_new_session",
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
        retryable: false,
        nextAction: "acquire_new_session",
        recovery: {
          action: "acquire_replacement_session",
          tools: ["getAndroid", "getApple"],
        },
      },
    });
  });
});

test("pending recovery stays valid for current and future lost-code consumers", () => {
  const error = new SessionRecoveryAssignmentError({
    sessionUuid: "session-a",
    platform: "android",
    deviceId: "emulator-5554",
    stableDeviceId: "Pixel_8_API_35",
    recoveryWindowRemainingMs: 120_000,
  });
  const result = shapeToolCallError(error, { toolName: "observe", source: "MCP" });
  expect(declaresDeviceSessionInvalid(result)).toBe(false);
  const payload = JSON.parse(result.content[0].text);
  expect(payload.error.retryable).toBe(true);
  // A future consumer dispatching only on the established lost-session codes.
  expect(
    ["session_ownership_lost", "no_active_device_session", "daemon_session_not_found"].includes(
      payload.error.code,
    ),
  ).toBe(false);
  for (const code of ["session_ownership_lost", "no_active_device_session"]) {
    expect(
      declaresDeviceSessionInvalid({
        isError: true,
        content: [{ type: "text", text: JSON.stringify({ error: { code } }) }],
      }),
    ).toBe(true);
  }
});

describe("terminal-session refusals name the next action, not a retry (#11098)", () => {
  test("terminalSessionRefusalFields is non-retryable and says acquire_new_session", () => {
    expect(terminalSessionRefusalFields()).toEqual({
      retryable: false,
      nextAction: "acquire_new_session",
      recovery: { action: "acquire_replacement_session", tools: ["getAndroid", "getApple"] },
    });
  });

  test.each(["target-absent", "target-busy", "identity-continuity-lost", "owned-by-other-daemon"])(
    "identity-recovery-%s carries the terminal reason and, when known, ownerPid",
    (reason) => {
      const releaseReason = `identity-recovery-${reason}`;
      const error = sessionOwnershipLostPayload({
        message: "Terminal.",
        sessionUuid: "session-123",
        reason: releaseReason,
        release: {
          sessionId: "session-123",
          deviceId: "emulator-5554",
          releaseReason,
          releasedAtMs: 2,
          terminal: true,
          ownerPid: 4242,
          heartbeat: {
            lastHeartbeatMs: 1,
            hasReceivedHeartbeat: true,
            timeoutMs: 20_000,
            ageMs: 1,
          },
        },
      }).error;
      expect(error).toMatchObject({
        code: "session_ownership_lost",
        reason: releaseReason,
        retryable: false,
        nextAction: "acquire_new_session",
        ownerPid: 4242,
      });
    },
  );

  test("ownerPid is omitted when unknown", () => {
    const { error } = sessionOwnershipLostPayload({
      message: "Terminal.",
      sessionUuid: "session-123",
      reason: "explicit-release",
    });
    expect("ownerPid" in error).toBe(false);
  });
});
