import { describe, expect } from "bun:test";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";
import {
  registerDeviceTools,
  resetDeviceToolsDependencies,
  setDeviceToolsDependencies,
} from "../../src/server/deviceTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { DaemonState } from "../../src/daemon/daemonState";
import { DevicePool } from "../../src/daemon/devicePool";
import { DeviceSessionRegistry } from "../../src/daemon/deviceSessionRegistry";
import { SessionManager } from "../../src/daemon/sessionManager";
import { RegistryBindingExclusion } from "../../src/daemon/sessionBroker/provisioning/exclusion";
import { DEVICE_ASSIGNED_TO_BINDING_CODE } from "../../src/daemon/sessionBroker/provisioning/refusal";
import type { DeviceInfo } from "../../src/models";
import { clearDirectSessionDevices } from "../../src/utils/directSessionDeviceRegistry";
import { setDeviceManager } from "../../src/server/bootedDeviceResources";
import { DefaultDeviceMatcher } from "../../src/utils/deviceMatcher";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeBindingRegistry } from "../fakes/FakeBindingRegistry";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeVirtualDeviceLifecycleCoordinator } from "../fakes/FakeVirtualDeviceLifecycleCoordinator";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { assignBindingDevice } from "../daemon/sessionBroker/provisioning/bindingFixtures";
import { warmedTests } from "../helpers/warmedTests";

isolateToolRegistry();

// #11565: a NAME is a selector, not an identity (simulator display names are not unique, and a
// name matches by substring). `startMatchExclusions` hands the boot the broker bindings' devices so
// a selector-based start skips them (#11174); the lifecycle-lease resolution that runs first must
// skip them the same way instead of refusing because its best match is a slot's simulator.

const SLOT_UDID = "AAAAAAAA-1111-4111-8111-AAAAAAAAAAAA";
const FREE_UDID = "BBBBBBBB-2222-4222-8222-BBBBBBBBBBBB";

const simulator = (deviceId: string, osVersion: string): DeviceInfo => ({
  name: "iPhone 16",
  platform: "ios",
  deviceId,
  isRunning: false,
  source: "local",
  osVersion,
  iosVersion: osVersion,
  formFactor: "phone",
});

const avd = (name: string, osVersion: string): DeviceInfo => ({
  name,
  platform: "android",
  isRunning: false,
  source: "local",
  osVersion,
  formFactor: "phone",
});

