import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import { DaemonState } from "../../src/daemon/daemonState";
import { DevicePool } from "../../src/daemon/devicePool";
import { DeviceSessionRegistry } from "../../src/daemon/deviceSessionRegistry";
import { DEVICE_OWNED_BY_OTHER_SESSION_CODE } from "../../src/daemon/inputDeviceOwnership";
import { RegistryManagedSlotExclusion } from "../../src/daemon/managedSlots/managedSlotExclusion";
import { DEVICE_ASSIGNED_TO_MANAGED_SLOT_CODE } from "../../src/daemon/managedSlots/managedSlotRefusal";
import { SessionManager } from "../../src/daemon/sessionManager";
import { mayControlUnheldUnidentifiedTransport } from "../../src/daemon/toolCallDeviceIdentity";
import type { BootedDevice } from "../../src/models";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { withAndroidTransportId } from "../../src/utils/androidSerial";
import { createExecResult } from "../../src/utils/execResult";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import { assignManagedSlotDevice } from "../daemon/managedSlots/managedSlotFixtures";
import { FakeAdbClientFactory } from "../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeSlotRegistry } from "../fakes/FakeSlotRegistry";
import { FakeTimer } from "../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { RealToolCallPath } from "../helpers/realToolCallPath";

/**
 * #11618: one handset on USB and wireless debugging is ONE pooled device held under its USB
 * serial. A tool call naming it by the wireless id is the same call as one naming the USB serial:
 * the MCP ingress resolves the id to the pool's canonical id before any holder, managed-slot,
 * routing or admission decision. Real `ToolRegistry` ingress, real `DevicePool` and its real alias
 * fold; only adb, discovery and the device boundary are fakes.
 */

const USB = "R5CT1234ABC";
const WIRELESS = "adb-R5CT1234ABC-AbCdEf._adb-tls-connect._tcp";
const EMULATOR = "emulator-5554";
const EMULATOR_TCP = "localhost:5555";
const HOLDER = "holder-session";
const HOLDER_CONNECTION = "holder-connection";
const STRANGER_CONNECTION = "stranger-connection";

const booted = (deviceId: string, name = deviceId): BootedDevice =>
  withAndroidTransportId({ deviceId, name, platform: "android" }, `transport-${deviceId}`);

interface HarnessOptions {
  /** The rows discovery lists when the pool first refreshes. */
  pooledRows: BootedDevice[];
  /** `ro.serialno` every transport answers with. */
  serial?: string;
  /** Set for an emulator: `ro.boot.qemu.avd_name`. */
  avd?: string;
  /** The device HOLDER acquires from HOLDER_CONNECTION; none when omitted. */
  held?: string;
  /** An idle managed slot is assigned this stable id. */
  managedSlotStableId?: string;
  iosRows?: BootedDevice[];
}

interface Harness {
  timer: FakeTimer;
  sessions: SessionManager;
  pool: DevicePool;
  tools: RealToolCallPath;
  adbFactory: FakeAdbClientFactory;
  /** Raw `adb devices` listings the ingress asked for (the first-sighting probe's scan). */
  rawScans(): number;
  /** Devices the read probe's body ran on. */
  reads: string[];
  /** Discovery starts listing `rows`, as when wireless debugging is switched on. */
  connect(rows: BootedDevice[]): void;
  outcome(name: string, args: Record<string, unknown>): Promise<string>;
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    cleanup();
  }
});

/** The typed refusal code, the error text, or "ran". */
function describeOutcome(result: unknown): string {
  if (result instanceof Error) {
    const code: unknown = Reflect.get(result, "code");
    return typeof code === "string" ? code : result.message;
  }
  return "ran";
}

