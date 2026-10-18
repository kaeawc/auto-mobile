import { expect, test } from "bun:test";
import { TerminalSessionError } from "../../src/daemon/TerminalSessionError";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { installSessionManagerCleanup, makeSessionManager } from "../helpers/sessionManagerSuite";

installSessionManagerCleanup();

function manager() {
  return makeSessionManager({ fakeBarrier: true });
}

test("pin belongs to one session and clears on release and reacquisition with a new uuid", async () => {
  const sessions = manager();
  await sessions.createSession("one", "device-1", "android");
  await sessions.createSession("two", "device-2", "android");
  sessions.setDisplayPin("one", "inner");
  sessions.setDisplayPin("two", "cover");
  expect(sessions.getDisplayPin("one")).toBe("inner");
  await sessions.releaseSession("one", "explicit-release");
  expect(sessions.getDisplayPin("one")).toBeUndefined();
  expect(sessions.getDisplayPin("two")).toBe("cover");
  expect(sessions.getSession("one")).toBeNull();
  await expect(sessions.createSession("one", "device-1", "android")).rejects.toBeInstanceOf(
    TerminalSessionError,
  );
  await sessions.createSession("new", "device-1", "android");
  expect(sessions.getDeviceForSession("new")).toBe("device-1");
  expect(sessions.getDisplayPin("new")).toBeUndefined();
});

test("rebind drops pin and observation cache clearing preserves it", async () => {
  const sessions = manager();
  await sessions.createSession("one", "device-1", "android");
  sessions.setDisplayPin("one", "inner");
  sessions.clearSessionCache("one");
  expect(sessions.getDisplayPin("one")).toBe("inner");
  await sessions.rebindSession("one", "device-2", "android");
  expect(sessions.getDisplayPin("one")).toBeUndefined();
  await sessions.createSession("fresh", "device-3", "android");
  expect(sessions.getDisplayPin("fresh")).toBeUndefined();
});

test("persistence and restart rehydration never resurrect a session pin", async () => {
  const timer = new FakeTimer();
  const persistence = new FakeDeviceSessionPersistence();
  const original = makeSessionManager({ timer, persistence, fakeBarrier: true });
  await original.createSession("recover", "device-1", "android");
  original.setDisplayPin("recover", "inner");
  expect(await persistence.getSession!("recover")).not.toHaveProperty("displayPin");
  await original.releaseSession("recover", "daemon-restart");
  const restarted = makeSessionManager({ timer, persistence, fakeBarrier: true });
  const summary = await restarted.rehydratePersistedSessions({
    assignDeviceToSession: async (sessionId) => {
      await restarted.createSession(sessionId, "device-1", "android");
      return "device-1";
    },
  });
  expect(summary.rehydrated).toEqual(["recover"]);
  expect(restarted.getDisplayPin("recover")).toBeUndefined();
  expect(await persistence.getSession!("recover")).not.toHaveProperty("displayPin");
});

test("clearing a display pin removes its own cache key", async () => {
  const sessions = manager();
  await sessions.createSession("one", "device-1", "android");
  sessions.setDisplayPin("one", "inner");
  sessions.setDisplayPin("one", null);
  expect(Object.hasOwn(sessions.getSession("one")!.cacheData, "displayPin")).toBe(false);
});
