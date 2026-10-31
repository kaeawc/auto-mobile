import { afterAll, beforeAll, expect, test } from "bun:test";
import { DeviceSessionRepository } from "../../src/db/deviceSessionRepository";
import { createTestDatabase } from "../db/testDbHelper";
import { FakeTimer } from "../fakes/FakeTimer";
import { releaseSessionAndDevice } from "../../src/daemon/releaseSessionAndDevice";
import { deliverDaemonHeartbeat } from "../helpers/daemonHeartbeatHandler";
import { TwoDaemonWorld } from "../helpers/twoDaemonOwnershipHarness";

const serial = "emulator-5610";
const sessionId = "plain-session";

// Setup (database, two daemons, the explicit bind) runs in beforeAll so the timed test covers
// only the hold itself.
let db: Awaited<ReturnType<typeof createTestDatabase>>;
let world: TwoDaemonWorld;

beforeAll(async () => {
  db = await createTestDatabase();
  const timer = new FakeTimer();
  world = new TwoDaemonWorld(
    new DeviceSessionRepository(db, timer),
    async () => [],
    new Set(),
    timer,
  );
  await world.start();
  const device = { deviceId: serial, name: "Pixel", platform: "android" as const };
  world.discovery.setBootedDevices("android", [device]);
  for (const daemon of world.daemons) {
    await daemon.pool.initializeWithDevices([device]);
  }
  await world.daemons[0]!.pool.bindOrReuseDeviceSession({
    sessionId,
    deviceId: serial,
    platform: "android",
  });
  await world.daemons[0]!.manager.claimLivenessOwnership(sessionId, "plain-owner");
});

afterAll(async () => {
  await world.stopAll();
  await db.destroy();
});

test("plain explicit bind keeps its host-wide claim foreign throughout a three-minute hold", async () => {
  const owner = world.daemons[0]!;
  const broker = world.daemons[1]!;
  // Three minutes outlasts the 2-minute idle window, the 4 s heartbeat deadline and every
  // foreign-snapshot TTL. The owner heartbeats every 2 s; the hold, the claim file and the
  // peer's view are asserted every 30 s.
  const assertHeld = async () => {
    expect(owner.manager.hasSession(sessionId)).toBe(true);
    expect(owner.pool.getDevice(serial)?.sessionId).toBe(sessionId);
    expect(world.claims.files.get(world.claims.claimPath(serial))?.pid).toBe(owner.pid);
    expect(await broker.pool.foreignSerials([serial])).toEqual(new Set([serial]));
  };
  for (let tick = 0; tick < 90; tick++) {
    if (tick % 15 === 0) {
      await assertHeld();
    }
    await deliverDaemonHeartbeat(owner.manager, sessionId, { livenessOwnerToken: "plain-owner" });
    owner.manager.recordToolCallEnded(sessionId, { admitted: true });
    await world.advance(2_000);
  }
  await assertHeld();
  owner.manager.recordToolCallEnded(sessionId, { admitted: true });
  await releaseSessionAndDevice({ manager: owner.manager, pool: owner.pool }, serial, sessionId, {
    reason: "explicit-release",
  });
  await world.settle();
  expect(world.claims.files.has(world.claims.claimPath(serial))).toBe(false);
  await world.advance(8_000);
  expect(await broker.pool.foreignSerials([serial])).toEqual(new Set());
  expect(world.violation).toBeUndefined();
});
