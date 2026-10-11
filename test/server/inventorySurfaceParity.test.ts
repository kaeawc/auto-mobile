import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { runDaemonCommand } from "../../src/daemon/cli/runDaemonCommand";
import {
  handleDaemonRequest,
  type DaemonStateAccess,
} from "../../src/daemon/daemonRequestHandlers";
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
import { SafeDaemonManager } from "../fakes/SafeDaemonManager";
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
  const tool = JSON.parse(response.content?.[0]?.text ?? "{}") as { devices: Entry[] };
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
    resource: resource.devices as unknown as Entry[],
    resourcePool: resource.poolStatus,
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
      await pool.bindOrReuseDeviceSession(
        "session-held",
        scenario.device.deviceId,
        scenario.platform,
      );
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
      expect(row!.runtime.poolStatus).toBe(scenario.row.poolStatus);
      expect((row!.runtime.session as { sessionUuid: string }).sessionUuid).toBe("session-held");
      expect(row!.runtime.readiness).toEqual({ state: "not_ready" });
      if (scenario.row.lifecycle) {
        expect(row!.runtime.lifecycle).toEqual({ state: scenario.row.lifecycle, known: true });
      }
      expect(row!.runtime.simulatorState).toBe(scenario.row.simulatorState);
      expect(row!.runtime.connection).toEqual(scenario.row.connection);
    }

    if (scenario.counts === "unknown") {
      // A count that cannot be established is refused on every counting surface, never zero.
      expect(reads.stats).toEqual({ error: "discovery_incomplete" });
      expect(reads.daemon.success).toBe(false);
      expect(String(reads.daemon.error)).toContain("discovery_incomplete");
      expect(reads.cli.exits).toEqual([1]);
      return;
    }
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
