import { expect, spyOn } from "bun:test";
import {
  SessionManager,
  type Session,
  type SessionDeviceAssigner,
} from "../../src/daemon/sessionManager";
import { SessionHeartbeatMonitor } from "../../src/daemon/SessionHeartbeatMonitor";
import {
  ownerLeaseHeartbeat,
  SUSPECT_GRACE_MS,
  type LivenessOwnerHold,
} from "../../src/daemon/livenessOwnerLease";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { daemonHeartbeatHandler } from "../helpers/daemonHeartbeatHandler";
import { warmedTests } from "../helpers/warmedTests";
import { logger } from "../../src/utils/logger";

const managers: SessionManager[] = [];
const monitors: SessionHeartbeatMonitor[] = [];
const test = warmedTests(async () => {
  for (const monitor of monitors.splice(0)) {
    await monitor.stop();
  }
  for (const manager of managers.splice(0)) {
    manager.stopCleanupTimer();
  }
});

function setup() {
  const timer = new FakeTimer();
  const persistence = new FakeDeviceSessionPersistence();
  const manager = new SessionManager(timer, persistence, {
    barrier: () => new FakeDbWriteBarrier(),
  });
  manager.stopCleanupTimer();
  managers.push(manager);
  const heartbeat = (sessionId = "S", token = "minter", claim = true) =>
    daemonHeartbeatHandler(manager)("daemon/heartbeat", {
      sessionId,
      livenessOwnerToken: token,
      claimLivenessOwnership: claim,
    });
  return { timer, persistence, manager, heartbeat };
}

const unchangedClocks = (session: Session) => ({
  hasReceivedHeartbeat: session.hasReceivedHeartbeat,
  lastHeartbeat: session.lastHeartbeat,
  lastOwnerHeartbeat: session.lastOwnerHeartbeat,
  stallForgivenAt: session.stallForgivenAt,
  expiresAt: session.expiresAt,
  lastUsedAt: session.lastUsedAt,
});

for (const activity of ["end", "start"] as const) {
  test(`successor claims at 12 s after a call ${activity} at 9 s without a minter heartbeat`, async () => {
    const { timer, manager, heartbeat } = setup();
    const session = await manager.createSession("S", "device", "android");
    expect(manager.bindAcquiredLivenessOwnerToken("S", "minter")).toBe(true);
    timer.setCurrentTime(9_000);
    if (activity === "end") {
      manager.recordToolCallEnded("S");
    } else {
      await manager.getOrCreateSession("S");
    }
    expect(session.lastHeartbeat).toBe(9_000);
    expect(session.hasReceivedHeartbeat).toBe(false);
    timer.setCurrentTime(12_000);
    await expect(heartbeat("S", "successor")).resolves.toBeDefined();
    expect(session.livenessOwnerToken).toBe("successor");
  });
}

for (const claimAt of [8_001, 12_000, 120_001]) {
  test(`calls ending every 3 s cannot defend the silent minter at ${claimAt} ms`, async () => {
    const { timer, manager, heartbeat } = setup();
    const session = await manager.createSession("S", "device", "android");
    expect(manager.bindAcquiredLivenessOwnerToken("S", "minter")).toBe(true);
    for (let at = 3_000; at < claimAt; at += 3_000) {
      timer.setCurrentTime(at);
      manager.recordToolCallEnded("S");
    }
    timer.setCurrentTime(claimAt);
    expect(session.hasReceivedHeartbeat).toBe(false);
    await expect(heartbeat("S", "successor")).resolves.toBeDefined();
  });
}

test("owner hold lapses after mint plus lease and grace despite activity", async () => {
  const { timer, manager } = setup();
  await manager.createSession("S", "device", "android");
  expect(manager.bindAcquiredLivenessOwnerToken("S", "minter")).toBe(true);
  timer.setCurrentTime(9_000);
  manager.recordToolCallEnded("S");
  timer.setCurrentTime(12_000);
  expect(manager.getOwnerLeaseHold("S")).toEqual({
    state: "lapsed",
    remainingMs: 0,
    holdRemainingMs: 0,
  });
});

