import { describe, expect, test } from "bun:test";
import { ObserverSessionRegistry } from "../../../src/daemon/observerSessionRegistry";
import {
  DEFAULT_SESSION_HEARTBEAT_TIMEOUT_MS,
  PROXY_HEARTBEAT_INTERVAL_MS,
  SUSPECT_GRACE_MS,
} from "../../../src/daemon/sessionLivenessWindows";
import { SessionManager } from "../../../src/daemon/sessionManager";
import { FakeDeviceSessionPersistence } from "../../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../../fakes/FakeTimer";

// Hunt 2026-10-10 (heartbeat lease, daemon side). Device-session leases moved to the steady
// session clock in #11080, so an NTP correction or a manual clock change "neither extends nor
// shortens them" (docs/using/environment-variables.md). The observer registry gives an observer
// "the same no-heartbeat budget as a session owner" (lease + grace), but stamps and judges that
// budget with `timer.now()`, the raw wall clock. A wall-clock step therefore moves every
// observer's lease while the device sessions beside it are untouched:
//
//   - a forward step of more than the budget expires a heartbeating observer at once
//     (`onObserverGone` ends its viewer streams and drops its appearance config);
//   - a backward step keeps a dead observer registered, and its streams admitted, for the length
//     of the step: its expiry sweep re-arms that far into the future.

const OBSERVER = "hunt-observer";
const BUDGET_MS = DEFAULT_SESSION_HEARTBEAT_TIMEOUT_MS + SUSPECT_GRACE_MS;

function harness() {
  const timer = new FakeTimer();
  const gone: string[] = [];
  const registry = new ObserverSessionRegistry(timer, BUDGET_MS, (sessionId) => {
    gone.push(sessionId);
  });
  expect(registry.register(OBSERVER, "desktop")).toMatchObject({ accepted: true });
  return { timer, gone, registry };
}

describe("observer heartbeat budget across a wall-clock step", () => {
  test("control: a device session's owner lease ignores the same forward step", async () => {
    const timer = new FakeTimer();
    timer.simulateSleepCountingMonotonicClock();
    const manager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    manager.stopCleanupTimer();
    await manager.createSession("device-session", "emulator-5554", "android");
    manager.recordHeartbeat("device-session");

    timer.stepWallClock(BUDGET_MS + 1_000);

    expect(manager.getSessionLeaseState("device-session")?.phase).toBe("live");
  });

  test("a forward step does not expire an observer that heartbeated 2 s ago", () => {
    const { timer, gone, registry } = harness();
    timer.simulateSleepCountingMonotonicClock();
    timer.advanceTime(PROXY_HEARTBEAT_INTERVAL_MS);
    expect(registry.heartbeat(OBSERVER)).toBe(true);

    // An NTP correction: only the wall clock moves; no time passed for the observer.
    timer.stepWallClock(BUDGET_MS + 1_000);
    timer.advanceTime(PROXY_HEARTBEAT_INTERVAL_MS);

    expect({ acknowledged: registry.heartbeat(OBSERVER), gone }).toEqual({
      acknowledged: true,
      gone: [],
    });
  });

  test("a backward step does not keep a dead observer past its no-heartbeat budget", () => {
    const { timer, gone, registry } = harness();

    // The observer's client dies right after registering; the wall clock is stepped back a minute.
    timer.stepWallClock(-60_000);
    timer.advanceTime(BUDGET_MS + PROXY_HEARTBEAT_INTERVAL_MS);

    expect({ gone, listed: registry.list().map((session) => session.sessionId) }).toEqual({
      gone: [OBSERVER],
      listed: [],
    });
  });
});
