import { afterEach, describe, expect, test } from "bun:test";
import { ForeignClaims } from "../../../src/daemon/foreignClaims";
import { StoreDeviceClaimMirror } from "../../../src/daemon/deviceClaims";
import { ForwardLeaseForeignDeviceOwnership } from "../../../src/daemon/foreignDeviceOwnership";
import { registerDefaultForeignAndroidSerialSource } from "../../../src/devices/foreignAndroidSerialResolver";
import { DeviceOwnedByOtherDaemonError } from "../../../src/models/DeviceOwnedByOtherDaemonError";
import { AndroidEmulatorClient } from "../../../src/utils/android-cmdline-tools/AndroidEmulatorClient";
import { setDeviceAdmissionGate } from "../../../src/utils/deviceAdmissionGate";
import { createExecResult } from "../../../src/utils/execResult";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeAvdConfigReader } from "../../fakes/FakeAvdConfigReader";
import { FakeDeviceClaims } from "../../fakes/FakeDeviceClaims";
import { FakeChildProcess } from "../../fakes/FakeChildProcess";
import { FakeRunningAvdAdvertisementReader } from "../../fakes/FakeRunningAvdAdvertisementReader";
import { FakeTimer } from "../../fakes/FakeTimer";
import { drainMicrotasks } from "../../helpers/fakeTimerStepping";

const SERIAL = "emulator-5554";
const AVD = "Pixel";
const PEER_PID = 4242;
let unregister: (() => void) | undefined;

afterEach(() => {
  unregister?.();
  unregister = undefined;
  setDeviceAdmissionGate(undefined);
});

async function harness() {
  const timer = new FakeTimer();
  timer.setCurrentTime(60_001);
  const startedAt = timer.now();
  const store = new FakeDeviceClaims();
  let alive = true;
  let held = true;
  const ownership = new ForwardLeaseForeignDeviceOwnership(
    100,
    {
      leasePath: () => undefined,
      claimPath: (id) => `/claims/${id}`,
      legacyClaimPath: () => undefined,
      read: () => undefined,
      isProcessRunning: () => alive,
      tryAcquire: () => {
        throw new Error("read-only ownership test");
      },
      takeOver: () => {
        throw new Error("read-only ownership test");
      },
      release: () => {
        throw new Error("read-only ownership test");
      },
    },
    {
      query: async () => ({
        kind: "status",
        status: {
          pid: PEER_PID,
          deviceId: SERIAL,
          sessionId: held ? "peer-session" : null,
          activeExecutions: 0,
          idleForMs: null,
        },
      }),
    },
    { timer, ownerSocketPath: () => undefined },
  );
  ownership.attachClaimMirror(
    new StoreDeviceClaimMirror({
      platform: "android",
      store: () => store,
      timer,
      generationOf: () => undefined,
      generationVerdict: () => "same",
    }),
  );
  const publishClaim = () =>
    store.upsert({
      platform: "android",
      deviceId: SERIAL,
      kind: "allocation",
      pid: PEER_PID,
      ownerToken: "peer",
      claimedAtMs: 1,
      updatedAtMs: 1,
      metadata: JSON.stringify({ socketPath: "/peer.sock", acquiredAt: 1 }),
    });
  const claims = new ForeignClaims({
    foreignDeviceOwnership: ownership,
    iosForeignDeviceOwnership: undefined,
    timer,
    getDevice: () => undefined,
    getDevicesByPlatform: () => [],
  });
  // The same pool gate the deviceId route invokes, published as daemon initialization does.
  setDeviceAdmissionGate({
    assertDeviceActionable: () => {},
    assertNotClaimedByForeignDaemon: (...args) => claims.assertNotClaimedByForeignDaemon(...args),
  });
  unregister = registerDefaultForeignAndroidSerialSource(claims);
  const adb = new FakeAdbExecutor();
  adb.setDevices([{ deviceId: SERIAL, name: SERIAL, platform: "android" }]);
  for (const [command, stdout] of Object.entries({
    "emu avd name": `${AVD}\nOK`,
    "get-state": "device",
    "shell pm list packages": "package:android",
    "shell getprop sys.boot_completed": "1",
    "shell getprop init.svc.bootanim": "stopped",
  })) {
    adb.setCommandResponse(command, createExecResult(stdout, ""));
  }
  const advertisements = new FakeRunningAvdAdvertisementReader();
  advertisements.advertised.add(AVD);
  const client = new AndroidEmulatorClient({
    timer,
    adbFactory: new FakeAdbClientFactory(adb),
    avdConfigReader: new FakeAvdConfigReader(),
    runningAvdAdvertisementReader: advertisements,
    emulatorPathLocator: async () => "/fake/emulator",
    execAsync: async () => createExecResult(AVD, ""),
    spawnFn: () => {
      throw new Error("must adopt the running emulator");
    },
  });
  return {
    timer,
    startedAt,
    client,
    adb,
    claims,
    publishClaim,
    markDead: () => {
      alive = false;
    },
    markStale: () => {
      held = false;
    },
    wait: (child: FakeChildProcess | null = null) =>
      client.waitForEmulatorReady(AVD, 180_000, child, {
        options: { skipWakeAndUnlock: true },
      }),
  };
}