async function harness(options: HarnessOptions): Promise<Harness> {
  const timer = new FakeTimer();
  const discovery = new FakeDeviceUtils();
  discovery.setBootedDevices("android", options.pooledRows);
  discovery.setBootedDevices("ios", options.iosRows ?? []);
  const adb = new FakeAdbExecutor();
  adb.setCommandResponse("getprop ro.serialno", createExecResult(options.serial ?? USB, ""));
  adb.setCommandResponse("boot_id", createExecResult("phone-boot", ""));
  adb.setCommandResponse("getprop ro.kernel.qemu", createExecResult(options.avd ? "1" : "0", ""));
  if (options.avd) {
    adb.setCommandResponse("getprop ro.boot.qemu.avd_name", createExecResult(options.avd, ""));
  }
  const adbFactory = new FakeAdbClientFactory(adb);
  // The ingress lists raw adb rows through the process-wide device manager, as the daemon does.
  PlatformDeviceManagerFactory.setInstance(discovery);
  const sessions = new SessionManager(
    timer,
    new FakeDeviceSessionPersistence(),
    () => new FakeDbWriteBarrier(),
  );
  sessions.stopCleanupTimer();
  const registry = new FakeSlotRegistry(timer);
  if (options.managedSlotStableId) {
    await assignManagedSlotDevice(registry, "android", options.managedSlotStableId, "runner-b");
  }
  const pool = new DevicePool(
    createDevicePoolDependencies(sessions, "transport-alias-ingress", {
      timer,
      deviceManager: discovery,
      installedAppsRepository: new FakeInstalledAppsRepository(),
      androidAdbFactory: adbFactory,
      ...(options.managedSlotStableId
        ? { managedSlotExclusion: new RegistryManagedSlotExclusion(async () => registry, timer) }
        : {}),
    }),
  );
  await pool.refreshDevices();
  DaemonState.getInstance().initialize(sessions, pool, new DeviceSessionRegistry(timer));
  const tools = new RealToolCallPath([...options.pooledRows, ...(options.iosRows ?? [])]).install();
  // The real session manager's scan is already mapped onto pooled ids by the pool (#11133).
  const readinessScan = (rows: BootedDevice[]) =>
    tools.deviceSessionManager.setConnectedDevices([
      ...pool.mapAndroidReadinessDiscovery(rows),
      ...(options.iosRows ?? []),
    ]);
  readinessScan(options.pooledRows);
  const reads: string[] = [];
  ToolRegistry.registerDeviceAware(
    "controlProbe",
    "Control probe",
    z.object({}).passthrough(),
    async () => ({ success: true }),
  );
  ToolRegistry.registerDeviceAware(
    "readProbe",
    "Read probe",
    z.object({}).passthrough(),
    async (device: BootedDevice) => {
      reads.push(device.deviceId);
      return { success: true };
    },
    { deviceReadOnly: true },
  );
  cleanups.push(() => {
    PlatformDeviceManagerFactory.setInstance(null);
    tools.uninstall();
    DaemonState.getInstance().reset();
    sessions.stopCleanupTimer();
    timer.reset();
  });
  if (options.held) {
    await pool.bindOrReuseDeviceSession(
      HOLDER,
      options.held,
      "android",
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      HOLDER_CONNECTION,
    );
    sessions.setDeviceReadiness(HOLDER, "automationReady");
    // Keep-awake is device work behind its own adb seam; mark it settled for this session.
    sessions.getSession(HOLDER)!.cacheData.keepScreenAwake = {
      applied: false,
      skipReason: "failed",
    };
  }
  return {
    timer,
    sessions,
    pool,
    tools,
    adbFactory,
    rawScans: () => discovery.getBootedDevicesDetailedCalls().length,
    reads,
    connect(rows) {
      discovery.setBootedDevices("android", rows);
      readinessScan(rows);
    },
    outcome: (name, args) =>
      tools.call(name, args).then(describeOutcome, (error: unknown) => describeOutcome(error)),
  };
}

const phone = () => harness({ pooledRows: [booted(USB), booted(WIRELESS)], held: USB });

