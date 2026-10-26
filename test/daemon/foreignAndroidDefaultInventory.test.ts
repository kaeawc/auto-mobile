import { afterEach, expect, spyOn, test } from "bun:test";
import { DaemonShutdown } from "../../src/daemon/daemonCore/DaemonShutdown";
import { DaemonState } from "../../src/daemon/daemonState";
import { defaultDaemonContext } from "../../src/daemon/daemonContext";
import { DefaultDeviceClientProvider } from "../../src/daemon/readiness/DefaultDeviceClientProvider";
import { SessionManager } from "../../src/daemon/sessionManager";
import { MultiPlatformDeviceManager } from "../../src/devices/deviceUtils";
import { getDeviceToolsDependencies } from "../../src/features/deviceLifecycle/core/dependencies";
import { resolveTeardownTarget } from "../../src/features/deviceLifecycle/teardown/teardownResolution";
import { probeForeignUnnamedRuntimes } from "../../src/features/deviceLifecycle/teardown/foreignRuntimeProbe";
import { listBootedDevicesForReadWithStatus } from "../../src/server/resourceDeviceResolver";
import { AndroidEmulatorClient } from "../../src/utils/android-cmdline-tools/AndroidEmulatorClient";
import {
  defaultAdbClientFactory,
  unadmittedAdbClientFactory,
  type AdbClientFactory,
} from "../../src/utils/android-cmdline-tools/AdbClientFactory";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import { createExecResult } from "../../src/utils/execResult";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../fakes/FakeTimer";
import { makePool } from "../helpers/makePool";
import { drainMicrotasks } from "../helpers/fakeTimerStepping";
import { createPooledDevice, DaemonDisconnectHarness } from "./helpers/DaemonDisconnectHarness";

// Retire the registered pool and its admission/incarnation hooks after every test.
afterEach(() => DaemonState.getInstance().reset());

const foreign = { deviceId: "emulator-5610", name: "foreign", platform: "android" as const };
const free = { deviceId: "emulator-5554", name: "free", platform: "android" as const };

function harness() {
  const timer = new FakeTimer();
  const sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
  const listing = new FakeAdbExecutor();
  listing.setDevices([foreign, free]);
  const foreignAdb = new FakeAdbExecutor();
  const freeAdb = new FakeAdbExecutor();
  // An unresolved foreign console must never be dispatched to, even on repeated polls.
  foreignAdb.setCommandResponse("emu avd name", createExecResult("", ""));
  freeAdb.setCommandResponse("emu avd name", createExecResult("free\nOK", ""));
  const factory: AdbClientFactory = {
    create: (device) =>
      !device ? listing : device.deviceId === foreign.deviceId ? foreignAdb : freeAdb,
  };
  const defaultFactory = spyOn(defaultAdbClientFactory, "create").mockImplementation(
    factory.create,
  );
  const identityFactory = spyOn(unadmittedAdbClientFactory, "create").mockImplementation(
    factory.create,
  );
  const client = new AndroidEmulatorClient({ timer, adbFactory: factory });
  const manager = new MultiPlatformDeviceManager(listing, null, client);
  // Construct the singleton before publishing daemon state: the fallback must be lazy.
  const singleton = PlatformDeviceManagerFactory.getInstance();
  const claimReads: number[] = [];
  let held = true;
  const pool = makePool(sessions, "broker", {
    timer,
    deviceManager: new MultiPlatformDeviceManager(
      listing,
      null,
      new AndroidEmulatorClient({ timer, adbFactory: factory }),
    ),
    foreignDeviceOwnership: {
      claim: async () => true,
      release: () => {},
      refresh: async (serials) => {
        if (serials.includes(foreign.deviceId)) {
          claimReads.push(timer.now());
        }
      },
      // Positive live-owner evidence at the ownership port; no real PID or filesystem access.
      foreignOwnerPid: (serial) => (held && serial === foreign.deviceId ? 42 : undefined),
    },
  });
  const daemon = new DaemonDisconnectHarness(timer);
  DaemonState.getInstance().initialize(sessions, pool);
  const monitorPool = daemon.getDevicePool();
  const pooled = createPooledDevice(free.deviceId, { name: free.name });
  monitorPool.getAllDevices = () => [pooled];
  monitorPool.getDevice = (id) => (id === pooled.id ? pooled : null);
  monitorPool.reconcileDiscoveryObservation = async () => {};
  const provider = new DefaultDeviceClientProvider(
    {
      androidCtrlProxyClient: () => {
        throw new Error("unexpected proxy");
      },
      iosCtrlProxyClient: () => {
        throw new Error("unexpected proxy");
      },
      createWindow: () => {
        throw new Error("unexpected window");
      },
      observeScreenCache: () => {
        throw new Error("unexpected screen cache");
      },
    },
    factory,
  );
  return {
    timer,
    pool,
    client,
    manager,
    singleton,
    provider,
    daemon,
    pooled,
    claimReads,
    foreignAdb,
    freeAdb,
    releaseClaim: () => {
      held = false;
    },
    async dispose() {
      try {
        await daemon.disconnectMonitor?.stop();
      } finally {
        daemon.getSessionManager().stopCleanupTimer();
        sessions.stopCleanupTimer();
        DaemonState.getInstance().reset();
        timer.reset();
        PlatformDeviceManagerFactory.reset();
        defaultFactory.mockRestore();
        identityFactory.mockRestore();
      }
    },
  };
}

