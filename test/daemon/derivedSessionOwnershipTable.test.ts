import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { handleDaemonRequest } from "../../src/daemon/daemonRequestHandlers";
import { DevicePool } from "../../src/daemon/devicePool";
import { DeviceSessionRegistry } from "../../src/daemon/deviceSessionRegistry";
import { DEVICE_OWNED_BY_OTHER_SESSION_CODE } from "../../src/daemon/inputDeviceOwnership";
import { registerDerivedLabelSessionReleaseCascade } from "../../src/daemon/derivedLabelSessionReleaseCascade";
import {
  OWNER_DISCONNECT_GRACE_MS,
  OWNER_DISCONNECTED_RELEASE_REASON,
} from "../../src/daemon/ownerDisconnectRelease";
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
import { asPlanAllocation } from "../helpers/planLabelAllocation";

// #11586: a derived `${base}:${label}` session counts as its base wherever connection ownership
// is judged or recorded. Each ownership operation is run twice on identical worlds, once naming
// the base and once naming the derived session, and must come out the same.

const primary: BootedDevice = { name: "Pixel A", deviceId: "emulator-5554", platform: "android" };
const labelled: BootedDevice = { name: "Pixel B", deviceId: "emulator-5556", platform: "android" };
const spare: BootedDevice = { name: "Pixel C", deviceId: "emulator-5558", platform: "android" };
const BASE = "sess-a";
const DERIVED = `${BASE}:B`;
const OWNER = "conn-owner";
const OTHER = "conn-other";
const OWNER_TOKEN = "owner-liveness-token";
const CLAIMANT_TOKEN = "claimant-liveness-token";

interface World {
  timer: FakeTimer;
  manager: SessionManager;
  pool: DevicePool;
}

const worlds: World[] = [];
const spies: Array<{ mockRestore(): void }> = [];

/** A daemon's session manager and pool over `devices`, holding no session yet. */
async function emptyWorld(devices: BootedDevice[]): Promise<World> {
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
  discovery.setBootedDevices("android", devices);
  discovery.setBootedDevices("ios", []);
  const pool = new DevicePool(
    createDevicePoolDependencies(manager, "ownership-table-daemon", {
      timer,
      deviceManager: discovery,
    }),
  );
  await pool.initializeWithDevices(devices);
  const built = { timer, manager, pool };
  worlds.push(built);
  return built;
}

/** Publish label `B` on `base` and allocate it, as a plan's device allocation does. */
async function allocateLabelB(w: World, base: string): Promise<string> {
  const labels = buildDeviceLabelMap(["A", "B"], base);
  w.manager.setDeviceLabels(base, labels);
  await asPlanAllocation(w.manager, base, [labels.B], () =>
    w.pool.assignMultipleDevices([labels.B], 1_000, "android"),
  );
  return labels.B;
}

