import { expect, test } from "bun:test";
import { DeviceSessionRepository } from "../../src/db/deviceSessionRepository";
import { createTestDatabase } from "../db/testDbHelper";
import { FakeTimer } from "../fakes/FakeTimer";
import { releaseSessionAndDevice } from "../../src/daemon/releaseSessionAndDevice";
import { deliverDaemonHeartbeat } from "../helpers/daemonHeartbeatHandler";
import { TwoDaemonWorld } from "../helpers/twoDaemonOwnershipHarness";

test("plain explicit bind keeps its host-wide claim foreign throughout ten minutes of heartbeats", async () => {
  const db = await createTestDatabase();
  const timer = new FakeTimer();
  const world = new TwoDaemonWorld(
    new DeviceSessionRepository(db, timer),
    async () => [],
    new Set(),
    timer,
  );
  try {
    await world.start();
    const owner = world.daemons[0]!;
    const broker = world.daemons[1]!;
    const serial = "emulator-5610";
    const device = { deviceId: serial, name: "Pixel", platform: "android" as const };
    world.discovery.setBootedDevices("android", [device]);
    await owner.pool.initializeWithDevices([device]);
    await broker.pool.initializeWithDevices([device]);
    const sessionId = await owner.pool.bindOrReuseDeviceSession({
      sessionId: "plain-session",
      deviceId: serial,
      platform: "android",
    });
    await owner.manager.claimLivenessOwnership(sessionId, "plain-owner");
    // Periodic tool activity keeps the normal idle policy from ending this long hold.
    for (let seconds = 0; seconds <= 600; seconds++) {
      expect(owner.manager.hasSession(sessionId)).toBe(true);
      expect(owner.pool.getDevice(serial)?.sessionId).toBe(sessionId);
      expect(world.claims.files.get(world.claims.claimPath(serial))?.pid).toBe(owner.pid);
      expect(await broker.pool.foreignSerials([serial])).toEqual(new Set([serial]));
      if (seconds < 600) {
        await deliverDaemonHeartbeat(owner.manager, sessionId, {
          livenessOwnerToken: "plain-owner",
        });
        owner.manager.recordToolCallEnded(sessionId, { admitted: true });
        await world.advance(1_000);
      }
    }
    owner.manager.recordToolCallEnded(sessionId, { admitted: true });
    await releaseSessionAndDevice(owner.manager, owner.pool, serial, sessionId, "explicit-release");
    await world.settle();
    expect(world.claims.files.has(world.claims.claimPath(serial))).toBe(false);
    await world.advance(8_000);
    expect(await broker.pool.foreignSerials([serial])).toEqual(new Set());
    expect(world.violation).toBeUndefined();
  } finally {
    await world.stopAll();
    await db.destroy();
  }
});
