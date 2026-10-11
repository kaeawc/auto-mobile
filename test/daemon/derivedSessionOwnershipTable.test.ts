import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { DevicePool } from "../../src/daemon/devicePool";
import { OWNER_DISCONNECT_GRACE_MS } from "../../src/daemon/ownerDisconnectRelease";
import { SessionManager } from "../../src/daemon/sessionManager";
import type { BootedDevice } from "../../src/models";
import { buildDeviceLabelMap } from "../../src/server/deviceLabelMapping";
import { logger } from "../../src/utils/logger";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeTimer } from "../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { drainMicrotasks, FAKE_TIMER_QUIET_TURNS } from "../helpers/fakeTimerStepping";

// #11586: a derived `${base}:${label}` session counts as its base wherever connection ownership
// is judged or recorded. Each ownership operation is run twice on identical worlds, once naming
// the base and once naming the derived session, and must come out the same.

const primary: BootedDevice = { name: "Pixel A", deviceId: "emulator-5554", platform: "android" };
const labelled: BootedDevice = { name: "Pixel B", deviceId: "emulator-5556", platform: "android" };
const BASE = "sess-a";
const DERIVED = `${BASE}:B`;
const OWNER = "conn-owner";
const OTHER = "conn-other";
const OWNER_TOKEN = "owner-liveness-token";

interface World {
  timer: FakeTimer;
  manager: SessionManager;
  pool: DevicePool;
}

const worlds: World[] = [];
const spies: Array<{ mockRestore(): void }> = [];

/** OWNER's plan: the base on the first device, its label session `B` on the second. */
async function world(baseOwner: string | undefined): Promise<World> {
  if (spies.length === 0) {
    for (const level of ["info", "warn", "error", "debug"] as const) {
      spies.push(spyOn(logger, level).mockImplementation(() => {}));
    }
  }
  const timer = new FakeTimer();
  const manager = new SessionManager(
    timer,
    new FakeDeviceSessionPersistence(),
    () => new FakeDbWriteBarrier(),
  );
  manager.stopCleanupTimer();
  const discovery = new FakeDeviceUtils();
  discovery.setBootedDevices("android", [primary, labelled]);
  discovery.setBootedDevices("ios", []);
  const pool = new DevicePool(
    createDevicePoolDependencies(manager, "ownership-table-daemon", {
      timer,
      deviceManager: discovery,
    }),
  );
  await pool.initializeWithDevices([primary, labelled]);
  await bind(pool, BASE, primary.deviceId, baseOwner);
  manager.setDeviceLabels(BASE, buildDeviceLabelMap(["A", "B"], BASE));
  await pool.assignMultipleDevices([DERIVED], 1_000, "android");
  const built = { timer, manager, pool };
  worlds.push(built);
  return built;
}

function bind(
  pool: DevicePool,
  sessionId: string,
  deviceId: string,
  connection: string | undefined,
): Promise<string> {
  return pool.bindOrReuseDeviceSession(
    sessionId,
    deviceId,
    "android",
    undefined,
    undefined,
    undefined,
    false,
    undefined,
    undefined,
    undefined,
    connection,
  );
}

const deviceOf = (sessionId: string): string =>
  sessionId === BASE ? primary.deviceId : labelled.deviceId;

/** Who each connection finds foreign, for both ids: the whole observable ownership state. */
function ownership({ pool }: World): Record<string, boolean> {
  const view: Record<string, boolean> = {};
  for (const id of [BASE, DERIVED]) {
    for (const connection of [OWNER, OTHER]) {
      view[`${id === BASE ? "base" : "derived"} foreign to ${connection}`] =
        pool.isSessionOwnedByOtherConnection(id, connection);
    }
  }
  return view;
}

async function afterGrace(w: World): Promise<{ baseReleased: boolean }> {
  w.timer.advanceTime(OWNER_DISCONNECT_GRACE_MS);
  await drainMicrotasks(FAKE_TIMER_QUIET_TURNS);
  return { baseReleased: w.manager.getSession(BASE) === null };
}

type Operation = (w: World, sessionId: string, caller: string) => unknown;

const restore = async (w: World, sessionId: string, caller: string, token?: string) => ({
  refused: (await w.pool.restoreOwnedDeviceSessionsForMcpSession([sessionId], caller, token)).map(
    (refusal) => refusal.reason,
  ),
  ownership: ownership(w),
});

