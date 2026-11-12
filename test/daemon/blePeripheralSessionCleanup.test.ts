import { describe, expect, test } from "bun:test";
import { registerBlePeripheralSessionCleanup } from "../../src/daemon/blePeripheralSessionCleanup";
import { cleanupDaemonChildProcesses } from "../../src/daemon/childProcessCleanup";
import { FakeBleSessionHooks } from "../fakes/FakeBleSessionHooks";
import { FakeTimer } from "../fakes/FakeTimer";
import { blePeripheralFixture, bleStartArgs } from "../helpers/blePeripheralFixture";

describe("BLE peripheral lifecycle wiring", () => {
  test.each(["release", "unbound", "identity-replaced"])(
    "%s kills every session-owned sidecar",
    async (reason) => {
      const f = blePeripheralFixture();
      await f.manager.run("s1", bleStartArgs());
      const hooks = new FakeBleSessionHooks();
      registerBlePeripheralSessionCleanup(hooks, f.manager);
      if (reason === "unbound") {
        hooks.unbound?.("s1", "emulator-5554");
      } else {
        hooks.releaseOwner("s1", { deviceIdentityReplaced: reason === "identity-replaced" });
      }
      await Promise.all(hooks.pending.map((p) => p.cleanup));
      expect(hooks.pending[0].deviceId).toBe("emulator-5554");
      expect(f.sidecars.created[0].stops).toBe(1);
      expect(f.sidecars.created[0].snapshot.running).toBe(false);
      if (reason === "unbound") {
        const restarted = await f.manager.run("s1", {
          ...bleStartArgs(),
          deviceId: "emulator-5556",
        });
        expect(restarted.running).toBe(true);
        await f.manager.shutdown();
      }
    },
  );

  test("an upgrade-only notice leaves the live owner unchanged", async () => {
    const f = blePeripheralFixture();
    await f.manager.run("s1", bleStartArgs());
    const hooks = new FakeBleSessionHooks();
    registerBlePeripheralSessionCleanup(hooks, f.manager);
    hooks.releaseOwner("s1", { upgradeOnly: true });
    expect(hooks.pending).toEqual([]);
    expect(f.sidecars.created[0].snapshot.running).toBe(true);
    await f.manager.shutdown();
  });

  test("daemon child cleanup shuts down BLE and fences subsequent starts", async () => {
    const f = blePeripheralFixture();
    const timer = new FakeTimer();
    await f.manager.run("s1", bleStartArgs());
    await cleanupDaemonChildProcesses({
      stopBlePeripherals: () => f.manager.shutdown(),
      stopWatchRunners: () => undefined,
      stopAcceptingVideoRecordingStarts: async () => undefined,
      listActiveVideoRecordings: async () => [],
      listOwnedActiveVideoRecordingIds: () => [],
      stopVideoRecording: async () => undefined,
      forceStopVideoRecording: async () => undefined,
      interruptVideoRecording: async () => undefined,
      shutdownIOSCtrlProxies: async () => undefined,
      timer,
    });
    expect(f.sidecars.created[0].stops).toBe(1);
    await expect(f.manager.run("s2", bleStartArgs())).rejects.toThrow(/shutting down/);
    expect(timer.getSleepCallCount()).toBe(0);
  });
});