describe("a tool call naming a held handset by either transport id (#11618)", () => {
  test("the pool holds the handset once, under its USB serial", async () => {
    const h = await phone();

    expect(h.pool.getAllDevices().map((device) => device.id)).toEqual([USB]);
    expect(h.pool.getAndroidTransportAliases(USB)).toEqual([WIRELESS]);
    expect(h.sessions.getSessionForDevice(USB)).toBe(HOLDER);
  });

  describe.each([
    ["canonical", USB],
    ["alias", WIRELESS],
  ])("named by its %s id", (_kind, deviceId) => {
    test("a sessionless control call is refused for the holder and is not use", async () => {
      const h = await phone();
      const before = { ...h.sessions.getSession(HOLDER)! };
      h.timer.advanceTime(5_000);

      const outcome = await h.outcome("controlProbe", { platform: "android", deviceId });

      expect(outcome).toBe(DEVICE_OWNED_BY_OTHER_SESSION_CODE);
      expect(h.tools.runs).toEqual([]);
      expect(h.tools.deviceSessionManager.getEnsureDeviceReadyCallCount()).toBe(0);
      expect(h.sessions.getSession(HOLDER)!.lastUsedAt).toBe(before.lastUsedAt);
      expect(h.sessions.getSession(HOLDER)!.expiresAt).toBe(before.expiresAt);
    });

    test("a control call from another connection is refused for the holder", async () => {
      const h = await phone();

      const outcome = await h.outcome("controlProbe", {
        platform: "android",
        deviceId,
        __mcpSessionId: STRANGER_CONNECTION,
      });

      expect(outcome).toBe(DEVICE_OWNED_BY_OTHER_SESSION_CODE);
      expect(h.tools.runs).toEqual([]);
    });

    test("a control call under another session is refused and is not that session's use", async () => {
      const h = await phone();
      await h.sessions.createSession("other-session", "OTHER-DEVICE", "android");
      const before = h.sessions.getSession(HOLDER)!.lastUsedAt;
      h.timer.advanceTime(5_000);

      const outcome = await h.outcome("controlProbe", { sessionUuid: "other-session", deviceId });

      expect(outcome).toBe(DEVICE_OWNED_BY_OTHER_SESSION_CODE);
      expect(h.tools.runs).toEqual([]);
      expect(h.sessions.getSession(HOLDER)!.lastUsedAt).toBe(before);
    });

    test("the holder's call naming its session runs on the one pooled device", async () => {
      const h = await phone();

      const outcome = await h.outcome("controlProbe", { sessionUuid: HOLDER, deviceId });

      expect(outcome).toBe("ran");
      expect(h.tools.runs).toEqual([{ name: "controlProbe", deviceId: USB, sessionUuid: HOLDER }]);
    });

    test("the holder connection's deviceId-only call runs as its session", async () => {
      const h = await phone();

      const outcome = await h.outcome("controlProbe", {
        deviceId,
        __mcpSessionId: HOLDER_CONNECTION,
      });

      expect(outcome).toBe("ran");
      expect(h.tools.runs).toEqual([{ name: "controlProbe", deviceId: USB, sessionUuid: HOLDER }]);
    });

    test("a read works, reads the pooled device, and holds, binds and extends nothing", async () => {
      const h = await phone();
      const before = { ...h.sessions.getSession(HOLDER)! };
      const sessionsBefore = h.sessions.getAllSessions().map((session) => session.sessionId);
      h.timer.advanceTime(5_000);

      const outcome = await h.outcome("readProbe", {
        platform: "android",
        deviceId,
        __mcpSessionId: STRANGER_CONNECTION,
      });

      expect(outcome).toBe("ran");
      expect(h.reads).toEqual([USB]);
      expect(h.sessions.getSession(HOLDER)!.lastUsedAt).toBe(before.lastUsedAt);
      expect(h.sessions.getSession(HOLDER)!.expiresAt).toBe(before.expiresAt);
      expect(h.sessions.getAllSessions().map((session) => session.sessionId)).toEqual(
        sessionsBefore,
      );
      expect(h.sessions.getSessionForDevice(USB)).toBe(HOLDER);
    });

    test("a plan step (callInternal) is refused for a stranger and runs for the holder", async () => {
      const h = await phone();

      const refused = await ToolRegistry.callInternal("controlProbe", {
        platform: "android",
        deviceId,
      }).then(describeOutcome, describeOutcome);
      const ran = await ToolRegistry.callInternal(
        "controlProbe",
        { deviceId },
        undefined,
        undefined,
        { sessionUuid: HOLDER },
      ).then(describeOutcome, describeOutcome);

      expect(refused).toBe(DEVICE_OWNED_BY_OTHER_SESSION_CODE);
      expect(ran).toBe("ran");
      expect(h.tools.runs).toEqual([{ name: "controlProbe", deviceId: USB, sessionUuid: HOLDER }]);
    });
  });

  test("every control device tool decides the same for the alias as for the canonical id", async () => {
    const h = await phone();
    // Control tools only: a refused control call does no device work. Read bodies are real device
    // code here, so reads are covered by the read probe above and `observe` below.
    const controlTools = ToolRegistry.getAllTools().filter(
      (tool) =>
        tool.requiresDevice && !tool.isDeviceReadOnlyCall?.({ platform: "android", deviceId: USB }),
    );
    expect(controlTools.length).toBeGreaterThan(10);

    const decisions: Array<[string, string, string]> = [];
    for (const tool of controlTools) {
      const byCanonical = await h.outcome(tool.name, { platform: "android", deviceId: USB });
      const byAlias = await h.outcome(tool.name, { platform: "android", deviceId: WIRELESS });
      decisions.push([tool.name, byCanonical, byAlias]);
    }

    expect(
      decisions.filter(
        ([, canonical, alias]) =>
          canonical !== DEVICE_OWNED_BY_OTHER_SESSION_CODE || alias !== canonical,
      ),
    ).toEqual([]);
    expect(h.tools.runs).toEqual([]);
  });

  test("observe by either id watches the one pooled device", async () => {
    const h = await phone();

    const byCanonical = await h.outcome("observe", { platform: "android", deviceId: USB });
    const byAlias = await h.outcome("observe", { platform: "android", deviceId: WIRELESS });

    expect([byCanonical, byAlias]).toEqual(["ran", "ran"]);
    expect(h.tools.watcherReads).toEqual([USB, USB]);
    expect(h.tools.runs).toEqual([]);
  });

  test("setActiveDevice from a stranger is refused the same for either id", async () => {
    const h = await phone();
    const attempt = (deviceId: string) =>
      ToolRegistry.callInternal("setActiveDevice", {
        deviceId,
        platform: "android",
        sessionUuid: "stranger-session",
      }).then(describeOutcome, describeOutcome);

    const byCanonical = await attempt(USB);
    const byAlias = await attempt(WIRELESS);

    expect(byCanonical).not.toBe("ran");
    expect(byAlias).toBe(byCanonical);
    expect(h.sessions.getSessionForDevice(USB)).toBe(HOLDER);
  });

  test("killDevice and startDevice-by-serial receive the canonical id on the plan step path", async () => {
    await phone();
    const received: unknown[] = [];
    for (const name of ["killDevice", "startDevice"]) {
      ToolRegistry.register(name, name, z.object({}).passthrough(), async (args) => {
        received.push(args);
        return { success: true };
      });
    }

    await ToolRegistry.callInternal("killDevice", {
      device: { name: "Phone", deviceId: WIRELESS, platform: "android" },
    });
    await ToolRegistry.callInternal("startDevice", { platform: "android", deviceId: WIRELESS });

    expect(received).toMatchObject([
      { device: { name: "Phone", deviceId: USB, platform: "android" } },
      { platform: "android", deviceId: USB },
    ]);
  });
});