const OPERATIONS: Record<string, Operation> = {
  "judged foreign to the caller": (w, id, caller) =>
    w.pool.isSessionOwnedByOtherConnection(id, caller),
  "judged foreign to a caller with no connection identity": (w, id) =>
    w.pool.isSessionOwnedByOtherConnection(id),
  "restore by naming it": (w, id, caller) => restore(w, id, caller),
  "restore proving the base's liveness token": async (w, id, caller) => {
    await w.manager.claimLivenessOwnership(BASE, OWNER_TOKEN);
    return restore(w, id, caller, OWNER_TOKEN);
  },
  "restore with a token that is not the base's": async (w, id, caller) => {
    await w.manager.claimLivenessOwnership(BASE, OWNER_TOKEN);
    return restore(w, id, caller, "someone-elses-token");
  },
  "restore on a connection that closed while it waited": async (w, id, caller) => {
    const endBind = w.pool.beginMcpBind(caller);
    w.pool.releaseMcpSessionBindings(caller);
    const restored = await restore(w, id, caller);
    endBind();
    return { ...restored, ...(await afterGrace(w)) };
  },
  "restore, then the caller disconnects": async (w, id, caller) => {
    const restored = await restore(w, id, caller);
    w.pool.releaseMcpSessionBindings(caller);
    return { ...restored, ...(await afterGrace(w)), after: ownership(w) };
  },
  "resolved as the caller's own session from its device": (w, id, caller) =>
    w.pool.resolveOwnedDeviceSessionForMcpSession(caller, deviceOf(id)) === id,
  "an acquisition of its device by the caller": (w, id, caller) =>
    bind(w.pool, "fresh-session", deviceOf(id), caller).then(
      (reused) => ({ reused: reused === id, ownership: ownership(w) }),
      (error: unknown) => ({ refused: (error as Error).message.replace(deviceOf(id), "<device>") }),
    ),
};

const COLUMNS: Array<{ name: string; baseOwner: string | undefined; caller: string }> = [
  { name: "the owner connection", baseOwner: OWNER, caller: OWNER },
  { name: "another connection", baseOwner: OWNER, caller: OTHER },
  { name: "no owner", baseOwner: undefined, caller: OTHER },
];

afterEach(() => {
  for (const w of worlds.splice(0)) {
    w.manager.stopCleanupTimer();
  }
  spies.splice(0).forEach((spy) => spy.mockRestore());
});

describe("a derived label session is judged and recorded as its base", () => {
  for (const [operation, run] of Object.entries(OPERATIONS)) {
    for (const column of COLUMNS) {
      test(`${operation}: ${column.name}`, async () => {
        const forBase = await run(await world(column.baseOwner), BASE, column.caller);
        const forDerived = await run(await world(column.baseOwner), DERIVED, column.caller);

        expect(forDerived).toEqual(forBase);
        expect(forBase).toMatchSnapshot();
      });
    }
  }

  test("releasing the derived session alone leaves the base's owner in place", async () => {
    const w = await world(OWNER);

    await w.manager.releaseSession(DERIVED);
    await drainMicrotasks(FAKE_TIMER_QUIET_TURNS);

    expect(w.pool.isSessionOwnedByOtherConnection(BASE, OTHER)).toBe(true);
    expect(w.pool.isSessionOwnedByOtherConnection(BASE, OWNER)).toBe(false);
  });

  test("the base owner's disconnect arms the base's release, not the label's own", async () => {
    const w = await world(OWNER);
    await w.pool.restoreOwnedDeviceSessionsForMcpSession([DERIVED], OWNER);

    w.pool.releaseMcpSessionBindings(OWNER);

    expect(await afterGrace(w)).toEqual({ baseReleased: true });
  });

  test("a label session published under a label session counts as the outermost base", async () => {
    const w = await world(OWNER);
    const nested = `${DERIVED}:C`;
    w.manager.setDeviceLabels(DERIVED, { B: DERIVED, C: nested });
    await w.manager.createSession(nested, "emulator-5558", "android");

    expect(w.pool.isSessionOwnedByOtherConnection(nested, OTHER)).toBe(true);
    expect(w.pool.isSessionOwnedByOtherConnection(nested, OWNER)).toBe(false);
  });
});
