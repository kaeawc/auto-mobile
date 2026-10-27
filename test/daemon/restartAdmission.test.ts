import { afterEach, describe, expect, test } from "bun:test";
import { executionTracker } from "../../src/daemon/executionTracker";
import {
  DAEMON_MAINTENANCE_ADMISSION_TTL_MS,
  RestartAdmission,
  type RestartAdmissionDeps,
} from "../../src/daemon/socketServer/restartAdmission";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";

/** #11815: the maintenance and acceptance restart fences, driven with injected collaborators. */
function fixture(overrides: Partial<RestartAdmissionDeps> = {}) {
  const timer = new FakeTimer();
  const restarts: string[] = [];
  const admission = new RestartAdmission({
    timer,
    idGenerator: new FakeIdGenerator(["token-1", "token-2"]),
    generationMatches: () => true,
    currentIdentity: () => ({
      pid: 1,
      startedAt: 1,
      version: "v",
      buildId: "b",
      entryScript: "e",
    }),
    getAllSessions: () => [],
    onRestartAccepted: () => restarts.push("restart"),
    liveAcceptanceStartupSecret: undefined,
    ...overrides,
  });
  return { admission, timer, restarts };
}

afterEach(() => {
  executionTracker.clearDaemonMaintenancePreparation();
  executionTracker.clearDaemonRestartPreparation();
});

describe("RestartAdmission maintenance fence", () => {
  test("a stale generation is refused before anything is reserved", () => {
    const { admission } = fixture({ generationMatches: () => false });
    expect(admission.prepareDaemonMaintenance({})).toEqual({
      accepted: false,
      reason: "generation_changed",
    });
  });

  test("without a session list maintenance cannot be admitted", () => {
    const { admission } = fixture({ getAllSessions: () => undefined });
    expect(admission.prepareDaemonMaintenance({})).toEqual({
      accepted: false,
      reason: "sessions_unavailable",
    });
  });

  test("the token completes once, then is no longer valid", () => {
    const { admission } = fixture();
    expect(admission.prepareDaemonMaintenance({})).toEqual({
      accepted: true,
      maintenanceToken: "token-1",
    });
    expect(admission.completeDaemonMaintenance({ maintenanceToken: "wrong" })).toEqual({
      completed: false,
    });
    expect(admission.completeDaemonMaintenance({ maintenanceToken: "token-1" })).toEqual({
      completed: true,
    });
    expect(admission.completeDaemonMaintenance({ maintenanceToken: "token-1" })).toEqual({
      completed: false,
    });
  });

  test("an unreleased token expires after its TTL", () => {
    const { admission, timer } = fixture();
    admission.prepareDaemonMaintenance({});
    timer.advanceTime(DAEMON_MAINTENANCE_ADMISSION_TTL_MS);
    expect(admission.restartAdmittedDaemon({ maintenanceToken: "token-1" })).toEqual({
      accepted: false,
      reason: "maintenance_token_invalid",
    });
  });

  test("an admitted restart runs once and consumes the token", () => {
    const { admission, restarts } = fixture();
    admission.prepareDaemonMaintenance({});
    expect(admission.restartAdmittedDaemon({ maintenanceToken: "token-1" })).toEqual({
      accepted: true,
    });
    expect(restarts).toEqual(["restart"]);
    expect(admission.restartAdmittedDaemon({ maintenanceToken: "token-1" })).toEqual({
      accepted: false,
      reason: "maintenance_token_consumed",
    });
  });

  test("a live session blocks the admitted restart", () => {
    const sessions = [{ sessionId: "s" }] as never;
    const { admission } = fixture({ getAllSessions: () => sessions });
    expect(admission.prepareDaemonMaintenance({}).accepted).toBe(false);
  });
});

describe("RestartAdmission acceptance fence", () => {
  test("a restart needs an owner session and a valid scope", () => {
    const { admission } = fixture();
    expect(admission.restartAcceptanceSession({}, undefined)).toEqual({
      accepted: false,
      reason: "restart_pending",
    });
    expect(admission.restartAcceptanceSession({}, "owner")).toEqual({
      accepted: false,
      reason: "scope_invalid",
    });
  });

  test("an unknown token is not released or committed", () => {
    const { admission } = fixture();
    expect(admission.releaseAcceptanceRestart({ restartToken: "x" }, "owner")).toEqual({
      released: false,
    });
    expect(admission.commitAcceptanceRestart({ restartToken: "x" }, "owner")).toEqual({
      committed: false,
    });
  });

  test("releaseAll is safe with nothing admitted", () => {
    const { admission } = fixture();
    admission.releaseAll();
    expect(admission.prepareDaemonMaintenance({}).accepted).toBe(true);
  });
});
