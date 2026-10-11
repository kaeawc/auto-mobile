import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { runDaemonCommand } from "../../src/daemon/cli/runDaemonCommand";
import { handleDaemonRequest } from "../../src/daemon/daemonRequestHandlers";
import { DaemonState, type DaemonStateLike } from "../../src/daemon/daemonState";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import type { BootedDevice } from "../../src/models";
import {
  getBootedDevicesForPlatforms,
  resetBootedDevicesResourceCache,
  setDeviceManager,
} from "../../src/server/bootedDeviceResources";
import type { DiscoverySource } from "../../src/utils/discoverySource";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import { DefaultRetryExecutor } from "../../src/utils/retry/RetryExecutor";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../fakes/FakeTimer";
import { SafeDaemonManager } from "../fakes/SafeDaemonManager";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";

// Inventory contract (#11643): every `available-devices` surface gives the same answer for the
// same host state. The count is unknown (`discovery_incomplete`) exactly when a pooled device's
// own discovery source exists and did not complete; a failed or not-installed source no pooled
// device depends on leaves the count exact (#11605).

const simulator: BootedDevice = {
  platform: "ios",
  name: "iPhone 17",
  deviceId: "11111111-2222-3333-4444-555555555555",
};
const phone: BootedDevice = {
  platform: "ios",
  name: "Test iPhone",
  deviceId: "00008110-001A2B3C4D5E6F78",
};

const unexpectedRemoteCall = (): never => {
  throw new Error("Unexpected daemon operation");
};
/** The CLI outside the daemon process: it answers from the booted-devices resource. */
const remoteState: DaemonStateLike = {
  isInitialized: () => false,
  getSessionManager: unexpectedRemoteCall,
  getDevicePool: unexpectedRemoteCall,
  getDeviceSessionRegistry: unexpectedRemoteCall,
};

/** `--daemon available-devices --json`, reduced to the count it printed or its refusal code. */
async function availableDevicesCli(state: DaemonStateLike, resourceText: string): Promise<unknown> {
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
    await runDaemonCommand("available-devices", ["--json"], {}, Manager).catch(() => {});
  } finally {
    exit.mockRestore();
    errorSpy.mockRestore();
    log.mockRestore();
  }
  const printed = JSON.parse(stdout[0] ?? "{}") as { availableDevices?: number; code?: string };
  return exits.length === 0 ? printed.availableDevices : printed.code;
}

describe("available-devices gives one answer per pooled discovery-source outcome", () => {
  let sessions: SessionManager | undefined;

  afterEach(() => {
    DaemonState.getInstance().reset();
    sessions?.stopCleanupTimer();
    resetBootedDevicesResourceCache();
    setDeviceManager(null);
    PlatformDeviceManagerFactory.setInstance(null);
  });

  /** Pool `pooled` while every source works, then break sources and ask every surface. */
  async function answers(input: {
    pooled: BootedDevice[];
    /** What discovery returns once the sources below stop answering. */
    stillListed: BootedDevice[];
    failed?: DiscoverySource[];
    notInstalled?: DiscoverySource[];
  }) {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const manager = new FakeDeviceUtils();
    manager.setBootedDevices("android", []);
    manager.setBootedDevices("ios", input.pooled);
    const activeSessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
    sessions = activeSessions;
    const pool = new DevicePool(
      createDevicePoolDependencies(activeSessions, "available-devices-source-outcome", {
        timer,
        deviceManager: manager,
        retryExecutor: new DefaultRetryExecutor(timer),
        installedAppsRepository: new FakeInstalledAppsRepository(),
      }),
    );
    await pool.initializeWithDevices(input.pooled);

    manager.setBootedDevices("ios", input.stillListed);
    manager.failedSources = new Set(input.failed);
    manager.notInstalledSources = new Set(input.notInstalled);
    DaemonState.getInstance().initialize(activeSessions, pool);
    setDeviceManager(manager);
    PlatformDeviceManagerFactory.setInstance(manager);

    const resource = await getBootedDevicesForPlatforms(["android", "ios"], timer);
    const resourceText = JSON.stringify(resource);
    const codeOf = (error: unknown) => (error as { code?: string }).code ?? "untyped";
    const daemonResponse = await handleDaemonRequest(
      { id: "r", type: "daemon_request", method: "daemon/availableDevices", params: {} },
      {
        isInitialized: () => true,
        getSessionManager: () => activeSessions as never,
        getDevicePool: () => pool,
        getDeviceSessionRegistry: () => ({ list: () => [] }),
      },
    );
    return {
      resource,
      surfaces: {
        poolStats: await pool.getRefreshedStats().then((stats) => stats.idle, codeOf),
        daemonAvailableDevices: daemonResponse.success
          ? (daemonResponse.result as { availableDevices: number }).availableDevices
          : daemonResponse.code,
        cliInDaemon: await availableDevicesCli(DaemonState.getInstance(), resourceText),
        cliThroughResource: await availableDevicesCli(remoteState, resourceText),
      },
    };
  }

  const everySurface = (answer: unknown) => ({
    poolStats: answer,
    daemonAvailableDevices: answer,
    cliInDaemon: answer,
    cliThroughResource: answer,
  });

  test("simctl fails while devicectl still lists a pooled iPhone: the count is unknown everywhere", async () => {
    // Whether the pooled simulator is still booted is unknown, so the available count is too:
    // the listed phone alone is not the answer, and neither is the pool's stale tally of two.
    const { resource, surfaces } = await answers({
      pooled: [simulator, phone],
      stillListed: [simulator, phone],
      failed: ["ios-simulator"],
    });

    expect(resource.devices.map((device) => device.runtime.deviceId)).toEqual([phone.deviceId]);
    expect(resource.observationComplete).toBe(false);
    expect(resource.poolStatus).toMatchObject({
      idle: 1,
      countUnknown: { code: "discovery_incomplete", platforms: ["ios"] },
    });
    expect(surfaces).toEqual(everySurface("discovery_incomplete"));
  });

  test("a failed source no pooled device depends on leaves the count exact everywhere", async () => {
    // devicectl timed out; the pool holds simulators only and simctl listed one of them. The
    // other shut down: it is a phantom, never part of a stale tally.
    const gone: BootedDevice = { ...simulator, deviceId: "99999999-2222-3333-4444-555555555555" };
    const { resource, surfaces } = await answers({
      pooled: [simulator, gone],
      stillListed: [simulator],
      failed: ["ios-physical"],
    });

    expect(resource.observationComplete).toBe(false);
    expect(resource.poolStatus).toMatchObject({ idle: 1, total: 1 });
    expect(resource.poolStatus?.countUnknown).toBeUndefined();
    expect(surfaces).toEqual(everySurface(1));
  });

  test("tooling that is not installed is not an unknown count", async () => {
    // No devicectl on this host and no pooled device that came through it (#11605).
    const { resource, surfaces } = await answers({
      pooled: [simulator],
      stillListed: [simulator],
      notInstalled: ["ios-physical"],
    });

    expect(resource.observationComplete).toBe(true);
    expect(resource.poolStatus?.countUnknown).toBeUndefined();
    expect(surfaces).toEqual(everySurface(1));
  });
});