for (const activity of [false, true]) {
  test(`mint hold includes grace and the strict boundary, activity ${activity}`, async () => {
    const { timer, manager, heartbeat } = setup();
    const session = await manager.createSession("S", "device", "android");
    timer.setCurrentTime(1_000);
    expect(manager.bindAcquiredLivenessOwnerToken("S", "minter")).toBe(true);
    const holdEnd = 1_000 + session.heartbeatTimeoutMs + SUSPECT_GRACE_MS;
    expect(manager.getOwnerLeaseHold("S")?.holdRemainingMs).toBe(8_000);
    for (const at of [1_000, 5_001, holdEnd]) {
      timer.setCurrentTime(at);
      if (activity) {
        manager.recordToolCallEnded("S");
      }
      await expect(heartbeat("S", "successor")).rejects.toThrow("owned by another liveness owner");
      expect(session.hasReceivedHeartbeat).toBe(false);
      expect(session.lastOwnerHeartbeat).toBeUndefined();
    }
    expect(manager.getOwnerLeaseHold("S")).toEqual({
      state: "suspect",
      remainingMs: 0,
      holdRemainingMs: 0,
    });
    timer.setCurrentTime(holdEnd + 1);
    await expect(heartbeat("S", "successor")).resolves.toBeDefined();
  });
}

for (const at of [2_000, 12_000]) {
  for (const claim of [false, true]) {
    test(`minter first heartbeat at ${at} ms succeeds, claim ${claim}, then owns the heartbeat lease`, async () => {
      const { timer, manager, heartbeat } = setup();
      const session = await manager.createSession("S", "device", "android");
      expect(manager.bindAcquiredLivenessOwnerToken("S", "minter")).toBe(true);
      timer.setCurrentTime(at);
      await expect(heartbeat("S", "minter", claim)).resolves.toBeDefined();
      expect(session.hasReceivedHeartbeat).toBe(true);
      expect(session.lastOwnerHeartbeat).toBe(at);
      expect(ownerLeaseHeartbeat(session)).toBe(at);
      timer.setCurrentTime(at + 8_000);
      await expect(heartbeat("S", "successor")).rejects.toThrow("owned by another liveness owner");
      timer.setCurrentTime(at + 8_001);
      await expect(heartbeat("S", "successor")).resolves.toBeDefined();
    });
  }
}

test("bind leaves all heartbeat and activity clocks unchanged", async () => {
  const { timer, manager } = setup();
  const session = await manager.createSession("S", "device", "android");
  const before = unchangedClocks(session);
  timer.setCurrentTime(1_000);
  expect(manager.bindAcquiredLivenessOwnerToken("S", "minter")).toBe(true);
  expect(unchangedClocks(session)).toEqual(before);
  expect(session.hasReceivedHeartbeat).toBe(false);
});

test("bind uses the session clock without marking a heartbeat or moving existing clocks", async () => {
  const { timer, manager } = setup();
  const session = await manager.createSession("S", "device", "android");
  const before = unchangedClocks(session);
  timer.setCurrentTime(1_000);
  timer.stepWallClock(-50_000);
  expect(manager.bindAcquiredLivenessOwnerToken("S", "minter")).toBe(true);
  expect(session.livenessOwnerBoundAt).toBe(1_000);
  expect(unchangedClocks(session)).toEqual(before);
  expect(session.hasReceivedHeartbeat).toBe(false);
  timer.setCurrentTime(2_000);
  expect(manager.bindAcquiredLivenessOwnerToken("S", "minter")).toBe(false);
  expect(manager.bindAcquiredLivenessOwnerToken("S", "rival")).toBe(false);
  expect(session.livenessOwnerBoundAt).toBe(1_000);
});

test("never-heartbeated mint and ownerless sessions have identical session lease and control admission", async () => {
  const { timer, manager } = setup();
  const bound = await manager.createSession("bound", "device-1", "android");
  const unbound = await manager.createSession("unbound", "device-2", "android");
  expect(manager.bindAcquiredLivenessOwnerToken("bound", "minter")).toBe(true);
  for (const at of [4_001, 8_002, 12_003]) {
    timer.setCurrentTime(at);
    expect(manager.getSessionLeaseState("bound")).toEqual(manager.getSessionLeaseState("unbound"));
    expect(manager.getSessionLeaseState("bound")?.phase).toBe("lapsed");
    await expect(manager.getOrCreateSession("bound")).resolves.toBe(bound);
    await expect(manager.getOrCreateSession("unbound")).resolves.toBe(unbound);
    expect(unchangedClocks(bound)).toEqual(unchangedClocks(unbound));
    timer.setCurrentTime(at + 1);
    expect(manager.getSessionLeaseState("bound")).toEqual(manager.getSessionLeaseState("unbound"));
  }
});