describe("startDevice by name with a binding device matching the same name", () => {
  let timer: FakeTimer | undefined;
  let sessions: SessionManager | undefined;
  let devices: FakeDeviceUtils;
  let registry: FakeBindingRegistry;
  let pool: DevicePool;
  let lifecycleCoordinator: FakeVirtualDeviceLifecycleCoordinator;

  function arrangeHarness(): void {
    resetDeviceToolsDependencies();
    DaemonState.getInstance().reset();
    clearDirectSessionDevices();
    timer = new FakeTimer();
    devices = new FakeDeviceUtils();
    registry = new FakeBindingRegistry(timer);
    const idGenerator = new CountingIdGenerator("name-start");
    lifecycleCoordinator = new FakeVirtualDeviceLifecycleCoordinator();
    setDeviceToolsDependencies({
      env: { AUTOMOBILE_DEVICE_POOL_AUTOLOCK: "0" },
      deviceManagerFactory: () => devices,
      deviceMatcherFactory: () => new DefaultDeviceMatcher(),
      notifyResourcesChanged: async () => {},
      notifyDeviceInventoryResourcesChanged: async () => {},
      syncInstalledAppResourceRegistry: async () => false,
      ensureCtrlProxyReady: async () => {},
      timer,
      idGenerator,
      lifecycleCoordinator,
    });
    PlatformDeviceManagerFactory.setInstance(devices);
    setDeviceManager(devices);
    sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
    pool = new DevicePool(
      createDevicePoolDependencies(sessions, "name-start-daemon", {
        timer,
        idGenerator,
        deviceManager: devices,
        installedAppsRepository: new FakeInstalledAppsRepository(),
        bindingExclusion: new RegistryBindingExclusion(async () => registry, timer),
      }),
    );
    DaemonState.getInstance().initialize(
      sessions,
      pool,
      new DeviceSessionRegistry(timer, idGenerator),
    );
    registerDeviceTools();
  }

  function teardown(): void {
    resetDeviceToolsDependencies();
    DaemonState.getInstance().reset();
    sessions?.stopCleanupTimer();
    clearDirectSessionDevices();
    setDeviceManager(null);
    PlatformDeviceManagerFactory.reset();
    timer?.reset();
  }

  // The first startDevice call in a process loads the tool, pool and provisioning paths (~100 ms):
  // each scenario runs once in beforeAll, outside the per-test budget, then again as the measured
  // test. Each test still builds its own DevicePool harness in its body.
  const warmed = warmedTests(teardown);
  function arranged(name: string, fn: () => void | Promise<void>, timeout?: number): void {
    warmed(
      name,
      async () => {
        await arrangeHarness();
        await fn();
      },
      timeout,
    );
  }

  const start = async (args: Record<string, unknown>): Promise<Record<string, any>> => {
    const result = (await ToolRegistry.getTool("startDevice")!.handler(args)) as {
      content: Array<{ text: string }>;
    };
    return JSON.parse(result.content[0].text);
  };
  const startByName = () => start({ platform: "ios", name: "iPhone 16" });
  const bootedNames = (): string[] =>
    devices.getExecutedOperations().filter((operation) => operation.startsWith("startDevice:"));

  // Control: the boot's own exclusion works when the slot's simulator is not the matcher's pick.
  arranged("boots the free simulator when the binding holds the older one", async () => {
    await assignBindingDevice(registry, "ios", SLOT_UDID);
    devices.setBootedDevices("ios", []);
    devices.setDeviceImages("ios", [simulator(SLOT_UDID, "18.0"), simulator(FREE_UDID, "18.2")]);

    const result = await startByName();

    expect(result.runtime.deviceId).toBe(FREE_UDID);
  });

  arranged("boots the free simulator when the binding holds the newer one", async () => {
    await assignBindingDevice(registry, "ios", SLOT_UDID);
    devices.setBootedDevices("ios", []);
    // Same request, same inventory; only which of the two same-named simulators the slot holds
    // differs. LATEST matching makes the slot's simulator the lifecycle-target pick.
    devices.setDeviceImages("ios", [simulator(SLOT_UDID, "18.2"), simulator(FREE_UDID, "18.0")]);

    const outcome = await startByName().catch((error: unknown) => error);

    expect((outcome as { code?: string }).code).not.toBe(DEVICE_ASSIGNED_TO_BINDING_CODE);
    expect(outcome).not.toBeInstanceOf(Error);
    expect((outcome as Record<string, any>).runtime.deviceId).toBe(FREE_UDID);
    expect(bootedNames()).toEqual([expect.stringContaining("iPhone 16")]);
  });

  arranged("a name only the binding's simulator matches is refused like its UDID", async () => {
    await assignBindingDevice(registry, "ios", SLOT_UDID);
    devices.setBootedDevices("ios", []);
    devices.setDeviceImages("ios", [simulator(SLOT_UDID, "18.2")]);

    const outcome = await startByName().catch((error: unknown) => error);

    expect(outcome).toMatchObject({ code: DEVICE_ASSIGNED_TO_BINDING_CODE });
    expect(bootedNames()).toEqual([]);
  });

  arranged(
    "an explicit UDID naming the binding's simulator stays refused with a free twin present",
    async () => {
      await assignBindingDevice(registry, "ios", SLOT_UDID);
      devices.setBootedDevices("ios", []);
      devices.setDeviceImages("ios", [simulator(SLOT_UDID, "18.2"), simulator(FREE_UDID, "18.0")]);

      const outcome = await start({ platform: "ios", deviceId: SLOT_UDID }).catch(
        (error: unknown) => error,
      );

      expect(outcome).toMatchObject({ code: DEVICE_ASSIGNED_TO_BINDING_CODE });
      expect(bootedNames()).toEqual([]);
    },
  );

  // Android has no such hole: its name is leased as written and only the boot matches it,
  // with the managed AVDs already excluded.
  arranged("an Android name whose best match is the binding's AVD boots the free AVD", async () => {
    await assignBindingDevice(registry, "android", "Pixel_7_API_35");
    devices.setBootedDevices("android", []);
    devices.setDeviceImages("android", [avd("Pixel_7_API_35", "15"), avd("Pixel_7_API_34", "14")]);

    const result = await start({ platform: "android", name: "Pixel_7" });

    expect(result.name).toBe("Pixel_7_API_34");
    expect(bootedNames()).toEqual([expect.stringContaining("Pixel_7_API_34")]);
  });

  arranged("an Android name that is exactly the binding's AVD is refused", async () => {
    await assignBindingDevice(registry, "android", "Pixel_7_API_35");
    devices.setBootedDevices("android", []);
    devices.setDeviceImages("android", [avd("Pixel_7_API_35", "15"), avd("Pixel_7_API_34", "14")]);

    const outcome = await start({ platform: "android", name: "Pixel_7_API_35" }).catch(
      (error: unknown) => error,
    );

    expect(outcome).toMatchObject({ code: DEVICE_ASSIGNED_TO_BINDING_CODE });
    expect(bootedNames()).toEqual([]);
  });
  async function creatingSlot(name: string) {
    const scope = await registry.ensureScope({
      managedHostScope: "host",
      runnerNamespace: "creating",
      runnerIncarnation: "boot-1",
    });
    if (scope.kind !== "ready") {
      throw new Error(`scope not ready: ${scope.kind}`);
    }
    const key = { scopeKey: scope.scope.scopeKey, bindingIndex: 0 };
    await registry.initBinding(key, { role: "app", platform: "ios", requestedSpec: {} });
    expect(
      await registry.openBindingJournal(key, {
        kind: "create",
        phase: "creating",
        owner: { daemonId: "creator", pid: 1, processGenerationToken: "fake" },
        target: {
          oldStableId: null,
          oldName: null,
          newStableId: null,
          newName: name,
          requestedSpec: {},
          resolvedSpec: null,
          specFingerprint: "fp",
        },
        assignment: {
          kind: "state",
          expected: { generation: 0, stableDeviceId: null },
          state: "provisioning",
        },
      }),
    ).toMatchObject({ kind: "opened" });
  }

  arranged("both lifecycle matching and boot selection skip the name-held simulator", async () => {
    const name = "amslot-12345678-0-g1-attempt";
    await creatingSlot(name);
    devices.setBootedDevices("ios", []);
    devices.setDeviceImages("ios", [
      { ...simulator(SLOT_UDID, "18.2"), name },
      { ...simulator(FREE_UDID, "18.0"), name: `${name}-user` },
    ]);

    const result = await start({ platform: "ios", name: "amslot-" });

    expect(result.runtime.deviceId).toBe(FREE_UDID);
    expect(bootedNames()).toEqual([expect.stringContaining(`startDevice:${name}-user:`)]);
  });

  arranged(
    "a running name-held simulator is never selected or deferred to as an idle match",
    async () => {
      const name = "amslot-12345678-0-g1-attempt";
      await creatingSlot(name);
      const booted = [{ name, deviceId: SLOT_UDID, platform: "ios" as const }];
      devices.setBootedDevices("ios", booted);
      await pool.initializeWithDevices(booted);
      devices.setDeviceImages("ios", [
        { ...simulator(SLOT_UDID, "18.2"), name, isRunning: true },
        { ...simulator(FREE_UDID, "18.0"), name: `${name}-user` },
      ]);

      const result = await start({ platform: "ios", name: "amslot-" });

      expect(result.runtime.deviceId).toBe(FREE_UDID);
      expect(pool.getDevice(SLOT_UDID)?.sessionId).toBeNull();
      expect(bootedNames()).toEqual([expect.stringContaining(`startDevice:${name}-user:`)]);
    },
  );

  arranged(
    "an unpooled name-held simulator is refused before taking its lifecycle lease",
    async () => {
      const name = "amslot-12345678-0-g1-attempt";
      await creatingSlot(name);
      devices.setBootedDevices("ios", []);
      devices.setDeviceImages("ios", [{ ...simulator(SLOT_UDID, "18.2"), name }]);

      const outcome = await start({ platform: "ios", name, createIfMissing: false }).catch(
        (error: unknown) => error,
      );

      expect(outcome).toMatchObject({ code: DEVICE_ASSIGNED_TO_BINDING_CODE });
      expect((outcome as Error).message).toStartWith("startDevice refused:");
      expect(lifecycleCoordinator.reservations).toEqual([]);
      expect(bootedNames()).toEqual([]);
    },
  );
});
