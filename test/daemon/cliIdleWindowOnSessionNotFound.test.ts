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
import { registerDerivedLabelSessionReleaseCascade } from "../../src/daemon/derivedLabelSessionReleaseCascade";
import { mcpRequestFailureDetails } from "../../src/daemon/socketServer";
import type { SessionReleaseSnapshot } from "../../src/daemon/sessionManager";
import type { SessionReleaseReason } from "../../src/daemon/releaseReasons";

// A cli-idle-timeout release reports the CLI idle window the session itself had (#16908) on every
// answer about it: session-not-found from daemon/heartbeat and daemon/sessionInfo, and the
// daemon/registerSession refusal (#16937), also after a restart. A plan label that inherits its
// base's cli-idle-timeout never adopted a window of its own (#16940); it reports the base's, the
// window that expired (#16971).

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

describe("a plan label inheriting its base's cli-idle-timeout reports the base's window (#16971)", () => {
  const LABEL = `${BASE}:B`;

  /**
   * The base on the cli-idle policy with a plan label `B` on its own 10 s heartbeat lease, whose
   * own idle timeout outlasts the base's window.
   */
  async function baseWithLabel(manager: SessionManager): Promise<void> {
    await manager.createSession(BASE, DEVICE, "android", { timeoutMs: 60_000 });
    manager.adoptCliLivenessPolicy(BASE, WINDOW_MS);
    await asPlanAllocation(manager, BASE, [LABEL], () =>
      manager.createSession(LABEL, "emulator-5556", "android", {
        timeoutMs: 2 * WINDOW_MS,
        heartbeatTimeoutMs: 10_000,
      }),
    );
    manager.setDeviceLabels(BASE, buildDeviceLabelMap(["A", "B"], BASE));
  }

  /** The base ended by `reason`, with the daemon's cascade ending the label after it. */
  async function cascadeEnd(manager: SessionManager, reason: SessionReleaseReason): Promise<void> {
    const cascade = registerDerivedLabelSessionReleaseCascade(manager, DEVICE_POOL);
    await manager.releaseSession(BASE, reason);
    await cascade.settled();
  }

  function mcpError(release: SessionReleaseSnapshot | undefined): Record<string, unknown> {
    return sessionOwnershipLostPayload({
      message: "gone",
      sessionUuid: LABEL,
      reason: release?.releaseReason ?? "",
      release,
    }).error;
  }

  test("before the cascade, the label's refusal carries the base's window, not its lease", async () => {
    const manager = newManager();
    await baseWithLabel(manager);
    await manager.releaseSession(BASE, "cli-idle-timeout");

    const answer = manager.peekTerminalAnswerForEndedSession(LABEL);
    expect(answer?.release).toMatchObject({
      sessionId: LABEL,
      releaseReason: "cli-idle-timeout",
      cliIdleTimeoutMs: WINDOW_MS,
      heartbeat: { timeoutMs: 10_000 },
    });
    expect(mcpError(answer?.release)).toMatchObject({
      reason: "cli-idle-timeout",
      idle: true,
      idleTimeoutMs: WINDOW_MS,
    });
    expect(mcpRequestFailureDetails(answer, undefined)).toMatchObject({
      code: "session_ownership_lost",
      details: { sessionUuid: LABEL, reason: "cli-idle-timeout", idleTimeoutMs: WINDOW_MS },
    });
    expect(await manager.getReleasedSessionIdleTimeoutMs(LABEL)).toBe(WINDOW_MS);
  });

  // daemon/registerSession takes a UUID, so it never names a `${base}:${label}` id.
  test("after the cascade, its release and session-not-found answers carry it", async () => {
    const manager = newManager();
    await baseWithLabel(manager);
    await cascadeEnd(manager, "cli-idle-timeout");

    expect(manager.getTerminalReleaseSnapshot(LABEL)?.cliIdleTimeoutMs).toBe(WINDOW_MS);
    for (const method of ["daemon/heartbeat", "daemon/sessionInfo"]) {
      const answer = await request(manager, method, { sessionId: LABEL });
      expect(answer, method).toMatchObject({
        code: DAEMON_SESSION_NOT_FOUND_CODE,
        releaseReason: "cli-idle-timeout",
        idleTimeoutMs: WINDOW_MS,
      });
    }
  });

  test("a restarted daemon reads the label's window from its base's row", async () => {
    const first = newManager();
    await baseWithLabel(first);
    await cascadeEnd(first, "cli-idle-timeout");
    const restarted = newManager();

    expect(await restarted.getReleasedSessionIdleTimeoutMs(LABEL)).toBe(WINDOW_MS);
    const answer = await request(restarted, "daemon/sessionInfo", { sessionId: LABEL });
    expect(answer).toMatchObject({ releaseReason: "cli-idle-timeout", idleTimeoutMs: WINDOW_MS });
  });

  test("a label whose base ended for any other reason carries no window", async () => {
    const manager = newManager();
    await baseWithLabel(manager);
    await manager.releaseSession(BASE, "explicit-release");

    const before = manager.peekTerminalAnswerForEndedSession(LABEL)?.release;
    expect(before?.releaseReason).toBe("explicit-release");
    expect(before?.cliIdleTimeoutMs).toBeUndefined();
    expect("idleTimeoutMs" in mcpError(before)).toBe(false);
    expect(await manager.getReleasedSessionIdleTimeoutMs(LABEL)).toBeUndefined();
  });

  test("nor does its own release, before or after a restart", async () => {
    const first = newManager();
    await baseWithLabel(first);
    await cascadeEnd(first, "explicit-release");

    expect(first.getTerminalReleaseSnapshot(LABEL)?.releaseReason).toBe("explicit-release");
    expect(first.getTerminalReleaseSnapshot(LABEL)?.cliIdleTimeoutMs).toBeUndefined();
    expect(await newManager().getReleasedSessionIdleTimeoutMs(LABEL)).toBeUndefined();
  });
});
