import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  SessionManager,
  TerminalSessionError,
  type KeepScreenAwakeRestorer,
} from "../../src/daemon/sessionManager";
import type { SessionReleaseSnapshot } from "../../src/daemon/sessionManager";
import type { SessionReleaseReason } from "../../src/daemon/releaseReasons";
import { sessionOwnershipLostPayload } from "../../src/daemon/deviceSessionResult";
import { registerDerivedLabelSessionReleaseCascade } from "../../src/daemon/derivedLabelSessionReleaseCascade";
import { mcpRequestFailureDetails } from "../../src/daemon/socketServer";
import { buildDeviceLabelMap } from "../../src/server/deviceLabelMapping";
import { logger } from "../../src/utils/logger";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../fakes/FakeTimer";
import { asPlanAllocation } from "../helpers/planLabelAllocation";

// A plan label that inherits its base's cli-idle-timeout reports the base's CLI idle window
// (#16971) on two more paths (#17009): the refusal of a call naming the label after a daemon
// restart, built from the persisted rows, and a forced stuck release of the label, built while
// the cascade ends it.

const BASE = "17009000-0000-4000-8000-000000000001";
const LABEL = `${BASE}:B`;
const DEVICE = "emulator-5554";
const LABEL_DEVICE = "emulator-5556";
const WINDOW_MS = 300_000;

const DEVICE_POOL = {
  refreshDevices: async () => 0,
  getStats: () => ({ total: 2, idle: 0, assigned: 2, error: 0 }),
  releaseDevice: async () => {},
  assignDeviceToSession: async () => {
    throw new Error("a label row must not be assigned a device");
  },
};

const flush = async () => {
  for (let index = 0; index < 200; index++) {
    await Promise.resolve();
  }
};

/** A keep-awake restore that stays parked, so the label's release sticks in its teardown. */
class ParkedKeepAwake implements KeepScreenAwakeRestorer {
  readonly gate = Promise.withResolvers<void>();
  async restore(): Promise<{ status: "restored" }> {
    await this.gate.promise;
    return { status: "restored" as const };
  }
}

let timer: FakeTimer;
let persistence: FakeDeviceSessionPersistence;
let keepAwake: ParkedKeepAwake;
let managers: SessionManager[];

function newManager(): SessionManager {
  const manager = new SessionManager(timer, persistence, {
    barrier: () => new FakeDbWriteBarrier(),
    keepScreenAwakeRestorer: () => keepAwake,
  });
  managers.push(manager);
  return manager;
}