describe("AVD-name acquisition across daemons", () => {
  test("a running claimed AVD refuses before launch or readiness waiting", async () => {
    const h = await harness();
    await h.publishClaim();
    await expect(h.client.launchEmulator({ avdName: AVD })).rejects.toMatchObject({
      code: "device_owned_by_other_daemon",
      retryAfterMs: 2_000,
      deviceId: SERIAL,
      ownerPid: PEER_PID,
    });
    expect(h.timer.now()).toBe(h.startedAt);
    expect(h.adb.getExecutedCommands()).not.toContain("get-state");
    expect(h.timer.getPendingTimeoutCount()).toBe(0);
  });

  test("readiness refuses a resolved foreign AVD without advancing the clock", async () => {
    const h = await harness();
    await h.publishClaim();
    let settled = false;
    const pending = h
      .wait()
      .catch((error: unknown) => error)
      .finally(() => {
        settled = true;
      });
    await drainMicrotasks(500);
    // Bound the broken implementation so the regression fails instead of hanging the test.
    const promptlyRefused = settled;
    if (!settled) {
      h.timer.advanceTime(180_000);
    }
    const failure = await pending;
    expect(failure).toBeInstanceOf(DeviceOwnedByOtherDaemonError);
    expect(failure).toMatchObject({ code: "device_owned_by_other_daemon", retryAfterMs: 2_000 });
    expect(promptlyRefused).toBe(true);
    expect(h.timer.now()).toBe(h.startedAt);
    expect(h.adb.getExecutedCommands()).not.toContain("get-state");
    expect(h.timer.getPendingTimeoutCount()).toBe(0);
  });

  test.each([false, true])(
    "an unclaimed starting AVD waits until boot completes (own process=%s)",
    async (ownProcess) => {
      const h = await harness();
      h.adb.setCommandResponse("shell getprop sys.boot_completed", createExecResult("0", ""));
      expect((await h.client.launchEmulator({ avdName: AVD })).process).toBeNull();
      let settled = false;
      const child = ownProcess ? new FakeChildProcess(h.timer) : null;
      const pending = h.wait(child).finally(() => {
        settled = true;
      });
      await drainMicrotasks(500);
      expect(settled).toBe(false);
      h.adb.setCommandResponse("shell getprop sys.boot_completed", createExecResult("1", ""));
      h.timer.advanceTime(500);
      await drainMicrotasks(500);
      expect(await pending).toMatchObject({ deviceId: SERIAL, name: AVD });
      expect(h.timer.now() - h.startedAt).toBe(500);
      expect(h.timer.getPendingTimeoutCount()).toBe(0);
      if (child) {
        expect(child.killed).toBe(false);
        expect(child.listenerCount("exit")).toBe(0);
      }
    },
  );

  test.each([false, true])(
    "a claim appearing mid-wait refuses (identity initially unresolved=%s)",
    async (unresolved) => {
      const h = await harness();
      h.adb.setCommandResponse("shell getprop sys.boot_completed", createExecResult("0", ""));
      if (unresolved) {
        h.adb.setCommandResponse("emu avd name", createExecResult("", ""));
      }
      expect((await h.client.launchEmulator({ avdName: AVD })).process).toBeNull();
      let settled = false;
      const pending = h
        .wait()
        .catch((error: unknown) => error)
        .finally(() => {
          settled = true;
        });
      await drainMicrotasks(500);
      expect(settled).toBe(false);
      await h.publishClaim();
      if (unresolved) {
        h.timer.advanceTime(500);
        await drainMicrotasks(500);
        expect(settled).toBe(false);
      }
      h.adb.setCommandResponse("emu avd name", createExecResult(`${AVD}\nOK`, ""));
      h.timer.advanceTime(500);
      await drainMicrotasks(500);
      const refusedAt = h.timer.now();
      const promptlyRefused = settled;
      if (!settled) {
        h.timer.advanceTime(180_000);
      }
      expect(await pending).toMatchObject({
        code: "device_owned_by_other_daemon",
        retryAfterMs: 2_000,
      });
      expect(promptlyRefused).toBe(true);
      expect(refusedAt - h.startedAt).toBe(unresolved ? 1_000 : 500);
      expect(h.timer.getPendingTimeoutCount()).toBe(0);
    },
  );

  test.each(["stale", "dead"])(
    "a %s holder follows the deviceId claim decision",
    async (holder) => {
      const h = await harness();
      await h.publishClaim();
      // Keep a positive inventory snapshot: explicit acquisition must refresh the claim,
      // rather than treating the cached foreignOwned flag as a new ownership authority.
      expect((await h.client.getBootedDevicesChecked(false))[0]?.foreignOwned).toBe(true);
      if (holder === "dead") {
        h.markDead();
      } else {
        h.markStale();
      }
      await h.claims.assertNotClaimedByForeignDaemon(SERIAL, "android");
      expect((await h.client.launchEmulator({ avdName: AVD })).process).toBeNull();
      const pending = h.wait();
      await drainMicrotasks(500);
      expect(await pending).toMatchObject({ deviceId: SERIAL, name: AVD });
      expect(h.timer.now()).toBe(h.startedAt);
    },
  );
});
