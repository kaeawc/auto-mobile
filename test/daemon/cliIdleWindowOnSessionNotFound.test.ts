import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SessionManager } from "../../src/daemon/sessionManager";
import {
  handleDaemonRequest,
  type DaemonMethodResult,
  type DaemonStateAccess,
} from "../../src/daemon/daemonRequestHandlers";
import { DeviceSessionRegistry } from "../../src/daemon/deviceSessionRegistry";
import { sessionOwnershipLostPayload } from "../../src/daemon/deviceSessionResult";
import {
  DAEMON_SESSION_NOT_FOUND_CODE,
  releasedSessionNotFoundFields,
} from "../../src/daemon/types";
import { releaseReasonField } from "../../src/daemon/client/clientResponseDecoding";
import { DaemonCommandRefusal } from "../../src/daemon/cli/runDaemonCommand";
import { buildDeviceLabelMap } from "../../src/server/deviceLabelMapping";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../fakes/FakeTimer";
import { asPlanAllocation } from "../helpers/planLabelAllocation";

// A cli-idle-timeout release reports the CLI idle window the session itself had (#16908) on every
// answer about it: session-not-found from daemon/heartbeat and daemon/sessionInfo, and the
// daemon/registerSession refusal (#16937), also after a restart. A plan label that only inherits
// its base's cli-idle-timeout never adopted a window, so it reports none (#16940).

const BASE = "16937000-0000-4000-8000-000000000001";
const DEVICE = "emulator-5554";
const WINDOW_MS = 300_000;

const DEVICE_POOL = {
  refreshDevices: async () => 0,
  getStats: () => ({ total: 1, idle: 0, assigned: 1, error: 0 }),
  releaseDevice: async () => {},
};

const ENV_KEYS = [
  "AUTOMOBILE_CLI_SESSION_IDLE_TIMEOUT_MS",
  "AUTO_MOBILE_CLI_SESSION_IDLE_TIMEOUT_MS",
] as const;

function clearEnv(): void {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
}

let timer: FakeTimer;
let persistence: FakeDeviceSessionPersistence;
let managers: SessionManager[];

function newManager(): SessionManager {
  const manager = new SessionManager(timer, persistence);
  managers.push(manager);
  return manager;
}

function request(
  manager: SessionManager,
  method: string,
  params: Record<string, unknown>,
): Promise<DaemonMethodResult> {
  const state: DaemonStateAccess = {
    isInitialized: () => true,
    getSessionManager: () => manager,
    getDevicePool: () => DEVICE_POOL,
    getDeviceSessionRegistry: () => new DeviceSessionRegistry(),
  };
  return handleDaemonRequest({ id: method, type: "daemon_request", method, params }, state);
}

/** A CLI session that adopted `WINDOW_MS` and was then released by that window. */
async function cliIdleReleased(manager: SessionManager): Promise<void> {
  await manager.createSession(BASE, DEVICE, "android", { timeoutMs: 60_000 });
  manager.adoptCliLivenessPolicy(BASE, WINDOW_MS);
  await manager.releaseSession(BASE, "cli-idle-timeout");
}

beforeEach(() => {
  clearEnv();
  timer = new FakeTimer();
  timer.setCurrentTime(1_000_000);
  persistence = new FakeDeviceSessionPersistence();
  managers = [];
});

afterEach(() => {
  for (const manager of managers) {
    manager.stopCleanupTimer();
  }
  clearEnv();
});

