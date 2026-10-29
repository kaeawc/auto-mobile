import { z } from "zod/v4";
import { toolJson } from "../helpers/toolResponse";
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { runDaemonCommand } from "../../src/daemon/cli/runDaemonCommand";
import {
  handleDaemonRequest,
  type DaemonStateAccess,
} from "../../src/daemon/daemonRequestHandlers";
import { DaemonState, type DaemonStateLike } from "../../src/daemon/daemonState";
import { DevicePool, type DevicePoolDependencies } from "../../src/daemon/devicePool";
import type { ForeignDeviceOwnership } from "../../src/daemon/foreignDeviceOwnership";
import { RegistryBindingExclusion } from "../../src/daemon/sessionBroker/provisioning/exclusion";
import { SessionManager } from "../../src/daemon/sessionManager";
import { createHarnessServer } from "../daemon/helpers/UnixSocketServerHarness";
import type { PlatformDeviceManager } from "../../src/devices/deviceUtils";
import type { BootedDevice } from "../../src/models";
import {
  type BootedDevicesResourceContent,
  getBootedDevicesForPlatforms,
  resetBootedDevicesResourceCache,
  setDeviceManager,
} from "../../src/server/bootedDeviceResources";
import {
  listDevicesOutputSchema,
  registerDeviceTools,
  resetDeviceToolsDependencies,
  setDeviceToolsDependencies,
} from "../../src/server/deviceTools";
import { createSetActiveDeviceHandler } from "../../src/server/setActiveDevice";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import type { AdbClientFactory } from "../../src/utils/android-cmdline-tools/AdbClientFactory";
import { DefaultRetryExecutor } from "../../src/utils/retry/RetryExecutor";
import { assignBindingDevice } from "../daemon/sessionBroker/provisioning/bindingFixtures";
import { FakeAdbClientFactory } from "../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { createExecResult } from "../../src/utils/execResult";
import { FakeDeviceHealthMarkers } from "../fakes/FakeDeviceHealthMarkers";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeBindingRegistry } from "../fakes/FakeBindingRegistry";
import { FakeTimer } from "../fakes/FakeTimer";
import { SafeDaemonManager } from "../fakes/SafeDaemonManager";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";

isolateToolRegistry();

const inventoryToolResponseSchema = listDevicesOutputSchema.extend({
  discovery: z
    .object({
      complete: z.boolean(),
      notApplicableSources: z.array(z.string()).optional(),
      failedSources: z.array(z.string()).optional(),
    })
    .passthrough(),
});

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

type Entry = BootedDevicesResourceContent["devices"][number];

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

