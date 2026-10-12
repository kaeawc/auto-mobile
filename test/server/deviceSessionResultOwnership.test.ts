import { SUSPECT_GRACE_MS } from "../../src/daemon/sessionLivenessWindows";
import { shapeToolCallError } from "../../src/server/shapeToolCallError";
import { SessionRecoveryAssignmentError } from "../../src/models/SessionRecoveryAssignmentError";
import { describe, expect, test } from "bun:test";
import {
  SessionNoLongerOwnsDeviceError,
  SessionRecoveryIdentityLossError,
  SessionTerminalReleaseInProgressError,
  TerminalSessionError,
  type SessionReleaseSnapshot,
} from "../../src/daemon/sessionManager";
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
            ` No heartbeat for 21001 ms (limit ${releaseReason === "heartbeat-timeout" ? 20_000 + SUSPECT_GRACE_MS : 20_000} ms; set AUTOMOBILE_SESSION_HEARTBEAT_TIMEOUT_MS to change).`,
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

describe("declaresDeviceSessionInvalid reads the real serializer output (#11296)", () => {
  test("recognises the top-level shape shapeToolCallError emits for a terminal release", () => {
    const result = shapeToolCallError(
      new SessionTerminalReleaseInProgressError("session-x", "emulator-5554", "is being released"),
      { toolName: "tapOn", source: "MCP" },
    );
    const payload = JSON.parse(result.content[0].text);
    expect(payload.code).toBe("session_terminal_release_in_progress");
    expect(typeof payload.error).toBe("string");
    expect(declaresDeviceSessionInvalid(result)).toBe(true);
  });

  test("recognises the nested shape of sessionOwnershipLostPayload via structuredContent", () => {
    const payload = sessionOwnershipLostPayload({
      message: "Ownership lost.",
      sessionUuid: "session-x",
      reason: "device-killed",
    });
    expect(
      declaresDeviceSessionInvalid({ isError: true, structuredContent: payload, content: [] }),
    ).toBe(true);
  });

  test("recognises nextAction acquire_new_session without a known code, top-level or nested", () => {
    const text = (value: unknown) => ({
      isError: true,
      content: [{ type: "text", text: JSON.stringify(value) }],
    });
    expect(
      declaresDeviceSessionInvalid(
        text({ code: "future_code", nextAction: "acquire_new_session" }),
      ),
    ).toBe(true);
    expect(
      declaresDeviceSessionInvalid(
        text({ error: { code: "future_code", nextAction: "acquire_new_session" } }),
      ),
    ).toBe(true);
  });

  test("stays false for refusals that leave the session live or recoverable", () => {
    const rebound = shapeToolCallError(
      new SessionNoLongerOwnsDeviceError("session-x", "emulator-5554"),
      { toolName: "killDevice", source: "MCP" },
    );
    expect(declaresDeviceSessionInvalid(rebound)).toBe(false);
    expect(
      declaresDeviceSessionInvalid({
        isError: true,
        content: [{ type: "text", text: "tap failed: session_ownership_lost mentioned in prose" }],
      }),
    ).toBe(false);
    expect(
      declaresDeviceSessionInvalid({
        content: [{ type: "text", text: JSON.stringify({ code: "session_ownership_lost" }) }],
      }),
    ).toBe(false);
  });
});

describe("a persisted session lost to recovery identity loss is a terminal-session refusal (#11391)", () => {
  const target = {
    platform: "android" as const,
    stableDeviceId: "stable-1",
    deviceId: "emulator-5554",
  };
  type Reason = ConstructorParameters<typeof SessionRecoveryIdentityLossError>[2];
  const REASONS: Reason[] = [
    "target-absent",
    "target-busy",
    "identity-continuity-lost",
    "owned-by-other-daemon",
  ];

  function identityLossResult(reason: Reason) {
    const error = new SessionRecoveryIdentityLossError(
      "dead-session",
      target,
      reason,
      reason === "owned-by-other-daemon"
        ? { deviceId: "emulator-5554", ownerPid: 4242 }
        : undefined,
    );
    return shapeToolCallError(error, { toolName: "tapOn", source: "MCP" });
  }

  test.each(REASONS)("%s is answered with the standard terminal refusal", (reason) => {
    const result = identityLossResult(reason);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.error).toMatchObject({
      code: "session_ownership_lost",
      sessionUuid: "dead-session",
      // What a later call naming the terminalized UUID is told (TerminalSessionError).
      reason: `identity-recovery-${reason}`,
      recoveryReason: reason,
      deviceId: "emulator-5554",
      ...terminalSessionRefusalFields(reason === "owned-by-other-daemon" ? 4242 : undefined),
    });
    expect(payload.error.message).toContain("Cannot safely recover session dead-session");
    expect("ownerPid" in payload.error).toBe(reason === "owned-by-other-daemon");
  });

  test.each(REASONS)("%s is recognised by declaresDeviceSessionInvalid", (reason) => {
    expect(declaresDeviceSessionInvalid(identityLossResult(reason))).toBe(true);
  });

  test("owned-by-other-daemon does not carry the wait-class acquisition code", () => {
    // device_owned_by_other_daemon tells a runner to wait for the other daemon (refusal-wire
    // expectations: retryable, retryAfterMs 2000); this session UUID never comes back.
    const text = identityLossResult("owned-by-other-daemon").content[0].text;
    expect(JSON.parse(text).error.code).toBe("session_ownership_lost");
    expect(JSON.parse(text).code).toBeUndefined();
  });
});
