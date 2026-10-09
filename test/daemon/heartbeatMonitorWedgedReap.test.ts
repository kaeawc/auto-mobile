import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  STUCK_REAP_WARN_MS,
  SessionHeartbeatMonitor,
} from "../../src/daemon/SessionHeartbeatMonitor";
import { SUSPECT_GRACE_MS } from "../../src/daemon/livenessOwnerLease";
import { SessionManager } from "../../src/daemon/sessionManager";
import { DEFAULT_SESSION_HEARTBEAT_CHECK_INTERVAL_MS } from "../../src/daemon/sessionLivenessWindows";
import { logger } from "../../src/utils/logger";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../fakes/FakeTimer";
import { drainMicrotasks } from "../helpers/fakeTimerStepping";

// #10704: one release that never settles must not wedge the heartbeat monitor. Other sessions are
// still released on schedule (including a CLI session, which has no other release path), stall
// forgiveness keeps working, and the stuck release is reported once instead of silently holding.

const SCAN_MS = DEFAULT_SESSION_HEARTBEAT_CHECK_INTERVAL_MS;
const LEASE_MS = 5_000;
const CLI_IDLE_MS = 20_000;

describe("a release that never settles (#10704)", () => {
  let timer: FakeTimer;
  let manager: SessionManager;
  let monitor: SessionHeartbeatMonitor;
  let reaps: { sessionId: string; reason: string; at: number }[];
  const hung = Promise.withResolvers<void>();

  beforeEach(async () => {
    timer = new FakeTimer();
    manager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    reaps = [];
    for (const [id, device] of [
      ["HUNG", "emulator-5554"],
      ["GONE", "emulator-5556"],
      ["LIVE", "emulator-5558"],
      ["CLI", "emulator-5560"],
    ] as const) {
      await manager.createSession(id, device, "android", 600_000, LEASE_MS);
      manager.recordHeartbeat(id);
    }
    expect(manager.adoptCliLivenessPolicy("CLI", CLI_IDLE_MS)).toBe(true);
    monitor = new SessionHeartbeatMonitor(
      manager,
      () => false,
      async (sessionId, reason) => {
        reaps.push({ sessionId, reason, at: timer.now() });
        if (sessionId === "HUNG") {
          // The teardown parks forever.
          await hung.promise;
          return;
        }
        await manager.releaseSession(sessionId, reason);
      },
      timer,
    );
    monitor.start();
  });

  afterEach(async () => {
    hung.resolve();
    await monitor.stop();
    manager.stopCleanupTimer();
  });

  /** Run scheduled scans until `until`, the listed owners heartbeating before each one. */
  async function runUntil(until: number, heartbeating: readonly string[]): Promise<void> {
    while (timer.now() < until) {
      for (const id of heartbeating) {
        if (manager.getSession(id)) {
          manager.recordHeartbeat(id);
        }
      }
      await timer.advanceTimeAsync(SCAN_MS, () => drainMicrotasks(10));
    }
  }

  test("other sessions are released on schedule, forgiveness still works, and the stuck release is reported once", async () => {
    const warn = spyOn(logger, "warn");
    try {
      // HUNG's owner goes silent at once; its release starts and never settles.
      await runUntil(10_000, ["GONE", "LIVE"]);
      expect(reaps.filter((reap) => reap.sessionId === "HUNG")).toHaveLength(1);
      const hungAt = reaps.find((reap) => reap.sessionId === "HUNG")!.at;
      expect(hungAt).toBeLessThanOrEqual(LEASE_MS + SUSPECT_GRACE_MS + SCAN_MS);

      // GONE's owner exits at 10 s: released within lease + grace + one scan anyway.
      await runUntil(CLI_IDLE_MS + 2 * SCAN_MS, ["LIVE"]);
      const gone = reaps.find((reap) => reap.sessionId === "GONE");
      expect(gone?.reason).toBe("heartbeat-timeout");
      expect(gone!.at).toBeLessThanOrEqual(10_000 + LEASE_MS + SUSPECT_GRACE_MS + SCAN_MS);
      // The CLI session, judged only by the monitor, idles out on schedule.
      const cli = reaps.find((reap) => reap.sessionId === "CLI");
      expect(cli?.reason).toBe("cli-idle-timeout");
      expect(cli!.at).toBeLessThanOrEqual(CLI_IDLE_MS + SCAN_MS);

      // Reported once, after the warning threshold, and never released a second time.
      await runUntil(hungAt + STUCK_REAP_WARN_MS + 4 * SCAN_MS, ["LIVE"]);
      const stuck = warn.mock.calls.filter(([message]) =>
        String(message).startsWith("Session HUNG release has not settled"),
      );
      expect(stuck).toHaveLength(1);
      expect(reaps.filter((reap) => reap.sessionId === "HUNG")).toHaveLength(1);

      // A daemon stall far past LIVE's lease is still forgiven: the next scan keeps LIVE although
      // its owner's queued heartbeat has not been delivered yet.
      timer.setCurrentTime(timer.now() + 30_000);
      await timer.advanceTimeAsync(SCAN_MS, () => drainMicrotasks(10));
      expect(reaps.some((reap) => reap.sessionId === "LIVE")).toBe(false);
      expect(manager.getSession("LIVE")?.stallForgivenAt).toBeDefined();
    } finally {
      warn.mockRestore();
    }
  });
});