function poolFor(ctx: ScenarioContext, extra: Partial<DevicePoolDependencies> = {}): DevicePool {
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
      } satisfies AdbClientFactory;
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
    name: "binding held",
    async build(ctx) {
      const registry = new FakeBindingRegistry(ctx.timer);
      await assignBindingDevice(registry, "android", android.name);
      const pool = poolFor(ctx, {
        bindingExclusion: new RegistryBindingExclusion(async () => registry, ctx.timer),
      });
      await pool.initializeWithDevices([android]);
      await pool.bindingStableIds("android");
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
        new Map(Array.from(ids, (id) => [id, "offline"]));
    }
    DaemonState.getInstance().initialize(sessions, pool);
    setDeviceToolsDependencies({
      deviceManagerFactory: () => manager,
      avdManagerFactory: () => ({ listDeviceImages: async () => [] }),
    });
    setDeviceManager(manager);

    const resource = await getBootedDevicesForPlatforms(["android"], timer);
    const response = await ToolRegistry.getTool("listDevices")!.handler({ platform: "android" });
    const payload = inventoryToolResponseSchema.parse(toolJson(response));

    const fromResource = describeEntry(resource.devices, scenario.focus ?? android.deviceId);
    const fromTool = describeEntry(payload.devices, scenario.focus ?? android.deviceId);

    // One status authority: every row either surface publishes carries the pool's own bucket.
    const surfaces = {
      resource: resource.devices,
      tool: payload.devices,
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
    const pooledRows = resource.devices.filter((row) => row.runtime.poolStatus !== null);
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

// Transitional-state rows (#11573). One rule for both platforms: a held device that the platform
// still lists in a transitional state is shown, with that state, and counted as assigned, never
// idle; an unknown count is refused, never zero. Every surface below reads the same pool.

const simulator: BootedDevice = {
  platform: "ios",
  name: "iPhone 17",
  deviceId: "SIM-HELD-0001",
};

interface SurfaceReads {
  tool: Entry[];
  resource: Entry[];
  resourcePool: { idle: number; assigned: number; error: number } | undefined;
  resourceComplete: boolean;
  toolComplete: boolean | undefined;
  daemon: { success: boolean; result?: Record<string, unknown>; error?: string };
  cli: { stdout: string[]; exits: unknown[] };
  stats: { total: number; idle: number; assigned: number } | { error: string };
}

interface TransitionalScenario {
  name: string;
  platform: "android" | "ios";
  device: BootedDevice;
  /** Whether a session holds the device. */
  held: boolean;
  /** Configure the fake manager so the platform reports the device in a transitional state. */
  transition(manager: FakeDeviceUtils): void;
  /** Row fields every row surface must carry; `null` means no row is published at all. */
  row: {
    lifecycle?: string;
    simulatorState?: string;
    connection?: { state: string; adbState: string };
    poolStatus: string;
  } | null;
  /** Expected counts, or `unknown` when the count must be refused as discovery_incomplete. */
  counts: { total: number; idle: number; assigned: number } | "unknown";
}

const transitionalScenarios: TransitionalScenario[] = [
  {
    name: "held iOS simulator that is Booting",
    platform: "ios",
    device: simulator,
    held: true,
    transition: (manager) => {
      manager.setBootedDevices("ios", []);
      manager.setTransitionalSimulators([{ device: simulator, state: "Booting" }]);
    },
    row: { lifecycle: "booting", simulatorState: "Booting", poolStatus: "assigned" },
    counts: { total: 1, idle: 0, assigned: 1 },
  },
  {
    name: "held iOS simulator that is Shutting Down",
    platform: "ios",
    device: simulator,
    held: true,
    transition: (manager) => {
      manager.setBootedDevices("ios", []);
      manager.setTransitionalSimulators([{ device: simulator, state: "Shutting Down" }]);
    },
    row: { lifecycle: "shutting-down", simulatorState: "Shutting Down", poolStatus: "assigned" },
    counts: { total: 1, idle: 0, assigned: 1 },
  },
  {
    name: "pooled but unheld iOS simulator that is Booting stays unlisted and uncounted",
    platform: "ios",
    device: simulator,
    held: false,
    transition: (manager) => {
      manager.setBootedDevices("ios", []);
      manager.setTransitionalSimulators([{ device: simulator, state: "Booting" }]);
    },
    row: null,
    counts: { total: 0, idle: 0, assigned: 0 },
  },
  {
    name: "held Android device adb lists unauthorized",
    platform: "android",
    device: android,
    held: true,
    transition: (manager) => {
      manager.setBootedDevices("android", []);
      (manager as PlatformDeviceManager).getAndroidListedDeviceStates = async (ids) =>
        new Map([...ids].map((id) => [id, "unauthorized"]));
    },
    row: {
      connection: { state: "offline", adbState: "unauthorized" },
      poolStatus: "assigned",
    },
    counts: { total: 1, idle: 0, assigned: 1 },
  },
  {
    name: "held Android device discovery misses and the state probe throws",
    platform: "android",
    device: android,
    held: true,
    transition: (manager) => {
      manager.setBootedDevices("android", []);
      (manager as PlatformDeviceManager).getAndroidListedDeviceStates = async () => {
        throw new Error("adb devices -l timed out");
      };
    },
    row: null,
    counts: "unknown",
  },
];

async function readSurfaces(
  scenario: TransitionalScenario,
  built: { pool: DevicePool; sessions: SessionManager; timer: FakeTimer },
): Promise<SurfaceReads> {
  const { pool, sessions, timer } = built;
  const resource = await getBootedDevicesForPlatforms([scenario.platform], timer);
  const response = await ToolRegistry.getTool("listDevices")!.handler({
    platform: scenario.platform,
  });
  const tool = inventoryToolResponseSchema.parse(toolJson(response));
  const state: DaemonStateAccess = {
    isInitialized: () => true,
    getSessionManager: () => sessions as never,
    getDevicePool: () => pool,
    getDeviceSessionRegistry: () => ({ list: () => [] }),
  };
  const daemon = await handleDaemonRequest(
    { id: "r", type: "daemon_request", method: "daemon/availableDevices", params: {} },
    state,
  );
  const stdout: string[] = [];
  const exits: unknown[] = [];
  const log = spyOn(console, "log").mockImplementation((text) => {
    stdout.push(String(text));
  });
  const errorSpy = spyOn(console, "error").mockImplementation(() => {});
  const exit = spyOn(process, "exit").mockImplementation((code) => {
    exits.push(code);
    throw new Error("exit");
  });
  try {
    await runDaemonCommand("available-devices", [], {}, SafeDaemonManager).catch(() => {});
  } finally {
    exit.mockRestore();
    errorSpy.mockRestore();
    log.mockRestore();
  }
  const stats = await pool.getRefreshedStats().then(
    (value) => ({ total: value.total, idle: value.idle, assigned: value.assigned }),
    (error: unknown) => ({ error: String((error as { code?: string }).code ?? error) }),
  );
  return {
    tool: tool.devices,
    resource: resource.devices,
    resourcePool: resource.poolStatus,
    resourceComplete: resource.observationComplete,
    toolComplete: tool.discovery?.complete,
    daemon: daemon as SurfaceReads["daemon"],
    cli: { stdout, exits },
    stats,
  };
}

describe("a held device in a transitional platform state is one row and one count on every surface", () => {
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

  test.each(transitionalScenarios)("$name", async (scenario) => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const manager = new FakeDeviceUtils();
    manager.setBootedDevices("android", []);
    manager.setBootedDevices("ios", []);
    sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const pool = poolFor({ timer, sessions, manager });
    manager.setBootedDevices(scenario.platform, [scenario.device]);
    await pool.initializeWithDevices([scenario.device]);
    if (scenario.held) {
      await pool.bindOrReuseDeviceSession({
        sessionId: "session-held",
        deviceId: scenario.device.deviceId,
        platform: scenario.platform,
      });
    }
    scenario.transition(manager);
    DaemonState.getInstance().initialize(sessions, pool);
    setDeviceToolsDependencies({
      deviceManagerFactory: () => manager,
      avdManagerFactory: () => ({ listDeviceImages: async () => [] }),
    });
    setDeviceManager(manager);

    const reads = await readSurfaces(scenario, { pool, sessions, timer });

    const rowOf = (rows: Entry[]) =>
      rows.find((candidate) => candidate.runtime.deviceId === scenario.device.deviceId);
    for (const [surface, rows] of Object.entries({ tool: reads.tool, resource: reads.resource })) {
      const row = rowOf(rows);
      if (scenario.row === null) {
        expect({ surface, row }).toEqual({ surface, row: undefined });
        continue;
      }
      expect({ surface, present: row !== undefined }).toEqual({ surface, present: true });
      expect<unknown>(row!.runtime.poolStatus).toBe(scenario.row.poolStatus);
      expect((row!.runtime.session as { sessionUuid: string }).sessionUuid).toBe("session-held");
      expect(row!.runtime.readiness).toEqual({ state: "not_ready" });
      if (scenario.row.lifecycle) {
        expect<unknown>(row!.runtime.lifecycle).toEqual({
          state: scenario.row.lifecycle,
          known: true,
        });
      }
      expect<unknown>(row!.runtime.simulatorState).toBe(scenario.row.simulatorState);
      expect<unknown>(row!.runtime.connection).toEqual(scenario.row.connection);
    }

    if (scenario.counts === "unknown") {
      // A count that cannot be established is refused on every counting surface, never zero.
      expect(reads.stats).toEqual({ error: "discovery_incomplete" });
      expect(reads.daemon.success).toBe(false);
      expect(String(reads.daemon.error)).toContain("discovery_incomplete");
      expect(reads.cli.exits).toEqual([1]);
      // The row surfaces say the same thing: the platform observation is incomplete, so their
      // zeroed counts are not an answer.
      expect(reads.resourceComplete).toBe(false);
      expect(reads.toolComplete).toBe(false);
      return;
    }
    expect(reads.resourceComplete).toBe(true);
    expect(reads.toolComplete).toBe(true);
    const { total, idle, assigned } = scenario.counts;
    expect(reads.stats).toEqual({ total, idle, assigned });
    expect(reads.daemon.result).toMatchObject({
      totalDevices: total,
      availableDevices: idle,
      assignedDevices: assigned,
    });
    expect(reads.resourcePool).toMatchObject({ idle, assigned });
    expect(JSON.parse(reads.cli.stdout.join("\n"))).toMatchObject({
      totalDevices: total,
      availableDevices: idle,
      assignedDevices: assigned,
    });
  });
});