for (const controlInFlight of [false, true]) {
  test(`missing-first-heartbeat timing is unchanged with mint binding, control in flight ${controlInFlight}`, async () => {
    const { timer, manager } = setup();
    const sessions = [
      await manager.createSession("bound", "device-1", "android"),
      await manager.createSession("unbound", "device-2", "android"),
    ];
    expect(manager.bindAcquiredLivenessOwnerToken("bound", "minter")).toBe(true);
    timer.setCurrentTime(9_000);
    for (const session of sessions) {
      manager.recordToolCallEnded(session.sessionId);
    }
    let active = controlInFlight;
    manager.setActiveSessionExecutionChecker(() => active);
    const released: Array<{ id: string; reason: string; at: number }> = [];
    const monitor = new SessionHeartbeatMonitor(
      manager,
      () => active,
      async (id, reason) => {
        released.push({ id, reason, at: timer.now() });
        await manager.releaseSession(id, reason);
      },
      timer,
    );
    monitors.push(monitor);
    for (const at of [13_000, 14_000, 14_001]) {
      timer.setCurrentTime(at);
      for (const session of sessions) {
        expect(manager.ownerLeaseAwaitsReap(session.sessionId)).toBe(false);
      }
      await monitor.tick();
      if (at <= 14_000 || active) {
        expect(released).toEqual([]);
      }
    }
    if (active) {
      active = false;
      timer.setCurrentTime(14_002);
      await monitor.tick();
    }
    expect(released).toEqual(
      sessions.map((session) => ({
        id: session.sessionId,
        reason: "missing-first-heartbeat",
        at: controlInFlight ? 14_002 : 14_001,
      })),
    );
  });
}

test("CLI mint holds nothing against a successor claim", async () => {
  const { timer, manager, heartbeat } = setup();
  const session = await manager.createSession("S", "device", "android");
  session.livenessPolicy = "cli-idle";
  expect(manager.bindAcquiredLivenessOwnerToken("S", "minter")).toBe(true);
  timer.setCurrentTime(2_000);
  expect(manager.forgiveDaemonStall(2_000, 500, 500, 1_000)).toBe(1);
  expect(session.livenessOwnerBoundAt).toBe(0);
  expect(manager.getOwnerLeaseHold("S")).toBeUndefined();
  await expect(heartbeat("S", "successor")).resolves.toBeDefined();
});

test("rolled-back successor claim preserves activity-based reaping and admission, but not the minter claim hold", async () => {
  const { timer, persistence, manager } = setup();
  const session = await manager.createSession("S", "device", "android");
  timer.setCurrentTime(1_000);
  expect(manager.bindAcquiredLivenessOwnerToken("S", "minter")).toBe(true);
  timer.setCurrentTime(12_000);
  const write = spyOn(persistence, "recordLivenessOwnership").mockImplementation(async () => {
    manager.recordToolCallEnded("S");
    throw new Error("write failed");
  });
  try {
    await expect(manager.claimLivenessOwnership("S", "successor")).rejects.toThrow("write failed");
  } finally {
    write.mockRestore();
  }
  expect(session.livenessOwnerToken).toBe("minter");
  expect(session.livenessOwnerBoundAt).toBe(1_000);
  expect(session.lastOwnerHeartbeat).toBeUndefined();
  expect(session.hasReceivedHeartbeat).toBe(true);
  expect(manager.judgedLeaseHeartbeat(session)).toBe(12_000);
  expect(manager.getSessionLeaseState("S")).toEqual({ phase: "live", remainingMs: 4_000 });
  expect(manager.ownerLeaseAwaitsReap("S")).toBe(false);
  await expect(manager.getOrCreateSession("S")).resolves.toBe(session);
  expect(manager.getOwnerLeaseHold("S")?.state).toBe("lapsed");
  await expect(manager.claimLivenessOwnership("S", "successor")).resolves.toBe("claimed");
  expect(session.livenessOwnerToken).toBe("successor");
});

