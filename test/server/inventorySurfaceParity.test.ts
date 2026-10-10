import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { DaemonState } from "../../src/daemon/daemonState";
import { DevicePool } from "../../src/daemon/devicePool";
import type { ForeignDeviceOwnership } from "../../src/daemon/foreignDeviceOwnership";
import { RegistryManagedSlotExclusion } from "../../src/daemon/managedSlots/managedSlotExclusion";
import { SessionManager } from "../../src/daemon/sessionManager";
import type { PlatformDeviceManager } from "../../src/devices/deviceUtils";
import type { BootedDevice } from "../../src/models";
import {
  getBootedDevicesForPlatforms,
  resetBootedDevicesResourceCache,
  setDeviceManager,
} from "../../src/server/bootedDeviceResources";
import {
  registerDeviceTools,
  resetDeviceToolsDependencies,
  setDeviceToolsDependencies,
} from "../../src/server/deviceTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { DefaultRetryExecutor } from "../../src/utils/retry/RetryExecutor";
import { assignManagedSlotDevice } from "../daemon/managedSlots/managedSlotFixtures";
import { FakeAdbClientFactory } from "../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { createExecResult } from "../../src/utils/execResult";
import { FakeDeviceHealthMarkers } from "../fakes/FakeDeviceHealthMarkers";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeSlotRegistry } from "../fakes/FakeSlotRegistry";
import { FakeTimer } from "../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";

// Inventory contract: every inventory surface describes the same device the same way. The
// listDevices tool and the booted-devices resource are built from different code paths, so this
// table pins them field by field for each device situation. A field only the resource publishes
// must be listed in RESOURCE_ONLY_FIELDS; anything else that differs is a new divergence.

const android: BootedDevice = {
  platform: "android",
  name: "Pixel_9_API_36",
  deviceId: "emulator-5554",
};

/** Fields the resource publishes and the tool deliberately does not (tool shape is public). */
const RESOURCE_ONLY_FIELDS = [
  "recoveryEligibility",
  "identityUnresolved",
  "serviceStatusDiagnostic",
];

/**
 * Fields the tool publishes and the resource does not. `transportAliases` is a public listDevices
 * field; publishing it on the resource is an open owner decision (#11455).
 */
const TOOL_ONLY_FIELDS = ["transportAliases"];

type Entry = Record<string, unknown> & { runtime: Record<string, unknown> };

interface Scenario {
  name: string;
  build(ctx: ScenarioContext): Promise<{ pool: DevicePool; discovered: BootedDevice[] }>;
  adbOffline?: boolean;
}

interface ScenarioContext {
  timer: FakeTimer;
  sessions: SessionManager;
  manager: FakeDeviceUtils;
}

function poolFor(ctx: ScenarioContext, extra: Record<string, unknown> = {}): DevicePool {
  return new DevicePool(
    createDevicePoolDependencies(ctx.sessions, "parity", {
      timer: ctx.timer,
      deviceManager: ctx.manager,
      retryExecutor: new DefaultRetryExecutor(ctx.timer),
      installedAppsRepository: new FakeInstalledAppsRepository(),
      ...extra,
    }),
  );
}