// Inventory contract (#11605): one rule on every surface. A discovery source whose tooling is not
// installed on this host is NOT APPLICABLE: it never makes an observation incomplete, is never
// retryable, and its device count is a true zero. A source that exists and failed is INCOMPLETE:
// the answer is unknown (`discovery_incomplete`, retryable), never zero. A single-platform machine
// is a fully supported configuration. The host shapes are crossed with the row kinds above.

const hostSimulator: BootedDevice = {
  platform: "ios",
  name: "iPhone 17",
  deviceId: "11111111-2222-3333-4444-555555555555",
};
const ABSENT = {
  android: "emulator-5999",
  "ios-simulator": "99999999-2222-3333-4444-555555555555",
  "ios-physical": "00008110-001A2B3C4D5E6F78",
} as const;
// The Android and iOS inventory sources this parity covers; watches have their own listing.
const ALL_SOURCES = ["android", "ios-simulator", "ios-physical"] as const;
type InventorySource = (typeof ALL_SOURCES)[number];

interface Host {
  host: string;
  notInstalled: readonly InventorySource[];
  failing: readonly InventorySource[];
}

type RowKind =
  | "nothing booted"
  | "one device booted"
  | "held Booting simulator"
  | "held Shutting Down simulator"
  | "held emulator, offline probe throws"
  /**
   * A device pooled (and held) before its tooling began reporting "not installed" -- adb replaced
   * mid-upgrade, the active Xcode switched. The pooled entry proves the tooling existed, so the
   * source is unknown, never a true zero.
   */
  | "tooling vanished under a held emulator"
  | "tooling vanished under a held simulator";

