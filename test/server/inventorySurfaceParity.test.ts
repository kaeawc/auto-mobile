import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { runDaemonCommand } from "../../src/daemon/cli/runDaemonCommand";
import { handleDaemonRequest } from "../../src/daemon/daemonRequestHandlers";
import { DaemonState, type DaemonStateLike } from "../../src/daemon/daemonState";
import { DevicePool } from "../../src/daemon/devicePool";
import type { ForeignDeviceOwnership } from "../../src/daemon/foreignDeviceOwnership";
import { RegistryManagedSlotExclusion } from "../../src/daemon/managedSlots/managedSlotExclusion";
import { SessionManager } from "../../src/daemon/sessionManager";
import { UnixSocketServer } from "../../src/daemon/socketServer";
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
import { createSetActiveDeviceHandler } from "../../src/server/setActiveDevice";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { type DiscoverySource, discoverySourceFor } from "../../src/utils/discoverySource";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import { DefaultRetryExecutor } from "../../src/utils/retry/RetryExecutor";
import { assignManagedSlotDevice } from "../daemon/managedSlots/managedSlotFixtures";
import { FakeAdbClientFactory } from "../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { SafeDaemonManager } from "../fakes/SafeDaemonManager";
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

// Inventory contract (#11605): one rule on every surface. A discovery source whose tooling is not
// installed on this host is NOT APPLICABLE: it never makes an observation incomplete, is never
// retryable, and its device count is a true zero. A source that exists and failed is INCOMPLETE:
// the answer is unknown (`discovery_incomplete`, retryable), never zero. A single-platform machine
// is a fully supported configuration.

const simulator: BootedDevice = {
  platform: "ios",
  name: "iPhone 17",
  deviceId: "11111111-2222-3333-4444-555555555555",
};
const ABSENT = {
  android: "emulator-5999",
  "ios-simulator": "99999999-2222-3333-4444-555555555555",
  "ios-physical": "00008110-001A2B3C4D5E6F78",
} as const;
const ALL_SOURCES: DiscoverySource[] = ["android", "ios-simulator", "ios-physical"];

interface Host {
  host: string;
  notInstalled: DiscoverySource[];
  failing: DiscoverySource[];
  /**
   * A device pooled (and held) before its tooling began reporting "not installed" -- adb replaced
   * mid-upgrade, the active Xcode switched. The pooled entry proves the tooling existed, so the
   * source is unknown, never a true zero.
   */
  vanishedUnder?: BootedDevice;
}

const hosts: Host[] = [
  { host: "both platforms installed", notInstalled: [], failing: [] },
  { host: "Android-only", notInstalled: ["ios-simulator", "ios-physical"], failing: [] },
  { host: "iOS-only", notInstalled: ["android"], failing: [] },
  { host: "devicectl missing", notInstalled: ["ios-physical"], failing: [] },
  { host: "adb installed but failing", notInstalled: [], failing: ["android"] },
  { host: "simctl installed but failing", notInstalled: [], failing: ["ios-simulator"] },
  { host: "everything failing", notInstalled: [], failing: ALL_SOURCES },
];