describe("a transport the pool has not folded yet (#11618)", () => {
  test("a wireless id first seen on a control call is folded before the holder check", async () => {
    const h = await harness({ pooledRows: [booted(USB)], held: USB });
    expect(h.pool.getAndroidTransportAliases(USB)).toEqual([]);
    // Wireless debugging is switched on; no pool refresh has run since.
    h.connect([booted(USB), booted(WIRELESS)]);

    const outcome = await h.outcome("controlProbe", { platform: "android", deviceId: WIRELESS });

    expect(outcome).toBe(DEVICE_OWNED_BY_OTHER_SESSION_CODE);
    expect(h.tools.runs).toEqual([]);
    expect(h.tools.deviceSessionManager.getEnsureDeviceReadyCallCount()).toBe(0);
    expect(h.pool.getAndroidTransportAliases(USB)).toEqual([WIRELESS]);
    expect(h.pool.getAllDevices().map((device) => device.id)).toEqual([USB]);
  });

  test("the holder's own first call by the new wireless id runs as its session", async () => {
    const h = await harness({ pooledRows: [booted(USB)], held: USB });
    h.connect([booted(USB), booted(WIRELESS)]);

    const outcome = await h.outcome("controlProbe", {
      deviceId: WIRELESS,
      __mcpSessionId: HOLDER_CONNECTION,
    });

    expect(outcome).toBe("ran");
    expect(h.tools.runs).toEqual([{ name: "controlProbe", deviceId: USB, sessionUuid: HOLDER }]);
  });

  test("a read by an unfolded wireless id probes nothing", async () => {
    const h = await harness({ pooledRows: [booted(USB)], held: USB });
    h.connect([booted(USB), booted(WIRELESS)]);
    const probes = h.adbFactory.getCallCount();

    await h.outcome("readProbe", { platform: "android", deviceId: WIRELESS });

    expect(h.adbFactory.getCallCount()).toBe(probes);
    expect(h.pool.getAndroidTransportAliases(USB)).toEqual([]);
  });

  test("a folded alias costs no adb call per tool call", async () => {
    const h = await phone();
    const probes = h.adbFactory.getCallCount();
    const scans = h.tools.deviceSessionManager.getDetectConnectedPlatformsCallCount();
    const rawScans = h.rawScans();

    await h.outcome("controlProbe", { platform: "android", deviceId: WIRELESS });
    await h.outcome("controlProbe", { sessionUuid: HOLDER, deviceId: WIRELESS });
    await h.outcome("controlProbe", { sessionUuid: HOLDER, deviceId: USB });

    expect(h.adbFactory.getCallCount()).toBe(probes);
    expect(h.tools.deviceSessionManager.getDetectConnectedPlatformsCallCount()).toBe(scans);
    expect(h.rawScans()).toBe(rawScans);
  });

  test("a refused first-sighting call leaves the holder's dispatch route where it was", async () => {
    const TCP = "192.168.1.20:5555";
    const h = await harness({ pooledRows: [booted(USB), booted(TCP)], held: USB });
    expect(h.pool.getAndroidTransportAliases(USB)).toEqual([TCP]);
    // The same phone also appears under its mDNS id; adb lists the USB row first.
    const rows = [booted(USB), booted(TCP), booted(WIRELESS)];
    h.connect(rows);
    const rawScans = h.rawScans();

    const outcome = await h.outcome("controlProbe", { platform: "android", deviceId: WIRELESS });

    expect(outcome).toBe(DEVICE_OWNED_BY_OTHER_SESSION_CODE);
    // The fold is fed one fresh RAW listing, not the readiness scan's pool-mapped rows.
    expect(h.rawScans()).toBe(rawScans + 1);
    expect(h.pool.getAndroidTransportAliases(USB).toSorted()).toEqual([TCP, WIRELESS].toSorted());
    // The next readiness scan re-routes a group from its live rows: USB is live, so it stays.
    h.pool.mapAndroidReadinessDiscovery(rows);
    expect(h.pool.getAndroidTransportRouting().resolveTransport(USB)).toBe(USB);
    // And when Wi-Fi drops with the cable still attached, dispatch is still on USB.
    h.pool.mapAndroidReadinessDiscovery([booted(USB)]);
    expect(h.pool.getAndroidTransportRouting().resolveTransport(USB)).toBe(USB);
  });
});

