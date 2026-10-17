import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  SessionManager,
  TerminalSessionError,
  type Session,
} from "../../src/daemon/sessionManager";
import {
  DEFAULT_SESSION_HEARTBEAT_TIMEOUT_MS,
  SUSPECT_GRACE_MS,
} from "../../src/daemon/sessionLivenessWindows";
import { buildDeviceLabelMap } from "../../src/server/deviceLabelMapping";
import { SessionScopedStreamAuthenticator } from "../../src/daemon/streamSocketAuth";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../fakes/FakeTimer";
import { drainMicrotasks, FAKE_TIMER_QUIET_TURNS } from "../helpers/fakeTimerStepping";
import { asPlanAllocation } from "../helpers/planLabelAllocation";
import { snapshotPlatformDeviceManagerFactory } from "../helpers/platformDeviceManagerSnapshot";

let restoreFactory: (() => void) | undefined;
beforeEach(() => {
  restoreFactory = snapshotPlatformDeviceManagerFactory();
});
afterEach(() => {
  restoreFactory?.();
  restoreFactory = undefined;
});

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

async function liveBaseAndLabel(baseIdleMs = BASE_IDLE_MS): Promise<World> {
  const timer = new FakeTimer();
  const manager = new SessionManager(timer, new FakeDeviceSessionPersistence(), {
    barrier: () => new FakeDbWriteBarrier(),
  });
  manager.stopCleanupTimer();
  const released: Array<[string, string]> = [];
  manager.onSessionRelease((sessionId, _deviceId, reason) => {
    released.push([sessionId, reason]);
  });
  const base = await manager.createSession(BASE, "emulator-5554", "android", {
    timeoutMs: baseIdleMs,
  });
  const label = await asPlanAllocation(manager, BASE, [LABEL], () =>
    manager.createSession(LABEL, "emulator-5556", "android", { timeoutMs: LABEL_IDLE_MS }),
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
      releaseReason: "cleanup-expired",
      terminal: true,
    });
    // Refused, so not use: the label's idle window is where it was.
    expect(w.label.lastUsedAt).toBe(stampedAt);
  });

  test("the refused control call ends the base through its own lazy expiry", async () => {
    const w = await expiredUnscannedBase();

    await refusal(w.manager.getOrCreateSession(LABEL));
    await drainMicrotasks(FAKE_TIMER_QUIET_TURNS);

    expect(w.released).toEqual([[BASE, "cleanup-expired"]]);
    expect(w.manager.hasSession(BASE)).toBe(false);
  });

  const lookups: Record<string, (w: World) => unknown> = {
    "a peek at the label": (w) => w.manager.peekSession(LABEL),
    "a lookup for a new execution": (w) => w.manager.getSessionForNewExecution(LABEL),
    "a read admitted under the label": (w) =>
      w.manager.admitIssuedSessionForAutomation(LABEL, undefined, { access: "read-only" }),
    "a liveness claim on the label": (w) => w.manager.claimLivenessOwnership(LABEL, TOKEN),
    "a heartbeat adopting the label's unowned liveness": (w) =>
      w.manager.claimUnownedLivenessOwnership(LABEL, TOKEN),
    "CLI policy adoption": (w) => w.manager.adoptCliLivenessPolicy(LABEL),
    "liveness release": (w) => w.manager.releaseLivenessOwnership(LABEL, TOKEN),
    "heartbeat recording": (w) => w.manager.recordHeartbeat(LABEL),
    "heartbeat policy restoration": (w) => w.manager.restoreHeartbeatLivenessPolicy(LABEL),
  };

  test.each(Object.keys(lookups))("%s finds no live session and releases nothing", async (name) => {
    const w = await expiredUnscannedBase();
    const before = { ...w.label };

    const found: unknown = await lookups[name](w);
    await drainMicrotasks(FAKE_TIMER_QUIET_TURNS);

    expect([null, undefined, false, "not-found"]).toContain(found);
    expect(w.released).toEqual([]);
    expect(w.manager.hasSession(BASE)).toBe(true);
    expect(w.manager.hasSession(LABEL)).toBe(true);
    expect(w.label.livenessOwnerToken).toBeUndefined();
    expect(w.label).toEqual(before);
  });

  test("a holder lookup keeps the label visible and releases nothing", async () => {
    const w = await expiredUnscannedBase();
    expect(w.manager.getSession(LABEL)).toBe(w.label);
    await drainMicrotasks(FAKE_TIMER_QUIET_TURNS);
    expect(w.released).toEqual([]);
    expect(w.manager.hasSession(BASE)).toBe(true);
  });

  test("stream ingress sees no live label while its device remains held", async () => {
    const w = await expiredUnscannedBase();
    const auth = new SessionScopedStreamAuthenticator(() => w.manager, "test stream", {});
    const input = { sessionUuid: LABEL, deviceId: w.label.assignedDevice };
    expect(() => auth.authorize(input)).toThrow("is not an active daemon session");
    expect(auth.resolveSubscriptionIdentity(input)).toMatchObject({
      sessionExists: false,
      ownsDevice: false,
      hasDeviceOwner: true,
    });
    await drainMicrotasks(FAKE_TIMER_QUIET_TURNS);
    expect(w.released).toEqual([]);
    expect(w.manager.getSession(LABEL)).toBe(w.label);
  });

  test("liveness release leaves the label's existing owner intact", async () => {
    const w = await liveBaseAndLabel();
    expect(await w.manager.claimLivenessOwnership(LABEL, TOKEN)).toBe("claimed");
    w.timer.advanceTime(BASE_IDLE_MS + 1);
    const before = { ...w.label };
    expect(await w.manager.releaseLivenessOwnership(LABEL, TOKEN)).toBe("not-found");
    expect(w.label).toEqual(before);
    expect(w.label.livenessOwnerToken).toBe(TOKEN);
    expect(w.released).toEqual([]);
  });

  test("non-owner control gets the base's terminal reason and lazily ends the base", async () => {
    const w = await expiredUnscannedBase();
    const before = { ...w.label };
    const error = await refusal(
      w.manager.getOrCreateSession(
        LABEL,
        undefined,
        undefined,
        undefined,
        true,
        "non-owner-control",
      ),
    );
    await drainMicrotasks(FAKE_TIMER_QUIET_TURNS);
    expect(error.sessionUuid).toBe(LABEL);
    expect(error.release.releaseReason).toBe("cleanup-expired");
    expect(w.released).toEqual([[BASE, "cleanup-expired"]]);
    expect(w.label).toEqual(before);
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
    const own = await w.manager.createSession("other:B", "emulator-5558", "android", {
      timeoutMs: LABEL_IDLE_MS,
    });

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

describe("a label whose base lost its owner's heartbeat lease, before the monitor's scan", () => {
  async function lapsedBaseLease(): Promise<World> {
    const w = await liveBaseAndLabel(LABEL_IDLE_MS);
    expect(await w.manager.claimLivenessOwnership(BASE, TOKEN)).toBe("claimed");
    w.manager.recordHeartbeat(BASE);
    w.timer.advanceTime(DEFAULT_SESSION_HEARTBEAT_TIMEOUT_MS + SUSPECT_GRACE_MS + 1);
    expect(w.manager.getSessionLeaseState(BASE)?.phase).toBe("lapsed");
    return w;
  }

  test("a control call naming it ends the base and gets its heartbeat end", async () => {
    const w = await lapsedBaseLease();

    const error = await refusal(w.manager.getOrCreateSession(LABEL));

    expect(error.release).toMatchObject({ sessionId: LABEL, releaseReason: "heartbeat-timeout" });
    expect(w.released).toEqual([[BASE, "heartbeat-timeout"]]);
  });

  test("a read naming it is admitted and releases nothing", async () => {
    const w = await lapsedBaseLease();

    const admitted = await w.manager.admitIssuedSessionForAutomation(LABEL, undefined, {
      access: "read-only",
    });

    expect(admitted).toBe(w.label);
    expect(w.released).toEqual([]);
  });
});
