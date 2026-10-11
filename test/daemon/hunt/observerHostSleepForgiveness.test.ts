import { describe, expect, test } from "bun:test";
import { ObserverSessionRegistry } from "../../../src/daemon/observerSessionRegistry";
import {
  DEFAULT_SESSION_HEARTBEAT_TIMEOUT_MS,
  PROXY_HEARTBEAT_INTERVAL_MS,
  SUSPECT_GRACE_MS,
} from "../../../src/daemon/sessionLivenessWindows";
import { SessionHeartbeatMonitor } from "../../../src/daemon/SessionHeartbeatMonitor";
import { SessionManager } from "../../../src/daemon/sessionManager";
import { FakeDeviceSessionPersistence } from "../../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../../fakes/FakeTimer";

// Owner contract: "observers get the same no-heartbeat budget as a session owner (lease 4 s +
// grace 4 s + scan 2 s) with the same stall/sleep forgiveness". The heartbeat monitor forgives
// host sleep and daemon event-loop stalls for session leases (#10699, #11080): nothing on a
// sleeping host can heartbeat, so the owner is not held to the lost interval. The observer
// registry has no such path: it judges expiry on the steady clock alone, and on darwin that clock
// counts a forward wall lead (sleep) as elapsed time. A desktop that watched a device, then lid-
// closed for 30 s, finds its registration (and so its viewer streams) gone on wake, while the
// agent session beside it is intact.

const BUDGET_MS = DEFAULT_SESSION_HEARTBEAT_TIMEOUT_MS + SUSPECT_GRACE_MS;
const SLEEP_MS = BUDGET_MS * 4;

describe("observer lease across host sleep", () => {
  test("control: a device session's owner lease survives the same host sleep", async () => {
    const timer = new FakeTimer();
    timer.setCurrentTime(1_000_000);
    const manager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const monitor = new SessionHeartbeatMonitor(
      manager,
      () => false,
      async (sessionId, reason) => {
        await manager.releaseSession(sessionId, reason);
      },
      timer,
    );
    await manager.createSession("sleeper", "emulator-5554", "android");
    manager.recordHeartbeat("sleeper");
    monitor.start();
    timer.advanceTime(PROXY_HEARTBEAT_INTERVAL_MS);
    manager.recordHeartbeat("sleeper");

    timer.simulateHostSleep(SLEEP_MS);
    await monitor.tick();

    expect(manager.getSessionLeaseState("sleeper")?.phase).toBe("live");
    await monitor.stop();
    manager.stopCleanupTimer();
  });

  test("an observer that heartbeated 2 s before the host slept is still registered on wake", () => {
    const timer = new FakeTimer();
    timer.setCurrentTime(1_000_000);
    const gone: string[] = [];
    const registry = new ObserverSessionRegistry(timer, BUDGET_MS, (id) => gone.push(id));
    registry.register("desktop-observer", "desktop");
    timer.advanceTime(PROXY_HEARTBEAT_INTERVAL_MS);
    expect(registry.heartbeat("desktop-observer")).toBe(true);

    timer.simulateHostSleep(SLEEP_MS);
    // First instants after wake: the client's next heartbeat would arrive now.
    timer.advanceTime(1);

    expect({ gone, heartbeatAfterWake: registry.heartbeat("desktop-observer") }).toEqual({
      gone: [],
      heartbeatAfterWake: true,
    });
    registry.dispose();
  });
});
