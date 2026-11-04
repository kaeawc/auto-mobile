import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SessionManager } from "../../src/daemon/sessionManager";
import { SessionHeartbeatMonitor } from "../../src/daemon/SessionHeartbeatMonitor";
import { TerminalSessionError } from "../../src/daemon/sessionErrors/TerminalSessionError";
import {
  sessionOwnershipLostPayload,
  sessionReleasedDuringCallPayload,
} from "../../src/daemon/deviceSessionResult";
import { SessionReleasedDuringCallError } from "../../src/daemon/sessionReleasedDuringCall";
import { cliIdleTimeoutField } from "../../src/daemon/releaseReasons";
import type { SessionReleaseSnapshot } from "../../src/daemon/sessionManager";
import { cliDeviceOwnershipHint } from "../../src/cli/deviceOwnershipHint";
import { MAX_CLI_SESSION_IDLE_TIMEOUT_MS } from "../../src/daemon/wire/constants";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";

const ENV_KEYS = [
  "AUTOMOBILE_CLI_SESSION_IDLE_TIMEOUT_MS",
  "AUTO_MOBILE_CLI_SESSION_IDLE_TIMEOUT_MS",
] as const;

function clearEnv(): void {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
}

function snapshot(releaseReason: string, timeoutMs: number): SessionReleaseSnapshot {
  return {
    sessionId: "s",
    deviceId: "emulator-5554",
    releaseReason,
    releasedAtMs: 0,
    terminal: true,
    heartbeat: { lastHeartbeatMs: 0, hasReceivedHeartbeat: true, timeoutMs, ageMs: timeoutMs },
  };
}

// #16908: a later --cli invocation cannot rebuild the idle window its session was adopted with,
// so the cli-idle-timeout refusal carries it.
describe("the cli-idle-timeout refusal carries the applied idle window (#16908)", () => {
  let timer: FakeTimer;
  let manager: SessionManager;

  beforeEach(() => {
    clearEnv();
    timer = new FakeTimer();
    manager = new SessionManager(timer, new FakeDeviceSessionPersistence());
  });

  afterEach(() => {
    manager.stopCleanupTimer();
    clearEnv();
  });

  async function idleExpire(requestedIdleTimeoutMs: number): Promise<TerminalSessionError> {
    await manager.createSession("cli", "emulator-5554", "android", { timeoutMs: 60_000 });
    manager.adoptCliLivenessPolicy("cli", requestedIdleTimeoutMs);
    const appliedMs = manager.getSession("cli")!.heartbeatTimeoutMs;
    const monitor = new SessionHeartbeatMonitor(
      manager,
      () => false,
      async (sessionId, reason) => {
        await manager.releaseSession(sessionId, reason);
      },
      { timer },
    );
    timer.advanceTime(appliedMs + 1);
    await monitor.tick();
    try {
      await manager.admitIssuedSessionForAutomation("cli");
    } catch (error) {
      if (error instanceof TerminalSessionError) {
        return error;
      }
      throw error;
    }
    throw new Error("expected the idle-expired session to be refused");
  }

  function payloadOf(error: TerminalSessionError) {
    return sessionOwnershipLostPayload({
      message: error.message,
      sessionUuid: error.sessionUuid,
      reason: error.release.releaseReason,
      release: error.release,
    });
  }

  test("reports the window the adopting invocation asked for", async () => {
    const refusal = await idleExpire(300_000);
    expect(payloadOf(refusal).error).toMatchObject({
      code: "session_ownership_lost",
      reason: "cli-idle-timeout",
      idle: true,
      idleTimeoutMs: 300_000,
    });
  });

  test("reports the clamped window, not the requested one", async () => {
    const refusal = await idleExpire(MAX_CLI_SESSION_IDLE_TIMEOUT_MS * 2);
    const payload = payloadOf(refusal);
    expect(payload.error.idleTimeoutMs).toBe(MAX_CLI_SESSION_IDLE_TIMEOUT_MS);
    expect(cliDeviceOwnershipHint(payload, "observe")).toContain(
      `its idle timeout of 60 minutes (${MAX_CLI_SESSION_IDLE_TIMEOUT_MS} ms)`,
    );
  });

  test("other reasons carry no idle window", () => {
    const payload = sessionOwnershipLostPayload({
      message: "gone",
      sessionUuid: "s",
      reason: "heartbeat-timeout",
      release: snapshot("heartbeat-timeout", 10_000),
    });
    expect("idleTimeoutMs" in payload.error).toBe(false);
  });

  test("a SessionReleasedDuringCallError built with the cli idle window carries it", () => {
    const payload = sessionReleasedDuringCallPayload(
      new SessionReleasedDuringCallError("s", "cli-idle-timeout", 300_000),
    );
    expect(payload?.error).toMatchObject({ reason: "cli-idle-timeout", idleTimeoutMs: 300_000 });
    const other = new SessionReleasedDuringCallError("s", "heartbeat-timeout", 10_000);
    expect("idleTimeoutMs" in other.details).toBe(false);
  });

  test("the field is absent when the window is unknown or unusable", () => {
    expect(cliIdleTimeoutField("cli-idle-timeout", undefined)).toEqual({});
    expect(cliIdleTimeoutField("cli-idle-timeout", 0)).toEqual({});
    expect(cliIdleTimeoutField("cli-idle-timeout", 1.5)).toEqual({});
    expect(cliIdleTimeoutField("cleanup-expired", 120_000)).toEqual({});
    expect(cliIdleTimeoutField("cli-idle-timeout", 120_000)).toEqual({ idleTimeoutMs: 120_000 });
  });
});