const hosts: Host[] = [
  { host: "both platforms installed", notInstalled: [], failing: [] },
  { host: "Android-only", notInstalled: ["ios-simulator", "ios-physical"], failing: [] },
  { host: "iOS-only", notInstalled: ["android"], failing: [] },
  { host: "devicectl missing", notInstalled: ["ios-physical"], failing: [] },
  { host: "adb installed but failing", notInstalled: [], failing: ["android"] },
  { host: "simctl installed but failing", notInstalled: [], failing: ["ios-simulator"] },
  { host: "everything failing", notInstalled: [], failing: ALL_SOURCES },
];

const works = (host: Host, source: InventorySource) =>
  !host.notInstalled.includes(source) && !host.failing.includes(source);

// A transitional simulator needs a simctl that lists it; a probe failure needs an adb that listed
// the held emulator. Elsewhere the row kind cannot occur.
const hostCells: Array<Host & { kind: RowKind }> = [
  ...hosts.flatMap((host) =>
    (
      [
        "nothing booted",
        "one device booted",
        ...(works(host, "ios-simulator")
          ? (["held Booting simulator", "held Shutting Down simulator"] as const)
          : []),
        ...(works(host, "android") ? (["held emulator, offline probe throws"] as const) : []),
      ] as RowKind[]
    ).map((kind) => ({ ...host, kind })),
  ),
  {
    host: "adb disappears",
    notInstalled: ["android"],
    failing: [],
    kind: "tooling vanished under a held emulator",
  },
  {
    host: "Xcode disappears",
    notInstalled: ["ios-simulator", "ios-physical"],
    failing: [],
    kind: "tooling vanished under a held simulator",
  },
];