test("late stall cannot re-arm a silent minter claim hold through tool activity", async () => {
  const { timer, manager, heartbeat } = setup();
  const session = await manager.createSession("S", "device", "android");
  expect(manager.bindAcquiredLivenessOwnerToken("S", "minter")).toBe(true);
  for (let at = 3_000; at <= 18_000; at += 3_000) {
    timer.setCurrentTime(at);
    manager.recordToolCallEnded("S");
  }
  timer.setCurrentTime(20_000);
  const lapsed: LivenessOwnerHold = { state: "lapsed", remainingMs: 0, holdRemainingMs: 0 };
  expect(manager.getOwnerLeaseHold("S")).toEqual(lapsed);
  expect(manager.forgiveDaemonStall(20_000, 1_000, 0, 19_000)).toBe(1);
  expect(session.stallForgivenAt).toBe(19_000);
  expect(session.livenessOwnerBoundAt).toBe(0);
  expect(session.hasReceivedHeartbeat).toBe(false);
  expect(manager.getOwnerLeaseHold("S")).toEqual(lapsed);
  await expect(heartbeat("S", "successor")).resolves.toBeDefined();
});

for (const claimAt of [8_001, 12_001, 120_000]) {
  test(`stalls every 6 s with activity every 3 s cannot defend a silent minter at ${claimAt} ms`, async () => {
    const { timer, manager, heartbeat } = setup();
    const session = await manager.createSession("S", "device", "android");
    expect(manager.bindAcquiredLivenessOwnerToken("S", "minter")).toBe(true);
    for (let at = 3_000; at <= claimAt; at += 3_000) {
      timer.setCurrentTime(at);
      manager.recordToolCallEnded("S");
      if (at % 6_000 === 0) {
        manager.forgiveDaemonStall(at, 1_000, 0, at - 1_000);
      }
    }
    timer.setCurrentTime(claimAt);
    // The first gap begins at 5 s, after the mint's 4 s lease; none may extend it.
    expect(session.livenessOwnerBoundAt).toBe(0);
    expect(session.hasReceivedHeartbeat).toBe(false);
    expect(manager.getOwnerLeaseHold("S")?.state).toBe("lapsed");
    await expect(heartbeat("S", "successor")).resolves.toBeDefined();
  });
}

for (const activity of [false, true]) {
  for (const gapBeganAt of [3_000, undefined]) {
    for (const sleptMs of [0, 1_000]) {
      test(`running mint stall shifts claim boundary exactly, activity ${activity}, gap ${gapBeganAt}, sleep ${sleptMs}`, async () => {
        const { timer, manager, heartbeat } = setup();
        const session = await manager.createSession("S", "device", "android");
        timer.setCurrentTime(1_000);
        expect(manager.bindAcquiredLivenessOwnerToken("S", "minter")).toBe(true);
        timer.setCurrentTime(3_000);
        if (activity) {
          manager.recordToolCallEnded("S");
        }
        timer.setCurrentTime(4_000);
        expect(manager.forgiveDaemonStall(4_000, 1_000 - sleptMs, sleptMs, gapBeganAt)).toBe(1);
        const holdEnd = 2_000 + session.heartbeatTimeoutMs + SUSPECT_GRACE_MS;
        timer.setCurrentTime(holdEnd);
        await expect(heartbeat("S", "successor")).rejects.toThrow(
          "owned by another liveness owner",
        );
        expect(manager.getOwnerLeaseHold("S")).toEqual({
          state: "suspect",
          remainingMs: 0,
          holdRemainingMs: 0,
        });
        timer.setCurrentTime(holdEnd + 1);
        await expect(heartbeat("S", "successor")).resolves.toBeDefined();
      });
    }
  }
}

test("successive stalls extend only gaps that began while the shifted mint lease was running", async () => {
  const { timer, manager, heartbeat } = setup();
  const session = await manager.createSession("S", "device", "android");
  expect(manager.bindAcquiredLivenessOwnerToken("S", "minter")).toBe(true);
  for (let at = 3_000; at <= 120_000; at += 3_000) {
    timer.setCurrentTime(at);
    manager.recordToolCallEnded("S");
    manager.forgiveDaemonStall(at, 1_000, 0, at - 1_000);
  }
  // Starts at 2 s and 5 s were live (the second at the shifted lease's boundary).
  // The gap at 8 s and all later gaps began after the shifted 6 s lease deadline.
  expect(session.livenessOwnerBoundAt).toBe(2_000);
  expect(session.hasReceivedHeartbeat).toBe(false);
  expect(manager.getOwnerLeaseHold("S")?.state).toBe("lapsed");
  await expect(heartbeat("S", "successor")).resolves.toBeDefined();
});