/** OWNER's plan: the base on the first device, its label session `B` on the second. */
async function world(
  baseOwner: string | undefined,
  devices: BootedDevice[] = [primary, labelled],
  base: string = BASE,
): Promise<World> {
  const w = await emptyWorld(devices);
  await bind(w.pool, base, primary.deviceId, baseOwner);
  await allocateLabelB(w, base);
  return w;
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

/**
 * What a liveness claim on `sessionId` left behind (#11602): whether the claimant's token now
 * answers for the session it named, and whether the base owner's token still answers for the base.
 */
function liveness({ manager }: World, sessionId: string): Record<string, boolean> {
  return {
    "the claimant's token answers for the named session": manager.hasLivenessOwnership(
      sessionId,
      CLAIMANT_TOKEN,
    ),
    "the base owner's token answers for the base": manager.hasLivenessOwnership(BASE, OWNER_TOKEN),
  };
}

/** The daemon's heartbeat ingress, as the proxy and the CLI keeper reach it. */
async function heartbeat(w: World, sessionId: string, token: string, claim: boolean) {
  const answer = await handleDaemonRequest(
    {
      id: "heartbeat",
      type: "daemon_request",
      method: "daemon/heartbeat",
      params: {
        sessionId,
        livenessOwnerToken: token,
        ...(claim ? { claimLivenessOwnership: true } : {}),
      },
    },
    {
      isInitialized: () => true,
      getSessionManager: () => w.manager,
      getDevicePool: () => ({
        refreshDevices: async () => 0,
        getStats: () => ({ total: 2, idle: 0, assigned: 2, error: 0 }),
      }),
      getDeviceSessionRegistry: () => new DeviceSessionRegistry(w.timer),
    },
  );
  return {
    success: answer.success,
    code: answer.code ?? null,
    error: answer.error?.replaceAll(sessionId, "<session>") ?? null,
  };
}

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
  // #11602: a liveness claim that names a label session is judged as a claim on its base.
  "a liveness claim": async (w, id) => ({
    outcome: await w.manager.claimLivenessOwnership(id, CLAIMANT_TOKEN),
    liveness: liveness(w, id),
  }),
  "a liveness claim against the base owner's live lease": async (w, id) => {
    await w.manager.claimLivenessOwnership(BASE, OWNER_TOKEN);
    return {
      outcome: await w.manager.claimLivenessOwnership(id, CLAIMANT_TOKEN),
      hold: w.manager.getOwnerLeaseHold(id) ?? null,
      liveness: liveness(w, id),
    };
  },
  "a liveness claim once the base owner's lease and grace have lapsed": async (w, id) => {
    await w.manager.claimLivenessOwnership(BASE, OWNER_TOKEN);
    // An accepted claim is its owner's heartbeat, holding suspect grace; the lapse check is strict (#11646).
    w.timer.advanceTime(OWNER_DISCONNECT_GRACE_MS + 1);
    return { outcome: await w.manager.claimLivenessOwnership(id, CLAIMANT_TOKEN) };
  },
  "a tokened heartbeat adopting unowned liveness": (w, id) => ({
    adopted: w.manager.claimUnownedLivenessOwnership(id, CLAIMANT_TOKEN),
    liveness: liveness(w, id),
  }),
  "a tokened heartbeat adopting liveness past the base owner's token": async (w, id) => {
    await w.manager.claimLivenessOwnership(BASE, OWNER_TOKEN);
    return {
      adopted: w.manager.claimUnownedLivenessOwnership(id, CLAIMANT_TOKEN),
      liveness: liveness(w, id),
    };
  },
  "a claiming heartbeat": async (w, id) => ({
    answer: await heartbeat(w, id, CLAIMANT_TOKEN, true),
    liveness: liveness(w, id),
  }),
  "a claiming heartbeat against the base owner's live lease": async (w, id) => {
    await w.manager.claimLivenessOwnership(BASE, OWNER_TOKEN);
    return {
      answer: await heartbeat(w, id, CLAIMANT_TOKEN, true),
      liveness: liveness(w, id),
    };
  },
  "a heartbeat with a token that is not the base owner's": async (w, id) => {
    await w.manager.claimLivenessOwnership(BASE, OWNER_TOKEN);
    return {
      answer: (await heartbeat(w, id, CLAIMANT_TOKEN, false)).success,
      liveness: liveness(w, id),
    };
  },
  "the base owner's own heartbeat": async (w, id) => {
    await w.manager.claimLivenessOwnership(BASE, OWNER_TOKEN);
    return {
      answer: await heartbeat(w, id, OWNER_TOKEN, false),
      liveness: liveness(w, id),
    };
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

  describe("a bind that names a label of the base as the session to create or move", () => {
    const UNMINTED = `${BASE}:C`;
    const idleDevice = (w: World): string =>
      [labelled, spare].find((d) => w.pool.getDevice(d.deviceId)?.sessionId === null)!.deviceId;

    /** The plan's world plus an idle third device, with label C published but not yet allocated. */
    async function worldWithSpare(): Promise<World> {
      const w = await world(OWNER, [primary, labelled, spare]);
      w.manager.setDeviceLabels(BASE, buildDeviceLabelMap(["A", "B", "C"], BASE));
      return w;
    }

    test.each([
      { name: "a label not allocated yet", session: UNMINTED, rebind: false },
      { name: "a live label, as a rebind", session: DERIVED, rebind: true },
    ])("another connection is refused and takes nothing: $name", async ({ session, rebind }) => {
      const w = await worldWithSpare();
      const before = ownership(w);
      const idle = idleDevice(w);

      const bound = w.pool.bindOrReuseDeviceSession(
        session,
        idle,
        "android",
        undefined,
        undefined,
        undefined,
        rebind,
        undefined,
        undefined,
        undefined,
        OTHER,
      );

      await expect(bound).rejects.toMatchObject({ code: DEVICE_OWNED_BY_OTHER_SESSION_CODE });
      expect(ownership(w)).toEqual(before);
      expect(w.pool.getDevice(idle)?.sessionId).toBeNull();
      expect(
        w.pool.resolveOwnedDeviceSessionForMcpSession(OTHER, primary.deviceId),
      ).toBeUndefined();
    });

    test("the base's owner is refused too outside its plan's allocation, and stays the owner", async () => {
      const w = await worldWithSpare();
      const idle = idleDevice(w);

      await expect(bind(w.pool, UNMINTED, idle, OWNER)).rejects.toMatchObject({
        name: "TerminalSessionError",
      });

      expect(w.pool.getDevice(idle)?.sessionId).toBeNull();
      expect(w.manager.hasSession(UNMINTED)).toBe(false);
      expect(w.pool.isSessionOwnedByOtherConnection(BASE, OWNER)).toBe(false);
    });
  });

  test("a liveness claim naming a published label that was never allocated claims nothing", async () => {
    const w = await world(OWNER);
    w.manager.setDeviceLabels(BASE, buildDeviceLabelMap(["A", "B", "C"], BASE));

    expect(await w.manager.claimLivenessOwnership(`${BASE}:C`, CLAIMANT_TOKEN)).toBe("not-found");

    expect(w.manager.getSession(BASE)?.livenessOwnerToken).toBeUndefined();
  });

  test("a liveness claim on a label published under a label is judged against the outermost base", async () => {
    const w = await world(OWNER);
    const nested = `${DERIVED}:C`;
    w.manager.setDeviceLabels(DERIVED, { B: DERIVED, C: nested });
    await asPlanAllocation(w.manager, DERIVED, [nested], () =>
      w.manager.createSession(nested, "emulator-5558", "android"),
    );
    await w.manager.claimLivenessOwnership(BASE, OWNER_TOKEN);

    expect(await w.manager.claimLivenessOwnership(nested, CLAIMANT_TOKEN)).toBe("conflict");
    expect(await w.manager.claimLivenessOwnership(nested, OWNER_TOKEN)).toBe("claimed");
  });

  test("a label the base no longer publishes is judged on its own", async () => {
    const w = await world(OWNER);
    await w.manager.claimLivenessOwnership(BASE, OWNER_TOKEN);
    w.manager.setDeviceLabels(BASE, { A: BASE });

    expect(await w.manager.claimLivenessOwnership(DERIVED, CLAIMANT_TOKEN)).toBe("claimed");
    expect(w.manager.hasLivenessOwnership(BASE, OWNER_TOKEN)).toBe(true);
  });

  test("a label is adopted as before once its base owner's lease has lapsed", async () => {
    const w = await world(OWNER);
    await w.manager.claimLivenessOwnership(BASE, OWNER_TOKEN);
    expect(w.manager.claimUnownedLivenessOwnership(DERIVED, CLAIMANT_TOKEN)).toBe(false);

    // An accepted claim is its owner's heartbeat, holding suspect grace; the lapse check is strict (#11646).
    w.timer.advanceTime(OWNER_DISCONNECT_GRACE_MS + 1);

    expect(w.manager.claimUnownedLivenessOwnership(DERIVED, CLAIMANT_TOKEN)).toBe(true);
    expect(w.manager.hasLivenessOwnership(BASE, OWNER_TOKEN)).toBe(true);
  });

  // The label keeps its own liveness record: the heartbeat path reads and renews the session it
  // names, so the claim is judged on the base and recorded on the label.
  test("a claim through a label is recorded on the label and proves nothing about its base", async () => {
    const w = await world(OWNER);

    expect(await w.manager.claimLivenessOwnership(DERIVED, CLAIMANT_TOKEN)).toBe("claimed");

    expect(w.manager.getSession(DERIVED)?.livenessOwnerToken).toBe(CLAIMANT_TOKEN);
    expect(w.manager.getSession(BASE)?.livenessOwnerToken).toBeUndefined();
    expect((await restore(w, DERIVED, OTHER, CLAIMANT_TOKEN)).refused).toEqual([
      "owned-by-other-connection",
    ]);
    expect(w.pool.isSessionOwnedByOtherConnection(BASE, OWNER)).toBe(false);
  });

  test("the base owner's token on its own label holds the label against another token", async () => {
    const w = await world(OWNER);
    await w.manager.claimLivenessOwnership(BASE, OWNER_TOKEN);
    expect((await heartbeat(w, DERIVED, OWNER_TOKEN, true)).success).toBe(true);

    // The owner heartbeats only the label from here on: the base's own lease lapses.
    for (let elapsed = 0; elapsed < OWNER_DISCONNECT_GRACE_MS; elapsed += 2_000) {
      w.timer.advanceTime(2_000);
      expect((await heartbeat(w, DERIVED, OWNER_TOKEN, false)).success).toBe(true);
    }

    expect((await heartbeat(w, DERIVED, CLAIMANT_TOKEN, true)).code).toBe(
      "liveness_owner_conflict",
    );
    expect(w.manager.hasLivenessOwnership(DERIVED, OWNER_TOKEN)).toBe(true);
    expect((await heartbeat(w, DERIVED, OWNER_TOKEN, false)).success).toBe(true);
  });

  // #11602: the three cells #11586 left unverified, driven on the real pool and manager.
  test("the owner's disconnect releases the base, then each label once, and frees both devices", async () => {
    const w = await world(OWNER);
    const releases: Array<[string, string]> = [];
    w.manager.onSessionRelease((sessionId, _deviceId, reason, _snapshot, options) => {
      releases.push([sessionId, options?.upgradeOnly ? `${reason} (upgrade)` : reason]);
    });
    const cascade = registerDerivedLabelSessionReleaseCascade(w.manager, w.pool);

    w.pool.releaseMcpSessionBindings(OWNER);
    await afterGrace(w);
    await cascade.settled();
    await drainMicrotasks(FAKE_TIMER_QUIET_TURNS);

    expect(releases).toEqual([
      [BASE, OWNER_DISCONNECTED_RELEASE_REASON],
      // The base's end ends its labels with the base's own reason (#11640).
      [DERIVED, OWNER_DISCONNECTED_RELEASE_REASON],
    ]);
    expect(w.manager.getSession(DERIVED)).toBeNull();
    expect(w.pool.getDevice(primary.deviceId)?.sessionId).toBeNull();
    expect(w.pool.getDevice(labelled.deviceId)?.sessionId).toBeNull();
    expect(ownership(w)).toEqual({
      "base foreign to conn-owner": false,
      "base foreign to conn-other": false,
      "derived foreign to conn-owner": false,
      "derived foreign to conn-other": false,
    });
  });

  test("a caller with no connection identity finds a label of an autolock base as foreign as the base", async () => {
    const w = await emptyWorld([primary, labelled]);
    const base = await w.pool.autolockDevice(
      primary.deviceId,
      "android",
      OWNER,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { autolockEnabled: true },
    );
    if (base === undefined) {
      throw new Error("the autolock acquisition issued no session");
    }
    const derived = await allocateLabelB(w, base);

    expect(w.pool.getDevice(primary.deviceId)?.autolockSessionId).toBe(base);
    expect(w.pool.getDevice(labelled.deviceId)?.sessionId).toBe(derived);
    expect(w.pool.isSessionOwnedByOtherConnection(base)).toBe(true);
    expect(w.pool.isSessionOwnedByOtherConnection(derived)).toBe(true);
    expect(w.pool.isSessionOwnedByOtherConnection(derived, OWNER)).toBe(false);
    expect(w.pool.isSessionOwnedByOtherConnection(derived, OTHER)).toBe(true);
  });

  test("a base id that contains ':' is a base, and its label resolves to it and to nothing shorter", async () => {
    const base = "team:run";
    const w = await world(OWNER, [primary, labelled], base);
    const derived = `${base}:B`;
    await w.manager.claimLivenessOwnership(base, OWNER_TOKEN);

    expect(w.pool.isSessionOwnedByOtherConnection(derived, OTHER)).toBe(true);
    expect(w.pool.isSessionOwnedByOtherConnection(derived, OWNER)).toBe(false);
    expect(await w.manager.claimLivenessOwnership(derived, CLAIMANT_TOKEN)).toBe("conflict");
    // Nothing publishes `team:run` as a label of `team`, so the base is not read as derived.
    expect(w.manager.hasLivenessOwnership(base, OWNER_TOKEN)).toBe(true);
    expect(w.manager.getSession(base)?.livenessOwnerToken).toBe(OWNER_TOKEN);
  });

  test("a label session published under a label session counts as the outermost base", async () => {
    const w = await world(OWNER);
    const nested = `${DERIVED}:C`;
    w.manager.setDeviceLabels(DERIVED, { B: DERIVED, C: nested });
    await asPlanAllocation(w.manager, DERIVED, [nested], () =>
      w.manager.createSession(nested, "emulator-5558", "android"),
    );

    expect(w.pool.isSessionOwnedByOtherConnection(nested, OTHER)).toBe(true);
    expect(w.pool.isSessionOwnedByOtherConnection(nested, OWNER)).toBe(false);
  });
});
