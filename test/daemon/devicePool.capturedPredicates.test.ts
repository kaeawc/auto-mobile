import { expect, test } from "bun:test";
import { DevicePool, type PooledDevice } from "../../src/daemon/devicePool";
import { SessionManager, type Session } from "../../src/daemon/sessionManager";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeTimer } from "../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";

interface PredicateContext {
  pool: DevicePool;
  manager: SessionManager;
  timer: FakeTimer;
  device: PooledDevice;
  session: Session;
}

interface PredicateRow {
  name: string;
  prepare?: (context: PredicateContext) => void | Promise<void>;
  // preserved session, assignable idle entry, current assignment, captured release
  expected: readonly [boolean, boolean, boolean, boolean];
}

const rows: PredicateRow[] = [
  {
    name: "available",
    prepare: ({ device, session }) => {
      device.status = "idle";
      device.sessionId = null;
      session.assignedDevice = "";
    },
    expected: [false, true, false, false],
  },
  { name: "busy", expected: [true, false, true, true] },
  {
    name: "captured for recovery (detached entry)",
    prepare: ({ pool, device, session }) => {
      device.adbServerResetSession = session;
      device.adbServerResetSessionId = session.sessionId;
      pool["devices"].delete(device.id);
    },
    expected: [true, false, false, false],
  },
  {
    name: "suspect/grace",
    prepare: ({ manager, timer, session }) => {
      manager.recordHeartbeat(session.sessionId);
      timer.setCurrentTime(timer.now() + 1_001);
      expect(manager.getSessionLeaseState(session.sessionId)?.phase).toBe("suspect");
    },
    expected: [true, false, true, true],
  },
  {
    name: "released without expiryOrigin (caller still owns pool cleanup)",
    prepare: async ({ manager, session }) => {
      await manager.releaseSession(session.sessionId);
    },
    expected: [false, false, false, true],
  },
  {
    name: "released with expiryOrigin",
    prepare: async ({ manager, session }) => {
      await manager.releaseSession(session.sessionId, "explicit-release", false, undefined, {
        expiryOrigin: "cleanup-expired",
      });
    },
    expected: [false, true, false, false],
  },
  {
    name: "same-id replacement entry",
    prepare: ({ pool, device }) => {
      pool["devices"].set(device.id, { ...device, incarnation: device.incarnation + 1 });
    },
    expected: [true, false, false, false],
  },
  {
    name: "assignment generation changed",
    prepare: ({ device }) => {
      device.assignmentCount++;
    },
    expected: [true, false, true, false],
  },
  {
    name: "session bound elsewhere",
    prepare: ({ session }) => {
      session.assignedDevice = "other-device";
    },
    expected: [false, false, true, true],
  },
  {
    name: "error entry with matching owner",
    prepare: ({ device }) => {
      device.status = "error";
    },
    expected: [true, false, false, true],
  },
  {
    name: "idle identity quarantine",
    prepare: ({ device, session }) => {
      device.status = "idle";
      device.sessionId = null;
      device.identityUnresolved = true;
      session.assignedDevice = "";
    },
    expected: [false, false, false, false],
  },
];

async function createContext(autolock: boolean): Promise<PredicateContext> {
  const timer = new FakeTimer();
  const manager = new SessionManager(
    timer,
    new FakeDeviceSessionPersistence(),
    () => new FakeDbWriteBarrier(),
  );
  const booted = { deviceId: "emulator-5554", name: "Pixel", platform: "android" as const };
  const utils = new FakeDeviceUtils();
  utils.setBootedDevices("android", [booted]);
  const pool = new DevicePool(
    createDevicePoolDependencies(manager, "predicate-daemon", { timer, deviceManager: utils }),
  );
  await pool.initializeWithDevices([booted]);
  const session = await manager.createSession("owner", booted.deviceId, "android", 1_000, 1_000);
  await pool.bindOrReuseDeviceSession(session.sessionId, booted.deviceId, "android");
  manager.stopCleanupTimer();
  const device = pool.getDevice(booted.deviceId)!;
  device.autolockSessionId = autolock ? session.sessionId : undefined;
  return { pool, manager, timer, device, session };
}

// Both metadata states use exactly the same matrix. Also run this file with the
// autolock environment enabled and disabled: none of these predicates reads it.
for (const autolock of [false, true]) {
  test.each(rows)(`captured predicates (autolock metadata ${autolock}): $name`, async (row) => {
    const context = await createContext(autolock);
    const { pool, manager, device, session } = context;
    const assignmentCount = device.assignmentCount;
    try {
      await row.prepare?.(context);
      expect([
        pool["isPreservedSessionCurrent"](session, device.id),
        pool["isCurrentIdleDeviceAssignable"](device),
        pool["isSessionAssignmentCurrent"](device, session),
        pool["isCapturedReleaseCurrent"](device, session.sessionId, assignmentCount),
      ]).toEqual(row.expected);
    } finally {
      manager.stopCleanupTimer();
    }
  });
}