describe("an unheld device on a transport the pool cannot identify (open owner decision)", () => {
  test("the predicate that carries the decision allows it today", () => {
    expect(mayControlUnheldUnidentifiedTransport()).toBe(true);
  });

  test("a control call on a wireless phone with a generic serial is allowed, as before", async () => {
    // A generic factory serial proves nothing, so the pool neither pools nor aliases the row.
    const h = await harness({ pooledRows: [booted(WIRELESS)], serial: "unknown" });
    expect(h.pool.getAllDevices()).toEqual([]);
    expect(h.pool.isAndroidTransportAssignable(booted(WIRELESS))).toBe(false);

    const outcome = await h.outcome("controlProbe", { platform: "android", deviceId: WIRELESS });

    expect(outcome).toBe("ran");
    expect(h.tools.runs).toEqual([
      { name: "controlProbe", deviceId: WIRELESS, sessionUuid: undefined },
    ]);
  });

  test("an unidentified transport is probed by the first call only, not on every call", async () => {
    const h = await harness({ pooledRows: [booted(WIRELESS)], serial: "unknown" });
    const call = () => h.outcome("controlProbe", { platform: "android", deviceId: WIRELESS });
    const beforeFirst = h.adbFactory.getCallCount();

    await call();
    const afterFirst = h.adbFactory.getCallCount();
    await call();
    await call();

    expect(afterFirst).toBeGreaterThan(beforeFirst);
    expect(h.adbFactory.getCallCount()).toBe(afterFirst);
    expect(h.tools.runs).toHaveLength(3);
  });

  test("two phones reporting the same generic serial are never folded into one", async () => {
    const generic = "0123456789abcdef";
    const h = await harness({
      pooledRows: [booted(generic), booted(WIRELESS)],
      serial: generic,
      held: generic,
    });
    expect(h.pool.getAllDevices().map((device) => device.id)).toEqual([generic]);

    const onOtherPhone = await h.outcome("controlProbe", {
      platform: "android",
      deviceId: WIRELESS,
    });
    const onHeldPhone = await h.outcome("controlProbe", { platform: "android", deviceId: generic });

    // The wireless phone is not provably the held one: today's behaviour, behind the predicate.
    expect(onOtherPhone).toBe("ran");
    expect(h.tools.runs).toEqual([
      { name: "controlProbe", deviceId: WIRELESS, sessionUuid: undefined },
    ]);
    expect(onHeldPhone).toBe(DEVICE_OWNED_BY_OTHER_SESSION_CODE);
    expect(h.pool.getAndroidTransportAliases(generic)).toEqual([]);
  });
});

