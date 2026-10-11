import { describe, expect, test } from "bun:test";
import {
  SessionManager,
  TerminalSessionError,
  type Session,
} from "../../src/daemon/sessionManager";
import { buildDeviceLabelMap } from "../../src/server/deviceLabelMapping";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../fakes/FakeTimer";
import { drainMicrotasks, FAKE_TIMER_QUIET_TURNS } from "../helpers/fakeTimerStepping";
import { asPlanAllocation } from "../helpers/planLabelAllocation";

// #11640, owner decision 2026-10-11: the base's end ends its labels. A plan's derived
// `<base>:<label>` session whose base has ended, or is past its idle deadline and not yet scanned,
// is refused on every way in with the terminal answer the base's own end gives. Judging that is a
// read of state; only a refused control call releases the base, as a call naming the base would.

const BASE = "sess-a";
const LABEL = `${BASE}:B`;
const BASE_IDLE_MS = 1_000;
const LABEL_IDLE_MS = 600_000;
const TOKEN = "claimant-token";

interface World {
  timer: FakeTimer;
  manager: SessionManager;
  base: Session;
  label: Session;
  released: Array<[string, string]>;
}

async function liveBaseAndLabel(): Promise<World> {
  const timer = new FakeTimer();
  const manager = new SessionManager(
    timer,
    new FakeDeviceSessionPersistence(),
    () => new FakeDbWriteBarrier(),
  );
  manager.stopCleanupTimer();
  const released: Array<[string, string]> = [];
  manager.onSessionRelease((sessionId, _deviceId, reason) => {
    released.push([sessionId, reason]);
  });
  const base = await manager.createSession(BASE, "emulator-5554", "android", BASE_IDLE_MS);
  const label = await asPlanAllocation(manager, BASE, [LABEL], () =>
    manager.createSession(LABEL, "emulator-5556", "android", LABEL_IDLE_MS),
  );
  manager.setDeviceLabels(BASE, buildDeviceLabelMap(["A", "B"], BASE));
  return { timer, manager, base, label, released };
}

/** The base past its idle deadline and not yet scanned; its label well inside its own. */
async function expiredUnscannedBase(): Promise<World> {
  const w = await liveBaseAndLabel();
  w.timer.advanceTime(BASE_IDLE_MS + 1);
  return w;
}

const refusal = async (attempt: Promise<unknown>): Promise<TerminalSessionError> => {
  const error: unknown = await attempt.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  if (!(error instanceof TerminalSessionError)) {
    throw new Error(`expected a terminal refusal, got ${String(error)}`);
  }
  return error;
};

describe("a label whose base is past its idle deadline and not yet scanned", () => {
  test("a control call naming it gets the base's terminal end and takes no session", async () => {
    const w = await expiredUnscannedBase();
    const stampedAt = w.label.lastUsedAt;

    const error = await refusal(w.manager.getOrCreateSession(LABEL));

    expect(error.sessionUuid).toBe(LABEL);
    expect(error.release).toMatchObject({
      sessionId: LABEL,
      deviceId: "emulator-5556",
      releaseReason: "lazy-expiry",
      terminal: true,
    });
    // Refused, so not use: the label's idle window is where it was.
    expect(w.label.lastUsedAt).toBe(stampedAt);
  });

  test("the refused control call ends the base through its own lazy expiry", async () => {
    const w = await expiredUnscannedBase();

    await refusal(w.manager.getOrCreateSession(LABEL));
    await drainMicrotasks(FAKE_TIMER_QUIET_TURNS);

    expect(w.released).toEqual([[BASE, "lazy-expiry"]]);
    expect(w.manager.hasSession(BASE)).toBe(false);
  });

  const lookups: Record<string, (w: World) => unknown> = {
    "a lookup of the label": (w) => w.manager.getSession(LABEL),
    "a peek at the label": (w) => w.manager.peekSession(LABEL),
    "a lookup for a new execution": (w) => w.manager.getSessionForNewExecution(LABEL),
    "a read admitted under the label": (w) =>
      w.manager.admitIssuedSessionForAutomation(LABEL, undefined, { access: "read-only" }),
    "a liveness claim on the label": (w) => w.manager.claimLivenessOwnership(LABEL, TOKEN),
    "a heartbeat adopting the label's unowned liveness": (w) =>
      w.manager.claimUnownedLivenessOwnership(LABEL, TOKEN),
  };

  test.each(Object.keys(lookups))("%s finds no live session and releases nothing", async (name) => {
    const w = await expiredUnscannedBase();

    const found: unknown = await lookups[name](w);
    await drainMicrotasks(FAKE_TIMER_QUIET_TURNS);

    expect([null, undefined, false, "not-found"]).toContain(found);
    expect(w.released).toEqual([]);
    expect(w.manager.hasSession(BASE)).toBe(true);
    expect(w.manager.hasSession(LABEL)).toBe(true);
    expect(w.label.livenessOwnerToken).toBeUndefined();
  });

  test("a read naming it is answered sessionless, never refused", async () => {
    const w = await expiredUnscannedBase();

    const admitted = await w.manager.admitIssuedSessionForAutomation(LABEL, undefined, {
      access: "read-only",
    });

    expect(admitted).toBeUndefined();
  });

  test("a release of the label still finds it", async () => {
    const w = await expiredUnscannedBase();

    expect(await w.manager.releaseSession(LABEL, "plan-auto-release")).toBe("emulator-5556");

    expect(w.released).toEqual([[LABEL, "plan-auto-release"]]);
  });
});

describe("a label whose base is live", () => {
  test("is admitted, and a session that is no plan's label is never judged by a base", async () => {
    const w = await liveBaseAndLabel();
    const own = await w.manager.createSession("other:B", "emulator-5558", "android", LABEL_IDLE_MS);

    expect(await w.manager.getOrCreateSession(LABEL)).toBe(w.label);
    w.timer.advanceTime(BASE_IDLE_MS + 1);

    expect(await w.manager.getOrCreateSession("other:B")).toBe(own);
  });
});

describe("a label whose base is being released for a terminal reason", () => {
  test("is refused with that reason while the base's release is still in flight", async () => {
    const w = await liveBaseAndLabel();
    const release = w.manager.releaseSession(BASE, "explicit-release");

    expect(w.manager.peekSession(LABEL)).toBeNull();
    const error = await refusal(w.manager.getOrCreateSession(LABEL));
    await release;

    expect(error.release).toMatchObject({ sessionId: LABEL, releaseReason: "explicit-release" });
  });
});