test("default daemon clients exclude foreign claims throughout idle and active discovery", async () => {
  const h = harness();
  let monitorReads = 0;
  // Exercise the real periodic monitor, keeping either-platform sweeps independent of host iOS tools.
  try {
    h.daemon.startMonitor(
      {
        getBootedDevicesDetailed: (_platform, options) => {
          monitorReads++;
          return h.manager.getBootedDevicesDetailed("android", options);
        },
        getAndroidOfflineDeviceIds: async () => new Set(),
        getAndroidListedDeviceStates: async () => new Map(),
        recoverAndroidOfflineDevices: async () => {},
      },
      async () => [],
    );
    await h.singleton.getBootedDevicesDetailed("android");
    await h.client.getBootedDevicesChecked(true);
    h.client.withForeignInventoryResolver(undefined);
    await h.client.getBootedDevicesChecked(true);
    await h.provider.getDeviceUtils().getBootedDevicesDetailed("android");
    const resources = await listBootedDevicesForReadWithStatus("android", "foreign-default-test");
    expect(
      resources.devices.find(({ deviceId }) => deviceId === foreign.deviceId)?.foreignOwned,
    ).toBe(true);
    for (let tick = 0; tick < 180; tick++) {
      h.timer.advanceTime(5_000);
      await drainMicrotasks(100);
    }
    expect(monitorReads).toBeGreaterThan(5);
    const idleReads = monitorReads;
    h.pooled.status = "busy";
    for (let tick = 0; tick < 6; tick++) {
      h.timer.advanceTime(5_000);
      await drainMicrotasks(100);
    }
    expect(monitorReads - idleReads).toBe(6);
    expect(h.freeAdb.getExecutedCommands()).toContain("emu avd name");
    expect(h.foreignAdb.getExecutedCommands()).toEqual([]);
    // The same pool-owned backoff remains shared across all of the default clients.
    expect(h.claimReads[0]).toBe(0);
    expect(h.claimReads.filter((at) => at === 0)).toHaveLength(1);
    h.foreignAdb.setCommandResponse("emu avd name", createExecResult("foreign\nOK", ""));
    expect(
      await probeForeignUnnamedRuntimes(
        {
          args: {
            target: { platform: "android", isVirtual: true, stableId: "unrelated" },
            mode: "destroy",
            verifyAbsence: true,
          },
          dependencies: { ...getDeviceToolsDependencies(), timer: h.timer },
          deviceManager: h.manager,
          requestAbortSignal: undefined,
          deadlineDevice: foreign,
          deadlineMs: h.timer.now() + 2_000,
          timeoutMs: 2_000,
          cancelOnRequestAbort: false,
          initialScan: { serials: new Set([foreign.deviceId]), pooledEntries: [] },
          mode: "named",
        },
        [{ ...foreign, name: "Unknown (emulator-5610)", foreignOwned: true }],
      ),
    ).toEqual({ kind: "clear" });
    expect(h.foreignAdb.getExecutedCommands()).toEqual(["emu avd name"]);
    // Ownership is not memoized forever: after claim expiry the same client enriches it again.
    await h.daemon.disconnectMonitor?.stop();
    h.releaseClaim();
    h.timer.advanceTime(8_000);
    expect(
      (await h.client.getBootedDevicesChecked(true)).find(
        ({ deviceId }) => deviceId === foreign.deviceId,
      )?.name,
    ).toBe("foreign");
    expect(
      h.foreignAdb.getExecutedCommands().filter((command) => command === "emu avd name"),
    ).toHaveLength(2);
  } finally {
    await h.dispose();
  }
});

