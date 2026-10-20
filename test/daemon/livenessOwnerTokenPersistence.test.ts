import { expect, spyOn } from "bun:test";
import { DeviceSessionNotActiveError } from "../../src/db/deviceSessionRepository";
import {
  getDbWriteBarrier,
  resetDbWriteBarrier,
  InMemoryDbWriteBarrier,
} from "../../src/db/dbWriteBarrier";
import { executionTracker } from "../../src/daemon/executionTracker";
import { logger } from "../../src/utils/logger";
import { LivenessScenario } from "../helpers/livenessScenarioHarness";
import { drainMicrotasks } from "../helpers/fakeTimerStepping";
import { warmedTests } from "../helpers/warmedTests";

const TOKEN = "scenario-proxy-owner";
let scenario: LivenessScenario | undefined;
let clockOffset: unknown;
const test = warmedTests(async () => {
  await drainMicrotasks(64);
  if (scenario) {
    await scenario.stop();
    scenario = undefined;
    Reflect.set(executionTracker, "sessionClockOffsetProvider", clockOffset);
  }
  expect(getDbWriteBarrier().inFlightCount()).toBe(0);
  resetDbWriteBarrier();
});

async function setup() {
  clockOffset = Reflect.get(executionTracker, "sessionClockOffsetProvider");
  const s = (scenario = await LivenessScenario.start());
  s.dropHeartbeats = true;
  return s;
}

test("mint persists the declared token before any heartbeat", async () => {
  const s = await setup();
  const id = await s.acquire();
  expect(s.daemon.manager.getSession(id)?.hasReceivedHeartbeat).toBe(false);
  expect(await getDbWriteBarrier().drain(100)).toBe(true);
  expect((await s.repository.getSession(id))?.liveness_owner_token).toBe(TOKEN);
});

test("restart restores the mint token before any owner heartbeat", async () => {
  const s = await setup();
  const id = await s.acquire();
  await drainMicrotasks(64);
  await s.daemonRestart();
  expect(s.heartbeatsByToken.get(TOKEN) ?? 0).toBe(0);
  expect(s.daemon.manager.getSession(id)?.livenessOwnerToken).toBe(TOKEN);
});

test("non-claiming heartbeat adoption persists its token", async () => {
  const s = await setup();
  const id = await s.acquireTokenless();
  const response = await s.daemonMethod("daemon/heartbeat", {
    sessionId: id,
    livenessOwnerToken: "junit-owner",
  });
  expect(response.success).toBe(true);
  await drainMicrotasks(64);
  expect((await s.repository.getSession(id))?.liveness_owner_token).toBe("junit-owner");
});

class PausedBarrier extends InMemoryDbWriteBarrier {
  readonly gate = Promise.withResolvers<void>();
  override track<T>(work: () => Promise<T>): Promise<T | undefined> {
    return super.track(async () => {
      await this.gate.promise;
      return work();
    });
  }
}

test("pending adoption writes the later claimant's token when it runs", async () => {
  const s = await setup();
  const id = await s.acquireTokenless();
  const barrier = new PausedBarrier(s.timer);
  Reflect.set(s.daemon.manager, "getBarrier", () => barrier);
  try {
    expect(s.daemon.manager.bindAcquiredLivenessOwnerToken(id, TOKEN)).toBe(true);
    expect(s.daemon.manager.bindAcquiredLivenessOwnerToken(id, TOKEN)).toBe(false);
    expect(s.daemon.manager.bindAcquiredLivenessOwnerToken(id, "refused-rival")).toBe(false);
    // Explicitly relinquish the live lease so the later claimant may take it over.
    expect(await s.daemon.manager.releaseLivenessOwnership(id, TOKEN)).toBe("released");
    expect(await s.daemon.manager.claimLivenessOwnership(id, "claimant")).toBe("claimed");
    expect(barrier.inFlightCount()).toBe(1);
    barrier.gate.resolve();
    expect(await barrier.drain(100)).toBe(true);
    expect((await s.repository.getSession(id))?.liveness_owner_token).toBe("claimant");
  } finally {
    barrier.gate.resolve();
    await barrier.drain(100);
  }
});

test("pin: older NULL-token rows restart tokenless", async () => {
  const s = await setup();
  const id = await s.acquireTokenless();
  expect((await s.repository.getSession(id))?.liveness_owner_token).toBeNull();
  await s.daemonRestart();
  expect(s.daemon.manager.getSession(id)?.livenessOwnerToken).toBeUndefined();
});

test("pin: terminal release clears a mint-bound token", async () => {
  const s = await setup();
  const id = await s.acquire();
  await drainMicrotasks(64);
  // Seed the pre-existing release contract even on builds without adoption persistence.
  await s.repository.replaceLivenessOwnership(id, TOKEN);
  await s.daemon.manager.releaseSession(id, "explicit-release");
  expect((await s.repository.getSession(id))?.liveness_owner_token).toBeNull();
});

test("pin: recoverable daemon release retains a mint-bound token", async () => {
  const s = await setup();
  const id = await s.acquire();
  await drainMicrotasks(64);
  // Seed the pre-existing repository contract independently of the adoption change.
  await s.repository.replaceLivenessOwnership(id, TOKEN);
  await s.daemon.manager.releaseSession(id, "daemon-shutdown");
  expect((await s.repository.getSession(id))?.liveness_owner_token).toBe(TOKEN);
});

for (const expected of [false, true]) {
  test(`pin: ${expected ? "inactive-row" : "unexpected"} failure preserves synchronous adoption without logging its token`, async () => {
    const s = await setup();
    const id = await s.acquireTokenless();
    const session = s.daemon.manager.getSession(id)!;
    const before = [
      session.lastHeartbeat,
      session.lastUsedAt,
      session.lastOwnerHeartbeat,
      session.hasReceivedHeartbeat,
      session.expiresAt,
      session.livenessOwnershipClaims,
    ];
    const warnings = spyOn(logger, "warn").mockImplementation(() => {});
    const debug = spyOn(logger, "debug").mockImplementation(() => {});
    s.repository.replaceLivenessOwnership = async () => {
      throw expected ? new DeviceSessionNotActiveError(id) : new Error(TOKEN);
    };
    try {
      expect(s.daemon.manager.bindAcquiredLivenessOwnerToken(id, TOKEN)).toBe(true);
      expect(session.livenessOwnerToken).toBe(TOKEN);
      expect([
        session.lastHeartbeat,
        session.lastUsedAt,
        session.lastOwnerHeartbeat,
        session.hasReceivedHeartbeat,
        session.expiresAt,
        session.livenessOwnershipClaims,
      ]).toEqual(before);
      await drainMicrotasks(64);
      expect((await s.repository.getSession(id))?.liveness_owner_token).toBeNull();
      expect(JSON.stringify([...warnings.mock.calls, ...debug.mock.calls])).not.toContain(TOKEN);
      expect(
        warnings.mock.calls.some(
          ([message]) =>
            message === "[SessionManager] Failed to persist adopted liveness ownership",
        ),
      ).toBe(!expected);
      expect(
        debug.mock.calls.some(
          ([message]) =>
            message === "[SessionManager] Adopted liveness owner row is no longer active",
        ),
      ).toBe(expected);
    } finally {
      debug.mockRestore();
      warnings.mockRestore();
    }
  });
}
