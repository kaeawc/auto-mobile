import { afterEach, expect, test } from "bun:test";
import { SessionManager, type SessionReleaseOptions } from "../../src/daemon/sessionManager";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../fakes/FakeTimer";

const managers: SessionManager[] = [];

function create(): SessionManager {
  const manager = new SessionManager(new FakeTimer(), new FakeDeviceSessionPersistence(), {
    barrier: () => new FakeDbWriteBarrier(),
  });
  managers.push(manager);
  return manager;
}

afterEach(() => {
  for (const manager of managers.splice(0)) {
    manager.stopCleanupTimer();
  }
});

// The request-only controls are consumed at the entry point; release listeners keep seeing exactly
// the SessionReleaseOptions the caller supplied (#11800).
test("allowExpired, commitFence, and expectedOwner never reach release listeners", async () => {
  const manager = create();
  const session = await manager.createSession("s1", "emulator-5554", "android");
  const seen: SessionReleaseOptions[] = [];
  manager.onSessionRelease((_id, _device, _reason, _snapshot, options) => {
    seen.push(options);
  });

  const deviceId = await manager.releaseSession("s1", "explicit-release", {
    allowExpired: true,
    commitFence: () => true,
    expectedOwner: { session, deviceId: "emulator-5554" },
    deviceIdentityReplaced: true,
  });

  expect(deviceId).toBe("emulator-5554");
  expect(seen).toEqual([{ deviceIdentityReplaced: true }]);
});

test("a declining commit fence supersedes the release and keeps the session", async () => {
  const manager = create();
  await manager.createSession("s1", "emulator-5554", "android");

  const result = await manager.releaseSessionUnlessSuperseded("s1", "device-killed", {
    commitFence: () => false,
  });

  expect(result).toEqual({ superseded: true });
  expect(manager.getSession("s1")).not.toBeNull();
});

test("an owned release forwards a declining commit fence and keeps the session", async () => {
  const manager = create();
  const session = await manager.createSession("s1", "emulator-5554", "android");

  const deviceId = await manager.releaseSession("s1", "device-killed", {
    expectedOwner: { session, deviceId: "emulator-5554" },
    commitFence: () => false,
  });

  expect(deviceId).toBeNull();
  expect(manager.getSession("s1")).toBe(session);
});

test("releaseSessionUnlessSuperseded without a fence releases like releaseSession", async () => {
  const manager = create();
  await manager.createSession("s1", "emulator-5554", "android");

  const result = await manager.releaseSessionUnlessSuperseded("s1", "explicit-release");

  expect(result).toEqual({ superseded: false, deviceId: "emulator-5554" });
  expect(manager.getSession("s1")).toBeNull();
});