test("a retained default client does not consult the retired daemon pool", async () => {
  const h = harness();
  try {
    await h.client.getBootedDevicesChecked(true);
    expect(h.foreignAdb.getExecutedCommands()).toEqual([]);
  } finally {
    await h.dispose();
  }
  expect(defaultDaemonContext.fullDevicePool()).toBeUndefined();
  const retiredReads = h.claimReads.length;
  const retiredPoolRead = spyOn(h.pool, "foreignSerials");
  h.foreignAdb.setCommandResponse("emu avd name", createExecResult("foreign\nOK", ""));
  expect(
    (await h.client.getBootedDevicesChecked(true)).find(
      ({ deviceId }) => deviceId === foreign.deviceId,
    )?.name,
  ).toBe("foreign");
  expect(h.foreignAdb.getExecutedCommands()).toContain("emu avd name");
  expect(h.claimReads).toHaveLength(retiredReads);
  expect(retiredPoolRead).not.toHaveBeenCalled();
  retiredPoolRead.mockRestore();
});

test.each(["stableId", "stableName"] as const)(
  "real named teardown discovery refuses a foreign runtime matching the target %s",
  async (identity) => {
    const h = harness();
    try {
      h.foreignAdb.setCommandResponse("emu avd name", createExecResult("foreign\nOK", ""));
      const result = await resolveTeardownTarget({
        args: {
          target: {
            platform: "android",
            isVirtual: true,
            stableId: identity === "stableId" ? "foreign" : "other-id",
            stableName: identity === "stableName" ? "foreign" : "other-name",
          },
          mode: "destroy",
          verifyAbsence: true,
        },
        dependencies: { ...getDeviceToolsDependencies(), timer: h.timer },
        deviceManager: h.manager,
        requestAbortSignal: undefined,
        deadlineDevice: foreign,
        deadlineMs: h.timer.now() + 2_000,
        timeoutMs: 2_000,
        cancelOnRequestAbort: false,
        initialScan: { serials: new Set(), pooledEntries: [] },
        mode: "named",
      });
      if (!("response" in result)) {
        throw new Error("expected a foreign ownership refusal");
      }
      const content = result.response.content[0];
      if (content?.type !== "text") {
        throw new Error("expected a text teardown response");
      }
      expect(result.response).toHaveProperty("isError", true);
      expect(content.text).toContain('"code":"target_identity_conflict"');
      expect(content.text).toContain("another AutoMobile daemon owns");
      expect(content.text).toContain("foreign");
      expect(content.text).toContain(foreign.deviceId);
      // Discovery skips the console; the deliberate teardown identity read bypasses that skip.
      expect(h.foreignAdb.getExecutedCommands()).toEqual(["emu avd name"]);
    } finally {
      await h.dispose();
    }
  },
);

test("without a daemon registration default clients enrich every emulator", async () => {
  const h = harness();
  try {
    DaemonState.getInstance().reset();
    await h.client.getBootedDevicesChecked(true);
    expect(h.foreignAdb.getExecutedCommands()).toContain("emu avd name");
    expect(h.freeAdb.getExecutedCommands()).toContain("emu avd name");
    expect(h.claimReads).toEqual([]);
  } finally {
    await h.dispose();
  }
});

test("explicit resolvers take precedence over the daemon registration", async () => {
  const h = harness();
  try {
    h.client.withForeignInventoryResolver(async () => new Set([free.deviceId]));
    await h.client.getBootedDevicesChecked(true);
    expect(h.foreignAdb.getExecutedCommands()).toContain("emu avd name");
    expect(h.freeAdb.getExecutedCommands()).toEqual([]);
    expect(h.claimReads).toEqual([]);
  } finally {
    await h.dispose();
  }
});

test("retiring an older pool cannot unregister its replacement", async () => {
  const h = harness();
  try {
    DaemonState.getInstance().retireForeignAndroidSerialSource(h.daemon.getDevicePool());
    await h.client.getBootedDevicesChecked(true);
    expect(h.foreignAdb.getExecutedCommands()).toEqual([]);
    expect(h.claimReads).toEqual([0]);
  } finally {
    await h.dispose();
  }
});

test("daemon stop retires its registered source even when shutdown fails", async () => {
  const h = harness();
  const pool = h.daemon.getDevicePool();
  const reads = spyOn(pool, "foreignSerials").mockResolvedValue(new Set([foreign.deviceId]));
  const shutdown = spyOn(DaemonShutdown.prototype, "stop").mockRejectedValue(
    new Error("shutdown failed"),
  );
  try {
    DaemonState.getInstance().initialize(h.daemon.getSessionManager(), pool);
    await h.client.getBootedDevicesChecked(true);
    expect(h.foreignAdb.getExecutedCommands()).toEqual([]);
    await expect(h.daemon.stop()).rejects.toThrow("shutdown failed");
    reads.mockClear();
    await h.client.getBootedDevicesChecked(true);
    expect(reads).not.toHaveBeenCalled();
    expect(h.foreignAdb.getExecutedCommands()).toContain("emu avd name");
  } finally {
    shutdown.mockRestore();
    reads.mockRestore();
    await h.dispose();
  }
});