test("mint stall shifts only lost time and caps the claim start at resume", async () => {
  const { timer, manager } = setup();
  const session = await manager.createSession("S", "device", "android");
  timer.setCurrentTime(1_000);
  expect(manager.bindAcquiredLivenessOwnerToken("S", "minter")).toBe(true);
  timer.setCurrentTime(4_000);
  manager.forgiveDaemonStall(4_000, 500, 0, 3_000);
  expect(session.livenessOwnerBoundAt).toBe(1_500);
  manager.forgiveDaemonStall(4_000, 10_000, 0, 3_000);
  expect(session.livenessOwnerBoundAt).toBe(4_000);
});

for (const gapBeganAt of [3_000, 19_000, undefined]) {
  test(`mint forgiveness preserves every existing write, return and log count, gap ${gapBeganAt}`, async () => {
    const minted = setup();
    const ownerless = setup();
    const mint = await minted.manager.createSession("S", "device", "android");
    const other = await ownerless.manager.createSession("S", "device", "android");
    minted.timer.setCurrentTime(1_000);
    expect(minted.manager.bindAcquiredLivenessOwnerToken("S", "minter")).toBe(true);
    const resumedAt = gapBeganAt === 19_000 ? 20_000 : 4_000;
    for (const { timer, manager } of [minted, ownerless]) {
      timer.setCurrentTime(resumedAt - 2_000);
      manager.recordToolCallEnded("S");
      manager.getSession("S")!.awaitingOwnerSince = 500;
      timer.setCurrentTime(resumedAt);
    }
    const log = spyOn(logger, "info").mockImplementation(() => {});
    try {
      const result = minted.manager.forgiveDaemonStall(resumedAt, 500, 500, gapBeganAt);
      const mintLogs = log.mock.calls.map(([message]) => message);
      log.mockClear();
      expect(ownerless.manager.forgiveDaemonStall(resumedAt, 500, 500, gapBeganAt)).toBe(result);
      expect(result).toBe(1);
      expect(log.mock.calls.map(([message]) => message)).toEqual(mintLogs);
      expect(mintLogs).toHaveLength(1);
      expect(unchangedClocks(mint)).toEqual(unchangedClocks(other));
      expect(mint.awaitingOwnerSince).toBe(other.awaitingOwnerSince);
      expect(mint.stallForgivenAt).toBe(resumedAt - 1_000);
      expect(mint.awaitingOwnerSince).toBe(1_500);
    } finally {
      log.mockRestore();
    }
  });
}

test("never-heartbeated CLI mint releases only past its idle timeout", async () => {
  const { timer, manager } = setup();
  for (const id of ["cli"]) {
    const session = await manager.createSession(id, id, "android");
    session.livenessPolicy = "cli-idle";
    session.heartbeatTimeoutMs = 20_000;
    expect(manager.bindAcquiredLivenessOwnerToken(id, "minter")).toBe(true);
  }
  expect(manager.getOwnerLeaseHold("cli")).toBeUndefined();
  const released: string[] = [];
  const monitor = new SessionHeartbeatMonitor(
    manager,
    () => false,
    async (id, reason) => {
      released.push(`${id}:${reason}`);
      await manager.releaseSession(id, reason);
    },
    timer,
  );
  monitors.push(monitor);
  // Serial scheduled scans avoid introducing daemon-stall forgiveness.
  for (let at = 2_000; at <= 20_000; at += 2_000) {
    timer.setCurrentTime(at);
    await monitor.tick();
  }
  expect(released).toEqual([]);
  expect(manager.getSession("cli")?.hasReceivedHeartbeat).toBe(false);
  timer.setCurrentTime(20_001);
  await monitor.tick();
  expect(released).toEqual(["cli:cli-idle-timeout"]);
});

