import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { runDaemonCommand } from "../../src/daemon/cli/runDaemonCommand";
import { DaemonState, type DaemonStateLike } from "../../src/daemon/daemonState";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import {
  getBootedDevicesForPlatforms,
  resetBootedDevicesResourceCache,
  setDeviceManager,
} from "../../src/server/bootedDeviceResources";
import { DefaultRetryExecutor } from "../../src/utils/retry/RetryExecutor";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../fakes/FakeTimer";
import { SafeDaemonManager } from "../fakes/SafeDaemonManager";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";

// Inventory contract: an unknown never reads as "0 devices". When every discovery source failed
// and the pool has no entries, the booted resource reports observationComplete=false with a
// zeroed poolStatus; the CLI `available-devices` renders that resource and must refuse, not print
// "availableDevices: 0".

const unexpected = (): never => {
  throw new Error("Unexpected daemon operation");
};
const remoteState: DaemonStateLike = {
  isInitialized: () => false,
  getSessionManager: unexpected,
  getDevicePool: unexpected,
  getDeviceSessionRegistry: unexpected,
};

describe("available-devices CLI over an incomplete booted resource", () => {
  let sessions: SessionManager | undefined;
  afterEach(() => {
    DaemonState.getInstance().reset();
    sessions?.stopCleanupTimer();
    resetBootedDevicesResourceCache();
    setDeviceManager(null);
  });

  test("does not print zero devices when discovery failed", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const manager = new FakeDeviceUtils();
    manager.setAndroidDiscoveryIncomplete();
    manager.failedPlatforms.add("ios");
    sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const pool = new DevicePool(
      createDevicePoolDependencies(sessions, "hunt-unknown-zero", {
        timer,
        deviceManager: manager,
        retryExecutor: new DefaultRetryExecutor(timer),
        installedAppsRepository: new FakeInstalledAppsRepository(),
      }),
    );
    DaemonState.getInstance().initialize(sessions, pool);
    setDeviceManager(manager);
    const resource = await getBootedDevicesForPlatforms(["android", "ios"], timer);
    expect(resource.observationComplete).toBe(false);

    const stdout: string[] = [];
    const exits: unknown[] = [];
    class Client extends FakeDaemonClient {
      override async connect() {}
      override async readResource() {
        return {
          contents: [{ uri: "automobile:devices/booted", text: JSON.stringify(resource, null, 2) }],
        } as never;
      }
      override async close() {}
    }
    class Manager extends SafeDaemonManager {
      override getDaemonState() {
        return remoteState;
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
      await runDaemonCommand("available-devices", [], {}, Manager).catch(() => {});
    } finally {
      exit.mockRestore();
      errorSpy.mockRestore();
      log.mockRestore();
    }
    expect({ stdout, exits }).toEqual({ stdout: [], exits: [1] });
  });
});