const unexpectedRemoteCall = (): never => {
  throw new Error("Unexpected daemon operation");
};
const remoteState: DaemonStateLike = {
  isInitialized: () => false,
  getSessionManager: unexpectedRemoteCall,
  getDevicePool: unexpectedRemoteCall,
  getDeviceSessionRegistry: unexpectedRemoteCall,
};

/** Run `--daemon available-devices` and reduce it to the count it printed, or its refusal code. */
async function availableDevicesCli(
  args: string[],
  state: DaemonStateLike,
  resourceText: string,
): Promise<unknown> {
  const stdout: string[] = [];
  const exits: unknown[] = [];
  class Client extends FakeDaemonClient {
    override async connect() {}
    override async readResource() {
      return { contents: [{ uri: "automobile:devices/booted", text: resourceText }] } as never;
    }
    override async close() {}
  }
  class Manager extends SafeDaemonManager {
    override getDaemonState() {
      return state;
    }
    override createClient() {
      return new Client();
    }
  }
  const log = spyOn(console, "log").mockImplementation((text) => {
    stdout.push(String(text));
  });
  const errorSpy = spyOn(console, "error").mockImplementation(() => {});
  const exit = spyOn(process, "exit").mockImplementation((code) => {
    exits.push(code);
    throw new Error("exit");
  });
  try {
    await runDaemonCommand("available-devices", args, {}, Manager).catch(() => {});
  } finally {
    exit.mockRestore();
    errorSpy.mockRestore();
    log.mockRestore();
  }
  if (exits.length === 0) {
    return JSON.parse(stdout[0] ?? "{}").availableDevices;
  }
  // A refusal exits 1; `--json` carries the typed code on stdout, text mode prints nothing there.
  return {
    exit: exits[0],
    ...(args.includes("--json") ? { code: JSON.parse(stdout[0] ?? "{}").code } : { stdout }),
  };
}

