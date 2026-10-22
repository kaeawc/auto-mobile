import { describe, expect, test } from "bun:test";
import {
  MAX_OBSERVER_SESSIONS,
  type ObserverDeviceOwnershipLookup,
  type ObserverRegistration,
  type ObserverSessionStore,
} from "../../src/daemon/observerSessionRegistry";
import type { FakeTimer } from "../fakes/FakeTimer";

export interface ObserverSessionStoreHandle {
  store: ObserverSessionStore;
  timer: FakeTimer;
  /** The no-heartbeat budget the store was built with. */
  heartbeatTimeoutMs: number;
  dispose?: () => Promise<void> | void;
}

const START_MS = 1_000;

function accepted(result: ReturnType<ObserverSessionStore["register"]>): ObserverRegistration {
  if (!result.accepted) {
    throw new Error(`registration refused: ${result.error}`);
  }
  return result;
}

const ownership = (owners: Record<string, string>): ObserverDeviceOwnershipLookup => ({
  getSessionForDevice: (deviceId) => owners[deviceId] ?? null,
});

/**
 * Shared behavioural contract for {@link ObserverSessionStore} (#11868): the recording fake the
 * daemon request and session tests use and the real ObserverSessionRegistry run the same
 * register/heartbeat/expiry/cap/release scenarios, so a test that passes against the fake cannot
 * rely on an observer that never expires or an unbounded observer count.
 */
export function runObserverSessionStoreContract(
  name: string,
  make: () => Promise<ObserverSessionStoreHandle>,
): void {
  const withStore = async (
    body: (handle: ObserverSessionStoreHandle) => Promise<void> | void,
  ): Promise<void> => {
    const handle = await make();
    try {
      handle.timer.setCurrentTime(START_MS);
      await body(handle);
    } finally {
      handle.store.dispose();
      await handle.dispose?.();
    }
  };

  describe(`ObserverSessionStore contract: ${name}`, () => {
    test("registration reports the budget and lists the observer", () =>
      withStore(({ store, heartbeatTimeoutMs }) => {
        const result = accepted(store.register("obs-1", "desktop"));
        expect(result.heartbeatTimeoutMs).toBe(heartbeatTimeoutMs);
        expect(result.expiresAtMs).toBe(START_MS + heartbeatTimeoutMs);
        expect(store.list()).toEqual([
          {
            sessionId: "obs-1",
            clientName: "desktop",
            lastHeartbeat: START_MS,
            expiresAtMs: START_MS + heartbeatTimeoutMs,
          },
        ]);
      }));

    test("registering the same id again refreshes the lease without a second entry", () =>
      withStore(({ store, timer, heartbeatTimeoutMs }) => {
        store.register("obs-1", "desktop");
        timer.advanceTime(500);
        const again = accepted(store.register("obs-1", "ide"));
        expect(again.expiresAtMs).toBe(START_MS + 500 + heartbeatTimeoutMs);
        expect(store.list()).toEqual([
          {
            sessionId: "obs-1",
            clientName: "ide",
            lastHeartbeat: START_MS + 500,
            expiresAtMs: START_MS + 500 + heartbeatTimeoutMs,
          },
        ]);
      }));

    test("a heartbeat extends the lease and reports whether the observer exists", () =>
      withStore(({ store, timer, heartbeatTimeoutMs }) => {
        store.register("obs-1", "desktop");
        expect(store.heartbeat("unknown")).toBe(false);
        timer.advanceTime(heartbeatTimeoutMs - 1);
        expect(store.heartbeat("obs-1")).toBe(true);
        timer.advanceTime(heartbeatTimeoutMs - 1);
        expect(store.list().map((session) => session.sessionId)).toEqual(["obs-1"]);
        expect(store.list()[0].expiresAtMs).toBe(
          START_MS + heartbeatTimeoutMs - 1 + heartbeatTimeoutMs,
        );
      }));

    test("an observer that stops heartbeating is gone exactly at its expiry", () =>
      withStore(({ store, timer, heartbeatTimeoutMs }) => {
        store.register("obs-1", "desktop");
        timer.advanceTime(heartbeatTimeoutMs - 1);
        expect(store.list()).toHaveLength(1);
        expect(store.resolveObserverScope("obs-1")).toEqual({ kind: "unowned-devices-only" });
        timer.advanceTime(1);
        expect(store.list()).toEqual([]);
        expect(store.resolveObserverScope("obs-1")).toEqual({ kind: "denied" });
        expect(store.heartbeat("obs-1")).toBe(false);
      }));

    test("release removes an observer once, whatever the reason", () =>
      withStore(({ store }) => {
        store.register("obs-1", "desktop");
        store.register("obs-2", "desktop");
        store.register("obs-3", "desktop");
        expect(store.release("obs-1")).toBe(true);
        expect(store.release("obs-1")).toBe(false);
        expect(store.release("obs-2", "promotion")).toBe(true);
        expect(store.release("obs-3", "heartbeat-timeout")).toBe(true);
        expect(store.release("never-registered")).toBe(false);
        expect(store.list()).toEqual([]);
      }));

    test("scope grants only unowned-device reads to registered observers", () =>
      withStore(({ store }) => {
        store.register("obs-1", "desktop");
        expect(store.resolveObserverScope("obs-1")).toEqual({ kind: "unowned-devices-only" });
        expect(store.resolveObserverScope("stranger")).toEqual({ kind: "denied" });
        store.release("obs-1");
        expect(store.resolveObserverScope("obs-1")).toEqual({ kind: "denied" });
      }));

    test("an observer may watch an unowned device but not an owned one", () =>
      withStore(({ store }) => {
        store.register("obs-1", "desktop");
        const owners = ownership({ "held-device": "session-x" });
        expect(store.canObserveDevice("obs-1", "free-device", owners)).toBe(true);
        expect(store.canObserveDevice("obs-1", "held-device", owners)).toBe(false);
        expect(store.canObserveDevice("stranger", "free-device", owners)).toBe(false);
      }));

    test("the observer cap refuses a new id, still accepts a known one, and frees on release", () =>
      withStore(({ store }) => {
        for (let index = 0; index < MAX_OBSERVER_SESSIONS; index++) {
          accepted(store.register(`obs-${index}`, "desktop"));
        }
        const refused = store.register("one-too-many", "desktop");
        expect(refused.accepted).toBe(false);
        expect(store.list()).toHaveLength(MAX_OBSERVER_SESSIONS);
        accepted(store.register("obs-0", "desktop"));
        expect(store.list()).toHaveLength(MAX_OBSERVER_SESSIONS);
        store.release("obs-1");
        accepted(store.register("one-too-many", "desktop"));
      }));

    test("expired observers free their slot toward the cap", () =>
      withStore(({ store, timer, heartbeatTimeoutMs }) => {
        for (let index = 0; index < MAX_OBSERVER_SESSIONS; index++) {
          store.register(`obs-${index}`, "desktop");
        }
        timer.advanceTime(heartbeatTimeoutMs);
        accepted(store.register("fresh", "desktop"));
        expect(store.list().map((session) => session.sessionId)).toEqual(["fresh"]);
      }));

    test("dispose clears every observer and refuses later registration", () =>
      withStore(({ store }) => {
        store.register("obs-1", "desktop");
        store.dispose();
        expect(store.list()).toEqual([]);
        expect(store.resolveObserverScope("obs-1")).toEqual({ kind: "denied" });
        expect(store.register("obs-2", "desktop").accepted).toBe(false);
      }));
  });
}
