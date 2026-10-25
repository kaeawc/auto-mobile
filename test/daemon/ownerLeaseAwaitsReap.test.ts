import { expect } from "bun:test";
import { SessionManager } from "../../src/daemon/sessionManager";
import { SessionHeartbeatMonitor } from "../../src/daemon/SessionHeartbeatMonitor";
import { holderReleaseRemainingMs } from "../../src/daemon/holderReleaseRemaining";
import {
  DEFAULT_SESSION_HEARTBEAT_CHECK_INTERVAL_MS,
  NO_HEARTBEAT_RELEASE_BUDGET_MS,
} from "../../src/daemon/wire/sessionLivenessWindows";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { daemonHeartbeatHandler } from "../helpers/daemonHeartbeatHandler";
import { asPlanAllocation } from "../helpers/planLabelAllocation";
import { warmedTests } from "../helpers/warmedTests";

const managers: SessionManager[] = [];
const test = warmedTests(() => {
  for (const manager of managers.splice(0)) {
    manager.stopCleanupTimer();
  }
});
function setup() {
  const timer = new FakeTimer();
  const manager = new SessionManager(timer, new FakeDeviceSessionPersistence(), {
    barrier: () => new FakeDbWriteBarrier(),
  });
  manager.stopCleanupTimer();
  managers.push(manager);
  const heartbeat = (sessionId: string) =>
    daemonHeartbeatHandler(manager)("daemon/heartbeat", {
      sessionId,
      livenessOwnerToken: "owner",
      claimLivenessOwnership: true,
    });
  const hint = (sessionId: string) =>
    holderReleaseRemainingMs({
      disconnectRemainingMs: undefined,
      releasing: false,
      ownerLease: manager.getSessionLeaseState(sessionId),
      ownerLeaseAwaitsReap: manager.ownerLeaseAwaitsReap(sessionId),
    });
  return { timer, manager, heartbeat, hint };
}
const clocks = (session: {
  lastHeartbeat: number;
  lastUsedAt: number;
  lastOwnerHeartbeat?: number;
}) => [session.lastHeartbeat, session.lastUsedAt, session.lastOwnerHeartbeat];

test("silent owner hint never disappears between suspect and the next reap; reader stamps nothing", async () => {
  const { timer, manager, heartbeat, hint } = setup();
  const session = await manager.createSession("holder", "device", "android");
  await heartbeat("holder");
  const before = clocks(session);
  expect(hint("holder")).toBeUndefined();
  for (const at of [4_001, 7_999, 8_000, 8_001, 9_999]) {
    timer.setCurrentTime(at);
    const remaining = hint("holder");
    expect(remaining).toBeGreaterThanOrEqual(1);
    expect(remaining).toBeLessThanOrEqual(4_000);
    if (at > 8_000) {
      expect(remaining).toBeLessThanOrEqual(DEFAULT_SESSION_HEARTBEAT_CHECK_INTERVAL_MS);
    }
    expect(clocks(session)).toEqual(before);
    expect(manager.hasSession("holder")).toBe(true);
  }
  timer.setCurrentTime(NO_HEARTBEAT_RELEASE_BUDGET_MS);
  const monitor = new SessionHeartbeatMonitor(
    manager,
    () => false,
    async (id, reason) => {
      expect(reason).toBe("heartbeat-timeout");
      await manager.releaseSession(id, reason);
    },
    timer,
  );
  await monitor.tick();
  await monitor.stop();
  expect(manager.hasSession("holder")).toBe(false);
  expect(manager.ownerLeaseAwaitsReap("holder")).toBe(false);
});

test("awaiting-reap excludes active control calls but does not let reads veto it", async () => {
  const { timer, manager, heartbeat, hint } = setup();
  const session = await manager.createSession("holder", "device", "android");
  await heartbeat("holder");
  timer.setCurrentTime(8_001);
  const before = clocks(session);
  let control = true;
  manager.setActiveSessionExecutionChecker((id, query) => {
    expect(id).toBe("holder");
    expect(query).toEqual({ excludeReads: true });
    return control;
  });
  expect(hint("holder")).toBeUndefined();
  control = false;
  expect(hint("holder")).toBe(DEFAULT_SESSION_HEARTBEAT_CHECK_INTERVAL_MS);
  expect(clocks(session)).toEqual(before);
});

test("never-heartbeated, CLI idle and awaiting-owner sessions have no awaiting-reap hint", async () => {
  const { timer, manager, heartbeat, hint } = setup();
  const never = await manager.createSession("never", "device-1", "android");
  const cli = await manager.createSession("cli", "device-2", "android");
  await heartbeat("cli");
  cli.livenessPolicy = "cli-idle";
  const awaiting = await manager.createSession("awaiting", "device-3", "android");
  await heartbeat("awaiting");
  awaiting.ownership = "awaiting-owner";
  const before = [never, cli, awaiting].map(clocks);
  timer.setCurrentTime(8_001);
  for (const id of ["never", "cli", "awaiting"]) {
    expect(manager.ownerLeaseAwaitsReap(id)).toBe(false);
  }
  expect(hint("never")).toBeUndefined();
  expect(hint("cli")).toBeUndefined();
  expect([never, cli, awaiting].map(clocks)).toEqual(before);
  expect(manager.hasSession("never")).toBe(true);
});

test("awaiting-reap uses later same-token base proof, not the label's older heartbeat", async () => {
  const { timer, manager, heartbeat } = setup();
  await manager.createSession("base", "device-1", "android");
  await heartbeat("base");
  const label = await asPlanAllocation(manager, "base", ["base:label"], () =>
    manager.createSession("base:label", "device-2", "android"),
  );
  manager.setDeviceLabels("base", { label: label.sessionId });
  await heartbeat(label.sessionId);
  timer.setCurrentTime(4_000);
  await heartbeat("base");
  timer.setCurrentTime(8_001);
  let probes = 0;
  manager.setStallProbe(() => {
    probes++;
  });
  expect(manager.ownerLeaseAwaitsReap(label.sessionId)).toBe(false);
  expect(probes).toBeGreaterThan(0);
  timer.setCurrentTime(12_001);
  expect(manager.ownerLeaseAwaitsReap(label.sessionId)).toBe(true);
});

test("acquisition adoption follows the base guard and never stamps an owner heartbeat", async () => {
  const { manager, heartbeat } = setup();
  await manager.createSession("base", "device-1", "android");
  await heartbeat("base");
  const label = await asPlanAllocation(manager, "base", ["base:label"], () =>
    manager.createSession("base:label", "device-2", "android"),
  );
  manager.setDeviceLabels("base", { label: label.sessionId });
  const before = clocks(label);
  let probes = 0;
  manager.setStallProbe(() => {
    probes++;
  });
  expect(manager.bindAcquiredLivenessOwnerToken(label.sessionId, "rival")).toBe(false);
  expect(label.livenessOwnerToken).toBeUndefined();
  expect(manager.bindAcquiredLivenessOwnerToken(label.sessionId, "owner")).toBe(true);
  expect(label.livenessOwnerToken).toBe("owner");
  expect(label.hasReceivedHeartbeat).toBe(false);
  expect(clocks(label)).toEqual(before);
  expect(probes).toBeGreaterThan(0);
});