const scenarios: Scenario[] = [
  {
    name: "idle",
    async build(ctx) {
      const pool = poolFor(ctx);
      await pool.initializeWithDevices([android]);
      return { pool, discovered: [android] };
    },
  },
  {
    name: "held",
    async build(ctx) {
      const pool = poolFor(ctx);
      await pool.initializeWithDevices([android]);
      await pool.assignDeviceToSession("session-held");
      return { pool, discovered: [android] };
    },
  },
  {
    name: "held and adb-offline",
    adbOffline: true,
    async build(ctx) {
      const pool = poolFor(ctx);
      await pool.initializeWithDevices([android]);
      await pool.assignDeviceToSession("session-held");
      return { pool, discovered: [] };
    },
  },
  {
    name: "held and adb-offline, pooled name differs from its AVD name",
    adbOffline: true,
    async build(ctx) {
      const pool = poolFor(ctx);
      await pool.initializeWithDevices([android]);
      await pool.assignDeviceToSession("session-held");
      // The pooled label drifted from the AVD the pool confirmed for the serial.
      const pooled = pool.getDevice(android.deviceId)!;
      pooled.avdName = android.name;
      pooled.name = `Unknown (${android.deviceId})`;
      return { pool, discovered: [] };
    },
  },
  {
    name: "emulator reached through a transport alias",
    async build(ctx) {
      const adb = new FakeAdbExecutor();
      adb.setCommandResponse("getprop ro.serialno", createExecResult(android.deviceId, ""));
      adb.setCommandResponse("boot_id", createExecResult("emu-boot", ""));
      adb.setCommandResponse("getprop ro.kernel.qemu", createExecResult("1", ""));
      adb.setCommandResponse("getprop ro.boot.qemu.avd_name", createExecResult(android.name, ""));
      const pool = poolFor(ctx, { androidAdbFactory: new FakeAdbClientFactory(adb) });
      const rows = [
        { platform: "android" as const, name: "localhost:5555", deviceId: "localhost:5555" },
        { ...android, name: android.deviceId },
      ];
      ctx.manager.setBootedDevices("android", rows);
      await pool.refreshDevices();
      return { pool, discovered: rows };
    },
  },
  {
    name: "error (health marker)",
    async build(ctx) {
      const markers = new FakeDeviceHealthMarkers(ctx.timer);
      const pool = poolFor(ctx, { deviceHealthMarkers: markers });
      await pool.initializeWithDevices([android]);
      const incarnation = pool.getDevice(android.deviceId)!.incarnation;
      markers.mark(android.deviceId, incarnation, "clock");
      return { pool, discovered: [android] };
    },
  },
  {
    name: "quarantined (identity unresolved)",
    async build(ctx) {
      const pool = poolFor(ctx);
      await pool.addDevice(android, { platform: "android", name: android.name, isRunning: true });
      // The serial now answers as a different AVD: the pool quarantines the entry.
      return { pool, discovered: [{ ...android, name: "Pixel_9_API_35" }] };
    },
  },
  {
    name: "managed-slot held",
    async build(ctx) {
      const registry = new FakeSlotRegistry(ctx.timer);
      await assignManagedSlotDevice(registry, "android", android.name);
      const pool = poolFor(ctx, {
        managedSlotExclusion: new RegistryManagedSlotExclusion(async () => registry, ctx.timer),
      });
      await pool.initializeWithDevices([android]);
      await pool.managedSlotStableIds("android");
      return { pool, discovered: [android] };
    },
  },
  {
    name: "external (another daemon)",
    async build(ctx) {
      const ownership: ForeignDeviceOwnership = {
        async refresh() {},
        foreignOwnerPid: (id) => (id === android.deviceId ? 4242 : undefined),
        claim: async () => true,
        release() {},
      };
      const pool = poolFor(ctx, { foreignDeviceOwnership: ownership });
      await pool.initializeWithDevices([android]);
      return { pool, discovered: [android] };
    },
  },
];

function describeEntry(entries: Entry[]): Entry {
  const entry = entries.find((candidate) => candidate.runtime.deviceId === android.deviceId);
  if (!entry) {
    throw new Error(`no entry for ${android.deviceId} among ${JSON.stringify(entries)}`);
  }
  return entry;
}

function withoutResourceOnly(entry: Entry): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(entry).filter(
      ([key]) => !RESOURCE_ONLY_FIELDS.includes(key) && !TOOL_ONLY_FIELDS.includes(key),
    ),
  );
}

describe("listDevices tool and booted resource describe a device identically", () => {
  let sessions: SessionManager | undefined;

  beforeAll(() => {
    if (!ToolRegistry.getTool("listDevices")) {
      registerDeviceTools();
    }
  });

  afterEach(() => {
    DaemonState.getInstance().reset();
    sessions?.stopCleanupTimer();
    resetBootedDevicesResourceCache();
    setDeviceManager(null);
  });

  afterAll(() => {
    resetDeviceToolsDependencies();
  });

  test.each(scenarios)("$name", async (scenario) => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const manager = new FakeDeviceUtils();
    manager.setBootedDevices("android", [android]);
    manager.setBootedDevices("ios", []);
    manager.setDeviceImages("android", [
      { platform: "android", name: android.name, isRunning: false, apiLevel: 36, osVersion: "16" },
    ]);
    sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const { pool, discovered } = await scenario.build({ timer, sessions, manager });
    manager.setBootedDevices("android", discovered);
    if (scenario.adbOffline) {
      (manager as PlatformDeviceManager).getAndroidListedDeviceStates = async (ids) =>
        new Map(ids.map((id) => [id, "offline"]));
    }
    DaemonState.getInstance().initialize(sessions, pool);
    setDeviceToolsDependencies({
      deviceManagerFactory: () => manager,
      avdManagerFactory: () => ({ listDeviceImages: async () => [] }),
    });
    setDeviceManager(manager);

    const resource = await getBootedDevicesForPlatforms(["android"], timer);
    const response = await ToolRegistry.getTool("listDevices")!.handler({ platform: "android" });
    const payload = JSON.parse(response.content?.[0]?.text ?? "{}");

    const fromResource = describeEntry(resource.devices as unknown as Entry[]);
    const fromTool = describeEntry(payload.devices as Entry[]);

    const resourceView = withoutResourceOnly(fromResource);
    const toolView = withoutResourceOnly(fromTool);
    expect(Object.keys(toolView).sort()).toEqual(Object.keys(resourceView).sort());
    // `lifecycle` is the resource's live boot-completion probe, not inventory identity.
    const withoutLifecycle = (view: Record<string, unknown>) => ({
      ...view,
      runtime: Object.fromEntries(
        Object.entries(view.runtime as Entry).filter(([key]) => key !== "lifecycle"),
      ),
    });
    expect(withoutLifecycle(toolView)).toEqual(withoutLifecycle(resourceView));
  });
});
