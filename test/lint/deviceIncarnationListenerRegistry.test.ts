import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import type { DaemonState } from "../../src/daemon/daemonState";
import type { SessionManager } from "../../src/daemon/sessionManager";
import type { DevicePool } from "../../src/daemon/devicePool";

// Explicit ownership inventory: module initialization must install each live listener.
const moduleInitOwners: Readonly<Record<string, string>> = {
  "src/features/observe/android/AndroidCtrlProxyClient.ts": "ctrlproxy-client",
  "src/ctrlProxy/CtrlProxyManager.ts": "ctrlproxy-manager",
  "src/features/action/TerminateApp.ts": "observe-window-cache",
  "src/server/appResources.ts": "installed-apps",
  "src/server/videoRecordingIncarnationListener.ts": "recordings",
  "src/features/performance/PerformanceMonitor.ts": "performance-monitoring",
  "src/features/performance/RecompositionTracker.ts": "recomposition-tracker",
};

let getListeners: typeof import("../../src/utils/deviceIncarnation").getDeviceIncarnationListeners;
let invalidatorModule: typeof import("../../src/server/DeviceIncarnationInvalidator");
let trackerModule: typeof import("../../src/features/performance/RecompositionTracker");
let state: DaemonState;
let manager: SessionManager;
let pool: DevicePool;

beforeAll(async () => {
  invalidatorModule = await import("../../src/server/DeviceIncarnationInvalidator");
  getListeners = (await import("../../src/utils/deviceIncarnation")).getDeviceIncarnationListeners;
  trackerModule = await import("../../src/features/performance/RecompositionTracker");
  const { DaemonState } = await import("../../src/daemon/daemonState");
  const { SessionManager } = await import("../../src/daemon/sessionManager");
  const { DevicePool } = await import("../../src/daemon/devicePool");
  const { FakeTimer } = await import("../fakes/FakeTimer");
  const { FakeDeviceSessionPersistence } = await import("../fakes/FakeDeviceSessionPersistence");
  const { FakeDeviceUtils } = await import("../fakes/FakeDeviceUtils");
  const { FakeInstalledAppsRepository } = await import("../fakes/FakeInstalledAppsRepository");
  const { createDevicePoolDependencies } = await import("../helpers/devicePoolDependencies");
  const timer = new FakeTimer();
  manager = new SessionManager(timer, new FakeDeviceSessionPersistence());
  pool = new DevicePool(
    createDevicePoolDependencies(manager, "registry-test", {
      timer,
      deviceManager: new FakeDeviceUtils(),
      installedAppsRepository: new FakeInstalledAppsRepository(),
    }),
  );
  state = DaemonState.getInstance();
});

afterAll(() => {
  state?.reset();
});

describe("VM restore incarnation listener registry", () => {
  test.each(Object.entries(moduleInitOwners))(
    "registers the live owner %s as %s",
    (_module, name) => {
      expect(getListeners().map((listener) => listener.name)).toContain(name);
    },
  );

  test.each(["recordings", "installed-apps"])("registers the settled hook for %s", (name) => {
    expect(
      getListeners().find((listener) => listener.name === name)?.onIncarnationChangeSettled,
    ).toBeFunction();
  });

  test("has unique live listener names", () => {
    const names = getListeners().map((listener) => listener.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test("registers session readiness during initialization and unregisters it on reset", () => {
    try {
      state.initialize(manager, pool);
      const names = getListeners().map((listener) => listener.name);
      expect(names).toContain("session-readiness");
      expect(new Set(names).size).toBe(names.length);
    } finally {
      state.reset();
    }
    expect(getListeners().map((listener) => listener.name)).not.toContain("session-readiness");
    expect(state.isInitialized()).toBe(false);
  });

  test("invokes the registered recomposition tracker through the invalidation funnel", async () => {
    const tracker = trackerModule.RecompositionTracker.getInstance();
    const reset = spyOn(tracker, "resetDeviceState");
    try {
      const listener = getListeners().find((entry) => entry.name === "recomposition-tracker");
      expect(listener).toBeDefined();
      await new invalidatorModule.DefaultDeviceIncarnationInvalidator(
        listener ? [listener] : [],
      ).invalidate({
        deviceId: "registry-device",
        name: "Registry",
        platform: "android",
      });
      expect(reset).toHaveBeenCalledWith("registry-device");
    } finally {
      reset.mockRestore();
      state.reset();
    }
  });
});
