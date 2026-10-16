import { z } from "zod/v4";
import { DaemonState } from "../../src/daemon/daemonState";
import { DevicePool } from "../../src/daemon/devicePool";
import { DeviceSessionRegistry } from "../../src/daemon/deviceSessionRegistry";
import { RegistryBindingExclusion } from "../../src/daemon/sessionBroker/provisioning/exclusion";
import { SessionManager } from "../../src/daemon/sessionManager";
import type { BootedDevice } from "../../src/models";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { withAndroidTransportId } from "../../src/utils/androidSerial";
import { createExecResult } from "../../src/utils/execResult";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import { assignBindingDevice } from "../daemon/sessionBroker/provisioning/bindingFixtures";
import { FakeAdbClientFactory } from "../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeBindingRegistry } from "../fakes/FakeBindingRegistry";
import { FakeTimer } from "../fakes/FakeTimer";
import { createDevicePoolDependencies } from "./devicePoolDependencies";
import { RealToolCallPath } from "./realToolCallPath";

/**
 * #11618: one handset on USB and wireless debugging is ONE pooled device held under its USB
 * serial. A tool call naming it by the wireless id is the same call as one naming the USB serial:
 * the MCP ingress resolves the id to the pool's canonical id before any holder, broker-binding,
 * routing or admission decision. Real `ToolRegistry` ingress, real `DevicePool` and its real alias
 * fold; only adb, discovery and the device boundary are fakes.
 */

export const USB = "R5CT1234ABC";
export const WIRELESS = "adb-R5CT1234ABC-AbCdEf._adb-tls-connect._tcp";
export const EMULATOR = "emulator-5554";
export const EMULATOR_TCP = "localhost:5555";
export const HOLDER = "holder-session";
export const HOLDER_CONNECTION = "holder-connection";
export const STRANGER_CONNECTION = "stranger-connection";

export const booted = (deviceId: string, name = deviceId): BootedDevice =>
  withAndroidTransportId({ deviceId, name, platform: "android" }, `transport-${deviceId}`);

export interface HarnessOptions {
  /** The rows discovery lists when the pool first refreshes. */
  pooledRows: BootedDevice[];
  /** `ro.serialno` every transport answers with. */
  serial?: string;
  /** Set for an emulator: `ro.boot.qemu.avd_name`. */
  avd?: string;
  /** The device HOLDER acquires from HOLDER_CONNECTION; none when omitted. */
  held?: string;
  /** An idle broker binding is assigned this stable id. */
  bindingStableId?: string;
  iosRows?: BootedDevice[];
}

export interface Harness {
  discovery: FakeDeviceUtils;
  adb: FakeAdbExecutor;
  dispose(): void;
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

/** The typed refusal code, the error text, or "ran". */
export function describeOutcome(result: unknown): string {
  if (result instanceof Error) {
    const code: unknown = Reflect.get(result, "code");
    return typeof code === "string" ? code : result.message;
  }
  return "ran";
}

export async function transportAliasHarness(
  options: HarnessOptions,
  cleanups: Array<() => void>,
): Promise<Harness> {
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
  const sessions = new SessionManager(timer, new FakeDeviceSessionPersistence(), {
    barrier: () => new FakeDbWriteBarrier(),
  });
  sessions.stopCleanupTimer();
  const tools = new RealToolCallPath([...options.pooledRows, ...(options.iosRows ?? [])]);
  const registryTimer: unknown = Reflect.get(ToolRegistry, "timer");
  const dispose = () => {
    PlatformDeviceManagerFactory.setInstance(null);
    tools.uninstall();
    Reflect.set(ToolRegistry, "timer", registryTimer);
    DaemonState.getInstance().reset();
    sessions.stopCleanupTimer();
    timer.reset();
  };
  // The caller owns teardown even if refresh, singleton initialization or tool install throws.
  cleanups.push(dispose);
  // The ingress lists raw adb rows through the process-wide device manager, as the daemon does.
  PlatformDeviceManagerFactory.setInstance(discovery);
  Reflect.set(ToolRegistry, "timer", timer);
  const registry = new FakeBindingRegistry(timer);
  if (options.bindingStableId) {
    await assignBindingDevice(registry, "android", options.bindingStableId, "runner-b");
  }
  const pool = new DevicePool(
    createDevicePoolDependencies(sessions, "transport-alias-ingress", {
      timer,
      deviceManager: discovery,
      installedAppsRepository: new FakeInstalledAppsRepository(),
      androidAdbFactory: adbFactory,
      ...(options.bindingStableId
        ? { bindingExclusion: new RegistryBindingExclusion(async () => registry, timer) }
        : {}),
    }),
  );
  await pool.refreshDevices();
  DaemonState.getInstance().initialize(sessions, pool, new DeviceSessionRegistry(timer));
  tools.install();
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
    discovery,
    adb,
    dispose,
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
