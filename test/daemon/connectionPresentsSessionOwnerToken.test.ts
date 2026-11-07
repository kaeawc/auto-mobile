import { expect, test } from "bun:test";
import { SessionManager } from "../../src/daemon/sessionManager";
import { DevicePool } from "../../src/daemon/devicePool";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";

async function setup() {
  const timer = new FakeTimer();
  const manager = new SessionManager(timer, new FakeDeviceSessionPersistence(), {
    barrier: () => new FakeDbWriteBarrier(),
  });
  manager.stopCleanupTimer();
  const device = { deviceId: "emulator-5554", name: "Pixel", platform: "android" as const };
  const devices = new FakeDeviceUtils();
  devices.setBootedDevices("android", [device]);
  devices.setBootedDevices("ios", []);
  const pool = new DevicePool(
    createDevicePoolDependencies(manager, "test-daemon", { timer, deviceManager: devices }),
  );
  await manager.createSession("S", device.deviceId, "android");
  expect(manager.bindAcquiredLivenessOwnerToken("S", "owner-token")).toBe(true);
  return pool;
}

test("a connection that declared the session's owner token presents it (#13540)", async () => {
  const pool = await setup();
  pool.declareMcpSessionLivenessOwnerToken("conn-owner", "owner-token");
  expect(pool.connectionPresentsSessionOwnerToken("S", "conn-owner")).toBe(true);
});

test("a connection with another token, or none, does not present it", async () => {
  const pool = await setup();
  pool.declareMcpSessionLivenessOwnerToken("conn-other", "other-token");
  expect(pool.connectionPresentsSessionOwnerToken("S", "conn-other")).toBe(false);
  expect(pool.connectionPresentsSessionOwnerToken("S", "conn-silent")).toBe(false);
  expect(pool.connectionPresentsSessionOwnerToken("unknown", "conn-other")).toBe(false);
});