describe("every inventory surface gives one answer per discovery-source outcome (#11605)", () => {
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
    PlatformDeviceManagerFactory.setInstance(null);
  });

  afterAll(() => {
    resetDeviceToolsDependencies();
  });

  test.each(hostCells)("$host, $kind", async (cell) => {
    const { kind } = cell;
    const transitionalState =
      kind === "held Booting simulator"
        ? ("Booting" as const)
        : kind === "held Shutting Down simulator"
          ? ("Shutting Down" as const)
          : undefined;
    const probeThrows = kind === "held emulator, offline probe throws";
    const vanishedUnder =
      kind === "tooling vanished under a held emulator"
        ? android
        : kind === "tooling vanished under a held simulator"
          ? hostSimulator
          : undefined;
    // The booted device sits on a source that works on this host; when every source fails it is a
    // pooled emulator the daemon saw before the failure began.
    const device =
      vanishedUnder ??
      (transitionalState
        ? hostSimulator
        : probeThrows
          ? android
          : kind === "nothing booted"
            ? undefined
            : works(cell, "android") || !works(cell, "ios-simulator")
              ? android
              : hostSimulator);
    const held = device !== undefined && kind !== "one device booted";
    const sourceOf = (target: BootedDevice) => discoverySourceFor(target.platform, target.deviceId);

    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const manager = new FakeDeviceUtils();
    manager.setBootedDevices("android", device?.platform === "android" ? [device] : []);
    manager.setBootedDevices("ios", device?.platform === "ios" ? [device] : []);
    const activeSessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
    sessions = activeSessions;
    const pool = poolFor({ timer, sessions: activeSessions, manager });
    await pool.initializeWithDevices(device ? [device] : []);
    if (device && held) {
      await pool.bindOrReuseDeviceSession({
        sessionId: "session-held",
        deviceId: device.deviceId,
        platform: device.platform,
      });
      // Discovery stops listing the held device: it is transitional, offline, or its tool is gone.
      manager.setBootedDevices(device.platform, []);
    }
    if (transitionalState) {
      manager.setTransitionalSimulators([{ device: hostSimulator, state: transitionalState }]);
    }
    if (probeThrows) {
      (manager as PlatformDeviceManager).getAndroidListedDeviceStates = async () => {
        throw new Error("adb devices -l timed out");
      };
    }
    manager.notInstalledSources = new Set(cell.notInstalled);
    manager.failedSources = new Set(cell.failing);
    DaemonState.getInstance().initialize(activeSessions, pool);
    setDeviceToolsDependencies({
      deviceManagerFactory: () => manager,
      avdManagerFactory: () => ({ listDeviceImages: async () => [] }),
    });
    setDeviceManager(manager);
    PlatformDeviceManagerFactory.setInstance(manager);
    const before = {
      held: pool.getStats().assigned,
      sessions: activeSessions.getAllSessions().length,
    };

    const resource = await getBootedDevicesForPlatforms(["android", "ios"], timer);
    const resourceText = JSON.stringify(resource);
    const listed = inventoryToolResponseSchema.parse(
      toolJson(await ToolRegistry.getTool("listDevices")!.handler({})),
    );
    const codeOf = (error: unknown) => (error as { code?: string }).code ?? "untyped";
    const daemonState = DaemonState.getInstance();
    const daemonResponse = await handleDaemonRequest(
      { id: "r", type: "daemon_request", method: "daemon/availableDevices", params: {} },
      {
        isInitialized: () => true,
        getSessionManager: () => activeSessions as never,
        getDevicePool: () => pool,
        getDeviceSessionRegistry: () => ({ list: () => [] }),
      },
    );
    const ideServer = createHarnessServer("unused", daemonState, new FakeTimer());
    const select = createSetActiveDeviceHandler({
      resumeCtrlProxy: async () => {},
      transportWait: {
        timer: new FakeTimer(),
        probe: async () => new Map(),
        invalidateDeviceList: () => {},
      },
    });
    const selectAbsent = (source: InventorySource) =>
      select({ deviceId: ABSENT[source], sessionUuid: "selection" }).then(
        () => [`${source}:selected`],
        (error: unknown) =>
          (error as { retryable?: boolean }).retryable === true
            ? [`${source}:${codeOf(error)}`]
            : [],
      );

    const answers = {
      resource: {
        observationComplete: resource.observationComplete,
        devices: resource.devices.length,
        notApplicable: ALL_SOURCES.filter(
          (source) => resource.sourceObservations[source]?.notApplicable === true,
        ),
        incomplete: ALL_SOURCES.filter(
          (source) => resource.sourceObservations[source]?.observationComplete === false,
        ),
      },
      listDevices: {
        complete: listed.discovery.complete,
        devices: listed.devices.length,
        notApplicable: listed.discovery.notApplicableSources ?? [],
        incomplete: listed.discovery.failedSources ?? [],
      },
      getRefreshedStats: await pool.getRefreshedStats().then((stats) => stats.idle, codeOf),
      getRefreshedInventory: await pool
        .getRefreshedInventory()
        .then((inventory) => inventory.deviceIds.size, codeOf),
      daemonAvailableDevices: daemonResponse.success
        ? (daemonResponse.result as { availableDevices: number }).availableDevices
        : { code: daemonResponse.code, retryable: daemonResponse.retryable },
      cliStdio: await availableDevicesCli([], remoteState, resourceText),
      cliStdioJson: await availableDevicesCli(["--json"], remoteState, resourceText),
      cliInDaemon: await availableDevicesCli([], daemonState, resourceText),
      cliInDaemonJson: await availableDevicesCli(["--json"], daemonState, resourceText),
      // An absent serial is only an unknown when the source that would list it exists and failed.
      ideRefusesAbsentSerialOf: (
        await Promise.all(
          ALL_SOURCES.map((source) =>
            ideServer
              .lookupBootedDevicesForIde(source === "android" ? "android" : "ios", ABSENT[source])
              .then(
                () => [],
                (error: unknown) => [`${source}:${codeOf(error)}`],
              ),
          ),
        )
      ).flat(),
      // setActiveDevice is retryable only for the source that could have listed the absent id.
      setActiveDeviceRetryableFor: [
        ...(await selectAbsent("android")),
        ...(await selectAbsent("ios-simulator")),
        ...(await selectAbsent("ios-physical")),
      ],
      // Reads never hold, bind or boot: whatever was held before stays exactly that.
      heldAfterReads: pool.getStats().assigned,
      sessionsAfterReads: activeSessions.getAllSessions().length,
      boots: manager.getExecutedOperations().filter((op) => op.startsWith("startDevice")),
    };

    // A source whose tooling vanished under a pooled device exists and did not complete.
    const vanished = vanishedUnder ? [sourceOf(vanishedUnder)] : [];
    const discoveryIncomplete = ALL_SOURCES.filter(
      (source) => cell.failing.includes(source) || vanished.includes(source),
    );
    // A failed offline probe is an installed adb that failed: Android is unknown on the inventory.
    const incomplete = ALL_SOURCES.filter(
      (source) => discoveryIncomplete.includes(source) || (probeThrows && source === "android"),
    );
    const notInstalled = cell.notInstalled.filter((source) => !vanished.includes(source));
    const complete = incomplete.length === 0;
    const deviceListed =
      device !== undefined && !incomplete.some((source) => source === sourceOf(device));
    const count = deviceListed ? (held ? 0 : 1) : complete ? 0 : "unknown";
    const refusal = { exit: 1, code: "discovery_incomplete" };
    const cli = (json: boolean) =>
      count === "unknown" ? (json ? refusal : { exit: 1, stdout: [] }) : count;
    expect(answers).toEqual({
      resource: {
        observationComplete: complete,
        devices: deviceListed ? 1 : 0,
        notApplicable: notInstalled,
        incomplete,
      },
      listDevices: {
        complete,
        devices: deviceListed ? 1 : 0,
        notApplicable: notInstalled,
        incomplete,
      },
      getRefreshedStats: count === "unknown" ? "discovery_incomplete" : count,
      getRefreshedInventory: count === "unknown" ? "discovery_incomplete" : deviceListed ? 1 : 0,
      daemonAvailableDevices:
        count === "unknown" ? { code: "discovery_incomplete", retryable: true } : count,
      cliStdio: cli(false),
      cliStdioJson: cli(true),
      cliInDaemon: cli(false),
      cliInDaemonJson: cli(true),
      // The lookups read discovery, not the offline probe.
      ideRefusesAbsentSerialOf: discoveryIncomplete.map(
        (source) => `${source}:discovery_incomplete`,
      ),
      setActiveDeviceRetryableFor: discoveryIncomplete.map(
        (source) => `${source}:discovery_incomplete`,
      ),
      heldAfterReads: before.held,
      sessionsAfterReads: before.sessions,
      boots: [],
    });
    // A healthy host (nothing failing, nothing vanished) is never told discovery_incomplete.
    if (cell.failing.length === 0 && !vanishedUnder && !probeThrows) {
      expect(JSON.stringify(answers)).not.toContain("discovery_incomplete");
    }
  });
});
