import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { runDaemonCommand } from "../../../src/daemon/cli/runDaemonCommand";
import { handleDaemonRequest } from "../../../src/daemon/daemonRequestHandlers";
import { DaemonState, type DaemonStateLike } from "../../../src/daemon/daemonState";
import { DevicePool } from "../../../src/daemon/devicePool";
import { SessionManager } from "../../../src/daemon/sessionManager";
import type { BootedDevice } from "../../../src/models";
import {
  getBootedDevicesForPlatforms,
  resetBootedDevicesResourceCache,
  setDeviceManager,
} from "../../../src/server/bootedDeviceResources";
import {
  registerDeviceTools,
  resetDeviceToolsDependencies,
  setDeviceToolsDependencies,
} from "../../../src/server/deviceTools";
import { ToolRegistry } from "../../../src/server/toolRegistry";
import { PlatformDeviceManagerFactory } from "../../../src/utils/factories/PlatformDeviceManagerFactory";
import { DefaultRetryExecutor } from "../../../src/utils/retry/RetryExecutor";
import { FakeDaemonClient } from "../../fakes/FakeDaemonClient";
import { FakeDeviceSessionPersistence } from "../../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../../fakes/FakeDeviceUtils";
import { FakeInstalledAppsRepository } from "../../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../../fakes/FakeTimer";
import { SafeDaemonManager } from "../../fakes/SafeDaemonManager";
import { createDevicePoolDependencies } from "../../helpers/devicePoolDependencies";

// Inventory contract: every surface gives the same answer for the same host state, and an unknown
// count is refused (`discovery_incomplete`), never reported as a number.
//
// Host: a Mac with one pooled simulator and one pooled iPhone, both idle. `simctl list` fails
// (it exists; it timed out) while devicectl still lists the phone. iOS discovery then returns the
// phone alone with the simulator source incomplete, exactly as `discoverBootedIosDevices` does.
// Whether the simulator is still booted is unknown, so the available count is unknown.

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

describe("hunt: simctl fails while devicectl still lists a pooled iPhone", () => {
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

  test("the available-device count is the same answer on every surface", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const manager = new FakeDeviceUtils();
    manager.setBootedDevices("android", []);
    manager.setBootedDevices("ios", [simulator, phone]);
    const activeSessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
    sessions = activeSessions;
    const pool = new DevicePool(
      createDevicePoolDependencies(activeSessions, "hunt-mixed-ios", {
        timer,
        deviceManager: manager,
        retryExecutor: new DefaultRetryExecutor(timer),
        installedAppsRepository: new FakeInstalledAppsRepository(),
      }),
    );
    await pool.initializeWithDevices([simulator, phone]);
    expect(pool.getStats()).toMatchObject({ total: 2, idle: 2 });

    // simctl starts failing; devicectl keeps listing the phone.
    manager.failedSources = new Set(["ios-simulator"]);
    DaemonState.getInstance().initialize(activeSessions, pool);
    setDeviceToolsDependencies({
      deviceManagerFactory: () => manager,
      avdManagerFactory: () => ({ listDeviceImages: async () => [] }),
    });
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

    // The premise: the phone is listed, the simulator is not, and the observation is incomplete.
    expect(resource.devices.map((device) => device.runtime.deviceId)).toEqual([phone.deviceId]);
    expect(resource.observationComplete).toBe(false);

    const answers = {
      poolStats: await pool.getRefreshedStats().then((stats) => stats.idle, codeOf),
      daemonAvailableDevices: daemonResponse.success
        ? (daemonResponse.result as { availableDevices: number }).availableDevices
        : daemonResponse.code,
      cliInDaemon: await availableDevicesCli(DaemonState.getInstance(), resourceText),
      cliThroughResource: await availableDevicesCli(remoteState, resourceText),
    };

    // The pool surfaces refuse: the simulator's liveness is unknown. The resource, and the CLI
    // branch that reads it, count the unverified simulator as available instead.
    expect(answers).toEqual({
      poolStats: "discovery_incomplete",
      daemonAvailableDevices: "discovery_incomplete",
      cliInDaemon: "discovery_incomplete",
      cliThroughResource: "discovery_incomplete",
    });
  });
});