const hostCells: Array<Host & { booted: string }> = [
  ...hosts.flatMap((host) =>
    (["nothing booted", "one device booted"] as const).map((booted) => ({ ...host, booted })),
  ),
  {
    host: "adb disappears",
    notInstalled: ["android"],
    failing: [],
    vanishedUnder: android,
    booted: "under a held emulator",
  },
  {
    host: "Xcode disappears",
    notInstalled: ["ios-simulator", "ios-physical"],
    failing: [],
    vanishedUnder: simulator,
    booted: "under a held simulator",
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

  test.each(hostCells)("$host, $booted", async (cell) => {
    const { booted, vanishedUnder } = cell;
    // Tooling that vanished under a pooled device is an existing source that did not complete.
    const vanished = vanishedUnder
      ? [discoverySourceFor(vanishedUnder.platform, vanishedUnder.deviceId)]
      : [];
    const failing = [...cell.failing, ...vanished];
    const notInstalled = cell.notInstalled.filter((source) => !vanished.includes(source));
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const manager = new FakeDeviceUtils();
    // The booted device sits on a source that works on this host; when every source fails it is a
    // pooled emulator the daemon saw before the failure began.
    const usable = (source: DiscoverySource) =>
      !notInstalled.includes(source) && !failing.includes(source);
    const device =
      vanishedUnder ??
      (booted === "nothing booted"
        ? undefined
        : usable("android") || !usable("ios-simulator")
          ? android
          : simulator);
    manager.setBootedDevices("android", device?.platform === "android" ? [device] : []);
    manager.setBootedDevices("ios", device?.platform === "ios" ? [device] : []);
    const activeSessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
    sessions = activeSessions;
    const pool = poolFor({ timer, sessions: activeSessions, manager });
    await pool.initializeWithDevices(device ? [device] : []);
    if (vanishedUnder) {
      await pool.assignDeviceToSession("session-held", vanishedUnder.platform);
      manager.setBootedDevices(vanishedUnder.platform, []);
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

    const resource = await getBootedDevicesForPlatforms(["android", "ios"], timer);
    const resourceText = JSON.stringify(resource);
    const listed = JSON.parse(
      (await ToolRegistry.getTool("listDevices")!.handler({})).content?.[0]?.text ?? "{}",
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
    const ideLookup = (
      UnixSocketServer.prototype as unknown as {
        listBootedDevicesForIdeAction(p: "android" | "ios", serial: string): Promise<unknown>;
      }
    ).listBootedDevicesForIdeAction;
    const select = createSetActiveDeviceHandler({ resumeCtrlProxy: async () => {} });

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
            ideLookup
              .call({ daemonState }, source === "android" ? "android" : "ios", ABSENT[source])
              .then(
                () => [],
                (error: unknown) => [`${source}:${codeOf(error)}`],
              ),
          ),
        )
      ).flat(),
      // setActiveDevice types its refresh refusal by the Android source only (#11586 refines the
      // attribution); tooling that is not installed must never make it retryable.
      setActiveDevice: await select({ deviceId: ABSENT.android, sessionUuid: "selection" }).then(
        () => "selected",
        (error: unknown) =>
          (error as { retryable?: boolean }).retryable === true ? codeOf(error) : "not found",
      ),
      // Reads never hold, bind or boot.
      heldAfterReads: pool.getStats().assigned,
      sessionsAfterReads: activeSessions.getAllSessions().length,
      boots: manager.getExecutedOperations().filter((op) => op.startsWith("startDevice")),
    };

    const complete = failing.length === 0;
    const deviceListed =
      device !== undefined &&
      !failing.includes(discoverySourceFor(device.platform, device.deviceId));
    const count = deviceListed ? 1 : complete ? 0 : "unknown";
    const listedDevices = deviceListed ? 1 : 0;
    const refusal = { exit: 1, code: "discovery_incomplete" };
    const cli = (json: boolean) =>
      count === "unknown" ? (json ? refusal : { exit: 1, stdout: [] }) : count;
    expect(answers).toEqual({
      resource: {
        observationComplete: complete,
        devices: listedDevices,
        notApplicable: notInstalled,
        incomplete: failing,
      },
      listDevices: {
        complete,
        devices: listedDevices,
        notApplicable: notInstalled,
        incomplete: failing,
      },
      getRefreshedStats: count === "unknown" ? "discovery_incomplete" : count,
      getRefreshedInventory: count === "unknown" ? "discovery_incomplete" : count,
      daemonAvailableDevices:
        count === "unknown" ? { code: "discovery_incomplete", retryable: true } : count,
      cliStdio: cli(false),
      cliStdioJson: cli(true),
      cliInDaemon: cli(false),
      cliInDaemonJson: cli(true),
      ideRefusesAbsentSerialOf: failing.map((source) => `${source}:discovery_incomplete`),
      // The refresh outcome exempts every `unavailable` Android error, pooled or not (#11586 owns it).
      setActiveDevice: cell.failing.includes("android") ? "discovery_incomplete" : "not found",
      // A held device stays held however the reads answered; nothing else is ever bound.
      heldAfterReads: vanishedUnder ? 1 : 0,
      sessionsAfterReads: vanishedUnder ? 1 : 0,
      boots: [],
    });
  });
});
