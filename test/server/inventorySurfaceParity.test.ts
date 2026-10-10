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
  /** The row the scenario is about; defaults to the emulator. */
  focus?: string;
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
    // A real Session object whose assignedDevice disagrees with the pool (pool idle): the pool's
    // assignment is the one holder authority, so neither surface may name that session (#11535).
    name: "idle, a real session still points at the device",
    async build(ctx) {
      const pool = poolFor(ctx);
      await pool.initializeWithDevices([android]);
      await ctx.sessions.createSession("session-pointing-at-device", android.deviceId, "android");
      return { pool, discovered: [android] };
    },
  },
  {
    // The pool holds the device for one session while a different real session points at it.
    name: "held by the pool, a different real session points at the device",
    async build(ctx) {
      const pool = poolFor(ctx);
      await pool.initializeWithDevices([android]);
      await pool.assignDeviceToSession("session-held");
      await ctx.sessions.createSession("session-other", android.deviceId, "android");
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
    // A pooled USB phone whose serial a Wi-Fi peer now claims while the USB row has no identity
    // evidence: the pool keeps the row but allocation can no longer lend it.
    name: "pooled phone whose serial is now claimed by an unproven transport",
    focus: "R5CT123",
    async build(ctx) {
      const usb: BootedDevice = { platform: "android", name: "Pixel 9", deviceId: "R5CT123" };
      const wifi: BootedDevice = {
        platform: "android",
        name: "192.168.1.9:5555",
        deviceId: "192.168.1.9:5555",
      };
      const wifiAdb = new FakeAdbExecutor();
      wifiAdb.setCommandResponse("getprop ro.serialno", createExecResult(usb.deviceId, ""));
      wifiAdb.setCommandResponse("boot_id", createExecResult("phone-boot", ""));
      wifiAdb.setCommandResponse("getprop ro.kernel.qemu", createExecResult("0", ""));
      const factory = {
        create: (device?: BootedDevice | null) => {
          if (device?.deviceId === wifi.deviceId) {
            return wifiAdb;
          }
          throw new Error("usb transport has no identity");
        },
      } as unknown as FakeAdbClientFactory;
      const pool = poolFor(ctx, { androidAdbFactory: factory });
      await pool.initializeWithDevices([usb]);
      const rows = [usb, wifi];
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

function describeEntry(entries: Entry[], deviceId: string): Entry {
  const entry = entries.find((candidate) => candidate.runtime.deviceId === deviceId);
  if (!entry) {
    throw new Error(`no entry for ${deviceId} among ${JSON.stringify(entries)}`);
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

    const fromResource = describeEntry(
      resource.devices as unknown as Entry[],
      scenario.focus ?? android.deviceId,
    );
    const fromTool = describeEntry(payload.devices as Entry[], scenario.focus ?? android.deviceId);

    // One status authority: every row either surface publishes carries the pool's own bucket.
    const surfaces = {
      resource: resource.devices as unknown as Entry[],
      tool: payload.devices as Entry[],
    };
    for (const [surface, rows] of Object.entries(surfaces)) {
      for (const row of rows) {
        const id = String(row.runtime.deviceId);
        const bucket = pool.poolBucket(id);
        // A null poolStatus is the deliberate withholding of pool context from a row whose pooled
        // entry does not describe the discovered runtime (quarantine, drifted label; #6863).
        if (bucket !== null && row.runtime.poolStatus !== null) {
          expect({ surface, id, poolStatus: row.runtime.poolStatus }).toEqual({
            surface,
            id,
            poolStatus: bucket,
          });
        }
      }
    }

    // The CLI `available-devices` counts and `getStats` are the same buckets as the rows, whenever
    // every pooled device is published with its pool context.
    const stats = pool.getStats();
    const pooledRows = (resource.devices as unknown as Entry[]).filter(
      (row) => row.runtime.poolStatus !== null,
    );
    if (pooledRows.length === stats.total) {
      expect(resource.poolStatus).toMatchObject({
        idle: stats.idle,
        assigned: stats.assigned,
        error: stats.error,
      });
    }

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
