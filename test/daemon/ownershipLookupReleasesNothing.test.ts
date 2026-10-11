import { describe, expect, test } from "bun:test";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager, type Session } from "../../src/daemon/sessionManager";
import { buildDeviceLabelMap } from "../../src/server/deviceLabelMapping";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeTimer } from "../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { drainMicrotasks, FAKE_TIMER_QUIET_TURNS } from "../helpers/fakeTimerStepping";
import { asPlanAllocation } from "../helpers/planLabelAllocation";

// #11602: a lookup made to judge ownership releases nothing. A label's base that is past its idle
// deadline, and that the scan has not reached yet, used to be released by the lookup itself:
// resolving the label to its base read the base's label map through `getSession`, whose lazy
// expiry is for a call that names the session, not for a judgement about another one.

const BASE = "sess-a";
const LABEL = `${BASE}:B`;
const BASE_IDLE_MS = 1_000;
const LABEL_IDLE_MS = 600_000;
const TOKEN = "claimant-token";

interface World {
  timer: FakeTimer;
  manager: SessionManager;
  base: Session;
  released: string[];
}

/** The base past its idle deadline and not yet scanned; its label well inside its own. */
async function expiredUnscannedBase(): Promise<World> {
  const timer = new FakeTimer();
  const manager = new SessionManager(
    timer,
    new FakeDeviceSessionPersistence(),
    () => new FakeDbWriteBarrier(),
  );
  manager.stopCleanupTimer();
  const released: string[] = [];
  manager.onSessionRelease((sessionId) => {
    released.push(sessionId);
  });
  const base = await manager.createSession(BASE, "emulator-5554", "android", BASE_IDLE_MS);
  await asPlanAllocation(manager, BASE, [LABEL], () =>
    manager.createSession(LABEL, "emulator-5556", "android", LABEL_IDLE_MS),
  );
  manager.setDeviceLabels(BASE, buildDeviceLabelMap(["A", "B"], BASE));
  timer.advanceTime(BASE_IDLE_MS + 1);
  return { timer, manager, base, released };
}

/** Everything a lookup could have stamped on the base. */
const stamps = (session: Session) => ({
  lastUsedAt: session.lastUsedAt,
  lastHeartbeat: session.lastHeartbeat,
  lastOwnerHeartbeat: session.lastOwnerHeartbeat,
  expiresAt: session.expiresAt,
  activityGeneration: session.activityGeneration,
  livenessOwnerToken: session.livenessOwnerToken,
});

async function expectBaseUntouched(w: World, before: ReturnType<typeof stamps>): Promise<void> {
  await drainMicrotasks(FAKE_TIMER_QUIET_TURNS);
  expect(w.released).toEqual([]);
  expect(w.manager.hasSession(BASE)).toBe(true);
  expect(w.manager.getReleasingSession(BASE)).toBeNull();
  expect(stamps(w.base)).toEqual(before);
}

describe("judging ownership of a label whose base has expired but is not yet scanned", () => {
  const judgements: Record<string, (w: World) => unknown> = {
    "a liveness claim on the label": (w) => w.manager.claimLivenessOwnership(LABEL, TOKEN),
    "a heartbeat adopting the label's unowned liveness": (w) =>
      w.manager.claimUnownedLivenessOwnership(LABEL, TOKEN),
    "the hold a refused claim reports": (w) => w.manager.getOwnerLeaseHold(LABEL),
    "the session that speaks for the label": (w) => w.manager.ownershipSessionUuid(LABEL),
  };

  test.each(Object.keys(judgements))("%s neither releases nor stamps the base", async (name) => {
    const w = await expiredUnscannedBase();
    const before = stamps(w.base);

    await judgements[name](w);

    await expectBaseUntouched(w, before);
  });

  test("the pool's owner judgement of the label neither releases nor stamps the base", async () => {
    const w = await expiredUnscannedBase();
    const discovery = new FakeDeviceUtils();
    discovery.setBootedDevices("android", []);
    discovery.setBootedDevices("ios", []);
    const pool = new DevicePool(
      createDevicePoolDependencies(w.manager, "ownership-lookup-daemon", {
        timer: w.timer,
        deviceManager: discovery,
      }),
    );
    const before = stamps(w.base);

    pool.isSessionOwnedByOtherConnection(LABEL, "conn-other");

    await expectBaseUntouched(w, before);
  });

  test("the label is judged on its own, as it is once the scan has released the base", async () => {
    const w = await expiredUnscannedBase();

    expect(w.manager.ownershipSessionUuid(LABEL)).toBe(LABEL);
    expect(await w.manager.claimLivenessOwnership(LABEL, TOKEN)).toBe("claimed");
    expect(w.manager.peekSession(BASE)).toBeNull();
    expect(w.manager.peekSession(LABEL)?.sessionId).toBe(LABEL);
  });

  test("a call that names the expired base itself still releases it lazily", async () => {
    const w = await expiredUnscannedBase();

    expect(w.manager.getSession(BASE)).toBeNull();
    await drainMicrotasks(FAKE_TIMER_QUIET_TURNS);

    expect(w.released).toContain(BASE);
  });
});
