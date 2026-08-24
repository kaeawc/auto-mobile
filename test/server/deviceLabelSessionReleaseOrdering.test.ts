import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Daemon } from "../../src/daemon/daemon";
import { DaemonState } from "../../src/daemon/daemonState";
import { DeviceSessionRepository } from "../../src/db/deviceSessionRepository";
import { createTestDatabase } from "../db/testDbHelper";
import { releaseDeviceLabelSessions } from "../../src/server/deviceLabelMapping";

// #4984: releasing a derived device-label session must await the session release
// (so its central onSessionRelease cleanup — CtrlProxy binding + build context —
// completes) BEFORE the device is returned to the pool, mirroring the base-session
// path. Otherwise nav/hierarchy broadcasts during the release's async tail are
// recorded under the ended session's uuid.

describe("releaseDeviceLabelSessions ordering", () => {
  afterEach(() => {
    if (DaemonState.getInstance().isInitialized()) {
      DaemonState.getInstance().reset();
    }
  });

  test("awaits the derived session release before freeing its device", async () => {
    const db = await createTestDatabase();
    // Constructing the Daemon initializes the global DaemonState; read the exact
    // collaborators releaseDeviceLabelSessions resolves through DaemonState.getInstance().
    new Daemon({}, undefined, undefined, new DeviceSessionRepository(db));
    const sessionManager = DaemonState.getInstance().getSessionManager();
    const devicePool = DaemonState.getInstance().getDevicePool();

    const base = "base-sess";
    const derived = `${base}:B`;

    // Model the release's async tail (persistence / central cleanup) so the ordering
    // is observable: releaseDevice must not run until this has fully resolved.
    let releaseSettled = false;
    const releaseSpy = spyOn(sessionManager, "releaseSession").mockImplementation(async () => {
      await new Promise<void>((resolve) => setImmediate(resolve));
      releaseSettled = true;
      return "emulator-5554";
    });
    let releasedFirst: boolean | null = null;
    const deviceSpy = spyOn(devicePool, "releaseDevice").mockImplementation(async () => {
      releasedFirst = releaseSettled;
    });

    try {
      // The base session must exist for its device-label map to persist; the derived
      // session is the one releaseDeviceLabelSessions frees.
      await sessionManager.createSession(base, "emulator-5554", "android");
      await sessionManager.createSession(derived, "emulator-5555", "android");
      sessionManager.setDeviceLabels(base, { A: base, B: derived });

      const released = await releaseDeviceLabelSessions(base);

      expect(released).toEqual([derived]);
      expect(releaseSpy).toHaveBeenCalledWith(derived);
      // The device was freed only AFTER the session release fully settled.
      expect(releasedFirst).toBe(true);
    } finally {
      releaseSpy.mockRestore();
      deviceSpy.mockRestore();
      sessionManager.stopCleanupTimer();
    }
  });
});