describe("devices the alias fold does not concern (#11618)", () => {
  test("an emulator's loopback adb address is its console serial for a managed slot", async () => {
    const h = await harness({
      pooledRows: [booted(EMULATOR, "Pixel"), booted(EMULATOR_TCP)],
      avd: "Pixel",
      managedSlotStableId: "Pixel",
    });
    expect(h.pool.getAllDevices().map((device) => device.id)).toEqual([EMULATOR]);

    const byCanonical = await h.outcome("controlProbe", {
      platform: "android",
      deviceId: EMULATOR,
    });
    const byAlias = await h.outcome("controlProbe", {
      platform: "android",
      deviceId: EMULATOR_TCP,
    });
    const readByAlias = await h.outcome("readProbe", {
      platform: "android",
      deviceId: EMULATOR_TCP,
    });

    expect(byCanonical).toBe(DEVICE_ASSIGNED_TO_MANAGED_SLOT_CODE);
    expect(byAlias).toBe(DEVICE_ASSIGNED_TO_MANAGED_SLOT_CODE);
    // #11641: even an idle managed slot's device is read-only, on the canonical device, without readiness.
    expect(readByAlias).toBe("ran");
    expect(h.reads).toEqual([EMULATOR]);
    expect(h.tools.runs).toEqual([]);
    expect(h.tools.deviceSessionManager.getEnsureDeviceReadyCallCount()).toBe(0);
  });

  test("an iOS id is passed through untouched and never probed", async () => {
    const simulator: BootedDevice = { deviceId: "IOS-UDID-1", name: "iPhone", platform: "ios" };
    const h = await harness({ pooledRows: [booted(USB)], iosRows: [simulator] });
    const probes = h.adbFactory.getCallCount();

    const outcome = await h.outcome("controlProbe", { platform: "ios", deviceId: "IOS-UDID-1" });
    const untyped = await h.outcome("controlProbe", { deviceId: "IOS-UDID-1" });

    expect([outcome, untyped]).toEqual(["ran", "ran"]);
    expect(h.tools.runs.map((run) => run.deviceId)).toEqual(["IOS-UDID-1", "IOS-UDID-1"]);
    expect(h.adbFactory.getCallCount()).toBe(probes);
  });
});
