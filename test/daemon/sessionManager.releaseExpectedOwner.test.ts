import { expect, test } from "bun:test";
import { PLAN_AUTO_RELEASE_REASON } from "../../src/daemon/sessionManager";
import {
  DeferredDeviceSessionPersistence,
  DeferredReleaseDeviceSessionPersistence,
  installSessionManagerCleanup,
  makeSessionManager,
} from "../helpers/sessionManagerSuite";

installSessionManagerCleanup();

const ID = "owned";
const DEVICE = "emulator-5554";

test("releases the published incarnation only while it owns the expected device", async () => {
  const manager = makeSessionManager();
  const session = await manager.createSession(ID, DEVICE, "android");

  expect(
    await manager.releaseSession(ID, "explicit-release", {
      expectedOwner: { session: session, deviceId: DEVICE },
    }),
  ).toBe(DEVICE);
  expect(manager.getSession(ID)).toBeNull();
});

test("a different Session object cannot release the published incarnation", async () => {
  const manager = makeSessionManager();
  const session = await manager.createSession(ID, DEVICE, "android");

  expect(
    await manager.releaseSession(ID, "explicit-release", {
      expectedOwner: { session: { ...session }, deviceId: DEVICE },
    }),
  ).toBeNull();
  expect(manager.getSession(ID)).toBe(session);
});

test("the published incarnation cannot release a different device", async () => {
  const manager = makeSessionManager();
  const session = await manager.createSession(ID, DEVICE, "android");

  expect(
    await manager.releaseSession(ID, "explicit-release", {
      expectedOwner: { session: session, deviceId: "other-device" },
    }),
  ).toBeNull();
  expect(manager.getSession(ID)).toBe(session);
});

test("a pending creation blocks release of an unpublished old incarnation", async () => {
  const persistence = new DeferredDeviceSessionPersistence();
  const manager = makeSessionManager({ persistence });
  const session = await manager.createSession(ID, DEVICE, "android");
  await manager.releaseSession(ID, PLAN_AUTO_RELEASE_REASON);
  persistence.deferNextUpsert();
  const creation = manager.createSession(ID, "new-device", "android");
  await persistence.waitForUpsert();
  try {
    expect(
      await manager.releaseSession(ID, "device-killed", {
        expectedOwner: { session: session, deviceId: DEVICE },
      }),
    ).toBeNull();
  } finally {
    persistence.finishUpsert();
    await creation;
  }
  expect(manager.getSession(ID)?.assignedDevice).toBe("new-device");
});

test("a pending assignment blocks release of an unpublished old incarnation", async () => {
  const manager = makeSessionManager();
  const session = await manager.createSession(ID, DEVICE, "android");
  await manager.releaseSession(ID, PLAN_AUTO_RELEASE_REASON);
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const assignment = manager.getOrCreateSession(ID, {
    async assignDeviceToSession(id) {
      started.resolve();
      await finish.promise;
      await manager.createSession(id, "new-device", "android");
      return "new-device";
    },
  });
  await started.promise;
  try {
    expect(
      await manager.releaseSession(ID, "device-killed", {
        expectedOwner: { session: session, deviceId: DEVICE },
      }),
    ).toBeNull();
  } finally {
    finish.resolve();
    await assignment;
  }
  expect(manager.getSession(ID)?.assignedDevice).toBe("new-device");
});

test("joins the in-flight release of the expected unpublished incarnation", async () => {
  const persistence = new DeferredReleaseDeviceSessionPersistence();
  const manager = makeSessionManager({ persistence });
  const session = await manager.createSession(ID, DEVICE, "android");
  const release = manager.releaseSession(ID);
  await persistence.releaseStarted.promise;
  expect(manager.getSession(ID)).toBeNull();
  const joined = manager.releaseSession(ID, "explicit-release", {
    expectedOwner: { session: session, deviceId: DEVICE },
  });
  persistence.finishRelease.resolve();

  expect(await joined).toBe(DEVICE);
  expect(await release).toBe(DEVICE);
  expect(persistence.reasons).toEqual(["explicit-release"]);
});

test.each(["incarnation", "device"] as const)(
  "rejects an in-flight release with a different %s",
  async (mismatch) => {
    const persistence = new DeferredReleaseDeviceSessionPersistence();
    const manager = makeSessionManager({ persistence });
    const session = await manager.createSession(ID, DEVICE, "android");
    const release = manager.releaseSession(ID);
    await persistence.releaseStarted.promise;
    try {
      expect(
        await manager.releaseSession(ID, "device-killed", {
          expectedOwner: {
            session: mismatch === "incarnation" ? { ...session } : session,
            deviceId: mismatch === "device" ? "other-device" : DEVICE,
          },
        }),
      ).toBeNull();
    } finally {
      persistence.finishRelease.resolve();
      await release;
    }
    expect(persistence.reasons).toEqual(["explicit-release"]);
  },
);

test("a terminal reason releases the finalized terminal incarnation", async () => {
  const manager = makeSessionManager();
  const session = await manager.createSession(ID, DEVICE, "android");
  await manager.releaseSession(ID, "heartbeat-timeout");

  expect(
    await manager.releaseSession(ID, "device-killed", {
      expectedOwner: { session: session, deviceId: DEVICE },
    }),
  ).toBe(DEVICE);
  expect(manager.getTerminalReleaseSnapshot(ID)?.releaseReason).toBe("device-killed");
});

test("a non-terminal reason cannot release the finalized terminal incarnation", async () => {
  const manager = makeSessionManager();
  const session = await manager.createSession(ID, DEVICE, "android");
  await manager.releaseSession(ID, "device-killed");

  expect(
    await manager.releaseSession(ID, PLAN_AUTO_RELEASE_REASON, {
      expectedOwner: { session: session, deviceId: DEVICE },
    }),
  ).toBeNull();
  expect(manager.getTerminalReleaseSnapshot(ID)?.releaseReason).toBe("device-killed");
});

test("an unknown id has no owned incarnation to release", async () => {
  const manager = makeSessionManager();
  const session = await manager.createSession(ID, DEVICE, "android");

  expect(
    await manager.releaseSession("unknown", "device-killed", {
      expectedOwner: { session: session, deviceId: DEVICE },
    }),
  ).toBeNull();
  expect(manager.getSession(ID)).toBe(session);
});