/** The base on the cli-idle policy with a plan label `B` on its own 10 s heartbeat lease. */
async function baseWithLabel(manager: SessionManager): Promise<void> {
  await manager.createSession(BASE, DEVICE, "android", { timeoutMs: 60_000 });
  manager.adoptCliLivenessPolicy(BASE, WINDOW_MS);
  await asPlanAllocation(manager, BASE, [LABEL], () =>
    manager.createSession(LABEL, LABEL_DEVICE, "android", {
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

/** The refusal a restarted daemon gives a call naming the label. */
async function refusalAfterRestart(reason: SessionReleaseReason): Promise<TerminalSessionError> {
  const first = newManager();
  await baseWithLabel(first);
  await cascadeEnd(first, reason);
  return refusalOf(newManager());
}

/** The terminal refusal `manager` gives a call naming the label. */
async function refusalOf(manager: SessionManager): Promise<TerminalSessionError> {
  const refusal = await manager
    .getOrCreateSession(LABEL, DEVICE_POOL, "android", { requireIssuedSession: true })
    .then(
      () => undefined,
      (error: unknown) => error,
    );
  if (!(refusal instanceof TerminalSessionError)) {
    throw new Error(`expected a terminal refusal, got ${String(refusal)}`);
  }
  return refusal;
}

function mcpError(release: SessionReleaseSnapshot): Record<string, unknown> {
  return sessionOwnershipLostPayload({
    message: "gone",
    sessionUuid: LABEL,
    reason: release.releaseReason,
    release,
  }).error;
}

beforeEach(() => {
  timer = new FakeTimer();
  timer.setCurrentTime(1_000_000);
  persistence = new FakeDeviceSessionPersistence();
  keepAwake = new ParkedKeepAwake();
  managers = [];
});

afterEach(() => {
  keepAwake.gate.resolve();
  for (const manager of managers) {
    manager.stopCleanupTimer();
  }
});

describe("a label's refusal after a restart carries its base's cli idle window (#17009)", () => {
  test("on the MCP payload and the socket frame", async () => {
    const refusal = await refusalAfterRestart("cli-idle-timeout");

    expect(refusal.release).toMatchObject({
      sessionId: LABEL,
      releaseReason: "cli-idle-timeout",
      cliIdleTimeoutMs: WINDOW_MS,
      terminal: true,
    });
    expect(mcpError(refusal.release)).toMatchObject({
      reason: "cli-idle-timeout",
      idle: true,
      idleTimeoutMs: WINDOW_MS,
    });
    expect(mcpRequestFailureDetails(refusal, undefined)).toMatchObject({
      code: "session_ownership_lost",
      details: { sessionUuid: LABEL, reason: "cli-idle-timeout", idleTimeoutMs: WINDOW_MS },
    });
  });

  test("a label whose base ended for any other reason carries none", async () => {
    const refusal = await refusalAfterRestart("explicit-release");

    expect(refusal.release.releaseReason).toBe("explicit-release");
    expect(refusal.release.cliIdleTimeoutMs).toBeUndefined();
    expect("idleTimeoutMs" in mcpError(refusal.release)).toBe(false);
    expect(mcpRequestFailureDetails(refusal, undefined).details).not.toHaveProperty(
      "idleTimeoutMs",
    );
  });
});

describe("a label that expired on its own cli idle window keeps it after a restart (#17009)", () => {
  test("the refusal reports the label's window, not the base's later one", async () => {
    const first = newManager();
    await baseWithLabel(first);
    first.adoptCliLivenessPolicy(LABEL, 120_000);
    await first.releaseSession(LABEL, "cli-idle-timeout");
    await first.releaseSession(BASE, "cli-idle-timeout");
    const restarted = newManager();

    const refusal = await refusalOf(restarted);
    expect(refusal.release).toMatchObject({
      releaseReason: "cli-idle-timeout",
      cliIdleTimeoutMs: 120_000,
    });
  });
});

describe("a forced stuck release of a label records its base's cli idle window (#17009)", () => {
  /** The cascade ends the label with the base's `reason`, and the label's release is forced. */
  async function forcedLabelRelease(
    reason: SessionReleaseReason,
  ): Promise<SessionReleaseSnapshot | undefined> {
    const manager = newManager();
    await baseWithLabel(manager);
    manager.setKeepScreenAwake(LABEL, { applied: true, method: "settings" });
    const cascade = registerDerivedLabelSessionReleaseCascade(manager, DEVICE_POOL);
    await manager.releaseSession(BASE, reason);
    await flush();
    // The cascade's release of the label is parked in its keep-awake restore, before its fence.
    expect(manager.getTerminalReleaseSnapshot(LABEL)).toBeUndefined();
    expect(manager.forceStuckRelease(LABEL)?.deviceId).toBe(LABEL_DEVICE);
    const forced = manager.getTerminalReleaseSnapshot(LABEL);
    keepAwake.gate.resolve();
    await cascade.settled();
    expect(forced?.releaseReason).toBe(reason);
    return forced;
  }

  test("the forced release carries the base's window", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const release = await forcedLabelRelease("cli-idle-timeout");
      expect(release?.cliIdleTimeoutMs).toBe(WINDOW_MS);
    } finally {
      warn.mockRestore();
    }
  });

  test("a label forced out after any other base end carries none", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const release = await forcedLabelRelease("explicit-release");
      expect(release?.cliIdleTimeoutMs).toBeUndefined();
    } finally {
      warn.mockRestore();
    }
  });
});