describe("session-not-found answers carry the cli idle window (#16937)", () => {
  test("daemon/heartbeat and daemon/sessionInfo report it beside the reason", async () => {
    const manager = newManager();
    await cliIdleReleased(manager);

    for (const method of ["daemon/heartbeat", "daemon/sessionInfo"]) {
      const answer = await request(manager, method, { sessionId: BASE });
      expect(answer, method).toMatchObject({
        success: false,
        code: DAEMON_SESSION_NOT_FOUND_CODE,
        releaseReason: "cli-idle-timeout",
        idle: true,
        idleTimeoutMs: WINDOW_MS,
      });
    }
  });

  test("a restarted daemon reads the window from the persisted row", async () => {
    await cliIdleReleased(newManager());
    const restarted = newManager();

    expect(await restarted.getReleasedSessionIdleTimeoutMs(BASE)).toBe(WINDOW_MS);
    const answer = await request(restarted, "daemon/sessionInfo", { sessionId: BASE });
    expect(answer).toMatchObject({ releaseReason: "cli-idle-timeout", idleTimeoutMs: WINDOW_MS });
    const refusal = await request(restarted, "daemon/registerSession", {
      sessionId: BASE,
      clientName: "cli",
    });
    expect(refusal.details).toMatchObject({ reason: "cli-idle-timeout", idleTimeoutMs: WINDOW_MS });
  });

  test("daemon/registerSession's terminal refusal carries it in details", async () => {
    const manager = newManager();
    await cliIdleReleased(manager);

    const refusal = await request(manager, "daemon/registerSession", {
      sessionId: BASE,
      clientName: "cli",
    });
    expect(refusal).toMatchObject({
      success: false,
      code: "session_ownership_lost",
      details: { reason: "cli-idle-timeout", idle: true, idleTimeoutMs: WINDOW_MS },
      releaseReason: "cli-idle-timeout",
      idleTimeoutMs: WINDOW_MS,
    });
  });

  test("other releases carry no window", async () => {
    const manager = newManager();
    await manager.createSession(BASE, DEVICE, "android", { timeoutMs: 60_000 });
    manager.adoptCliLivenessPolicy(BASE, WINDOW_MS);
    await manager.releaseSession(BASE, "explicit-release");

    const answer = await request(manager, "daemon/sessionInfo", { sessionId: BASE });
    expect(answer.releaseReason).toBe("explicit-release");
    expect("idleTimeoutMs" in answer).toBe(false);
    expect(releasedSessionNotFoundFields("cleanup-expired", WINDOW_MS)).toEqual({
      releaseReason: "cleanup-expired",
      idle: true,
    });
  });

  test("the CLI states the window in its text and --json output", () => {
    const decoded = releaseReasonField({
      id: "r",
      type: "mcp_response",
      success: false,
      releaseReason: "cli-idle-timeout",
      idleTimeoutMs: WINDOW_MS,
    });
    expect(decoded).toEqual({
      releaseReason: "cli-idle-timeout",
      idle: true,
      idleTimeoutMs: WINDOW_MS,
    });

    const refusal = new DaemonCommandRefusal(
      "Failed to get session info",
      Object.assign(new Error(`Session not found: ${BASE}`), decoded),
    );
    expect(refusal.message).toContain("(released: cli-idle-timeout, idle, idle timeout 300000 ms)");
    expect(refusal.idleTimeoutMs).toBe(WINDOW_MS);
  });
});

describe("a plan label inheriting its base's cli-idle-timeout reports no window (#16940)", () => {
  async function baseWithLabel(manager: SessionManager): Promise<string> {
    const labelId = `${BASE}:B`;
    await manager.createSession(BASE, DEVICE, "android", { timeoutMs: 60_000 });
    manager.adoptCliLivenessPolicy(BASE, WINDOW_MS);
    await asPlanAllocation(manager, BASE, [labelId], () =>
      manager.createSession(labelId, "emulator-5556", "android", {
        timeoutMs: 60_000,
        heartbeatTimeoutMs: 10_000,
      }),
    );
    manager.setDeviceLabels(BASE, buildDeviceLabelMap(["A", "B"], BASE));
    await manager.releaseSession(BASE, "cli-idle-timeout");
    return labelId;
  }

  test("the label's refusal omits idleTimeoutMs; the base's keeps its own window", async () => {
    const manager = newManager();
    const labelId = await baseWithLabel(manager);

    const labelAnswer = manager.peekTerminalAnswerForEndedSession(labelId);
    expect(labelAnswer?.release.releaseReason).toBe("cli-idle-timeout");
    expect(labelAnswer?.release.heartbeat.timeoutMs).toBe(10_000);
    const labelPayload = sessionOwnershipLostPayload({
      message: "gone",
      sessionUuid: labelId,
      reason: "cli-idle-timeout",
      release: labelAnswer?.release,
    }).error;
    expect(labelPayload).toMatchObject({ reason: "cli-idle-timeout", idle: true });
    expect("idleTimeoutMs" in labelPayload).toBe(false);

    const baseRelease = manager.getTerminalReleaseSnapshot(BASE);
    expect(baseRelease?.cliIdleTimeoutMs).toBe(WINDOW_MS);
    expect(
      sessionOwnershipLostPayload({
        message: "gone",
        sessionUuid: BASE,
        reason: "cli-idle-timeout",
        release: baseRelease,
      }).error.idleTimeoutMs,
    ).toBe(WINDOW_MS);
  });

  test("the label's session-not-found answer omits it too", async () => {
    const manager = newManager();
    const labelId = await baseWithLabel(manager);

    expect(await manager.getReleasedSessionIdleTimeoutMs(labelId)).toBeUndefined();
    const answer = await request(manager, "daemon/sessionInfo", { sessionId: labelId });
    expect(answer.releaseReason).toBe("cli-idle-timeout");
    expect("idleTimeoutMs" in answer).toBe(false);
  });
});