test("rehydrated awaiting-owner keeps its release window and claim behaviour without mint grace", async () => {
  const { timer, persistence } = setup();
  for (const id of ["awaiting", "claimant"]) {
    await persistence.upsertActiveSession({
      sessionUuid: id,
      deviceId: id,
      platform: "android",
      createdAtMs: 0,
      lastUsedAtMs: 0,
      expiresAtMs: 60_000,
      sessionTimeoutMs: 60_000,
      heartbeatTimeoutMs: 4_000,
      heartbeatTimeoutSource: "default",
      hasReceivedHeartbeat: false,
    });
    await persistence.recordLivenessOwnership(id, "minter");
    await persistence.markReleased(id, "released", 0, "daemon-restart");
  }
  const manager = new SessionManager(timer, persistence, {
    barrier: () => new FakeDbWriteBarrier(),
  });
  managers.push(manager);
  manager.stopCleanupTimer();
  const assigner: SessionDeviceAssigner = {
    async assignDeviceToSession(id, _platform, target) {
      const session = await manager.createSession(id, id, "android", {
        timeoutMs: target?.liveness?.sessionTimeoutMs,
        heartbeatTimeoutMs: target?.liveness?.heartbeatTimeoutMs,
        stableDeviceId: target?.stableDeviceId,
        recoveredLiveness: target?.liveness,
        initialOwnership: target?.initialOwnership,
      });
      return session.assignedDevice;
    },
  };
  await manager.rehydratePersistedSessions(assigner);
  const awaiting = manager.getSession("awaiting")!;
  expect(awaiting.ownership).toBe("awaiting-owner");
  expect(awaiting.livenessOwnerBoundAt).toBeUndefined();
  const claim = (id: string) =>
    daemonHeartbeatHandler(manager)("daemon/heartbeat", {
      sessionId: id,
      livenessOwnerToken: "successor",
      claimLivenessOwnership: true,
    });
  timer.setCurrentTime(4_000);
  await expect(claim("claimant")).rejects.toThrow("owned by another liveness owner");
  const monitor = new SessionHeartbeatMonitor(
    manager,
    () => false,
    async (id, reason) => {
      expect(reason).toBe("rehydration-owner-timeout");
      await manager.releaseSession(id, reason);
    },
    timer,
  );
  monitors.push(monitor);
  timer.setCurrentTime(4_001);
  expect(manager.getOwnerLeaseHold("awaiting")?.state).toBe("lapsed");
  await expect(claim("claimant")).resolves.toBeDefined();
  expect(manager.getSession("claimant")?.ownership).toBe("owned");
  for (const at of [6_000, 8_000]) {
    timer.setCurrentTime(at);
    await monitor.tick();
    expect(manager.hasSession("awaiting")).toBe(true);
  }
  timer.setCurrentTime(8_001);
  await monitor.tick();
  expect(manager.hasSession("awaiting")).toBe(false);
});

test("releasing a token clears its mint start and a new owner uses its own stamp", async () => {
  const { timer, manager, heartbeat } = setup();
  const session = await manager.createSession("S", "device", "android");
  expect(manager.bindAcquiredLivenessOwnerToken("S", "minter")).toBe(true);
  timer.setCurrentTime(2_000);
  expect(await manager.releaseLivenessOwnership("S", "rival")).toBe("not-owner");
  expect(session.livenessOwnerBoundAt).toBe(0);
  expect(await manager.releaseLivenessOwnership("S", "minter")).toBe("released");
  expect(session.livenessOwnerToken).toBeUndefined();
  expect(session.livenessOwnerBoundAt).toBeUndefined();
  await heartbeat("S", "successor");
  expect(session.livenessOwnerBoundAt).toBeUndefined();
  expect(ownerLeaseHeartbeat(session)).toBe(2_000);
});

test("recorded takeover clears the old token's mint start", async () => {
  const { timer, manager, heartbeat } = setup();
  const session = await manager.createSession("S", "device", "android");
  expect(manager.bindAcquiredLivenessOwnerToken("S", "minter")).toBe(true);
  timer.setCurrentTime(8_001);
  await heartbeat("S", "successor");
  expect(session.livenessOwnerBoundAt).toBeUndefined();
  expect(ownerLeaseHeartbeat(session)).toBe(8_001);
});

for (const operation of ["claim", "release"] as const) {
  test(`failed ${operation} write restores the original token and its mint start`, async () => {
    const { timer, persistence, manager } = setup();
    const session = await manager.createSession("S", "device", "android");
    timer.setCurrentTime(1_000);
    expect(manager.bindAcquiredLivenessOwnerToken("S", "minter")).toBe(true);
    timer.setCurrentTime(9_001);
    const write = spyOn(persistence, "recordLivenessOwnership").mockRejectedValue(
      new Error("write failed"),
    );
    try {
      const change =
        operation === "claim"
          ? manager.claimLivenessOwnership("S", "successor")
          : manager.releaseLivenessOwnership("S", "minter");
      await expect(change).rejects.toThrow("write failed");
      expect(session.livenessOwnerToken).toBe("minter");
      expect(session.livenessOwnerBoundAt).toBe(1_000);
      expect(session.lastOwnerHeartbeat).toBeUndefined();
      expect(session.hasReceivedHeartbeat).toBe(false);
      expect(manager.getOwnerLeaseHold("S")?.state).toBe("lapsed");
    } finally {
      write.mockRestore();
    }
  });
}
