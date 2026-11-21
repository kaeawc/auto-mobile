import { afterEach, describe, expect, test } from "bun:test";
import { DaemonState } from "../../src/daemon/daemonState";
import type { SingleFlightInterval } from "../../src/daemon/SingleFlightInterval";
import { selectUnownedOfflineRecoveryIds } from "../../src/daemon/disconnectMonitor";
import { ownedOfflineRecoveryCandidates } from "../../src/daemon/deviceLossDiscovery";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeTimer } from "../fakes/FakeTimer";
import {
  createMonitorDaemon,
  heldAndroidDevice,
  heldSession,
} from "../helpers/disconnectMonitorDaemon";

const EXCLUDED_PORTS_ENV = "AUTOMOBILE_EMULATOR_EXCLUDED_CONSOLE_PORTS";

describe("selectUnownedOfflineRecoveryIds (#18911)", () => {
  test("withholds a device this daemon does not hold", () => {
    expect(
      selectUnownedOfflineRecoveryIds(
        ["emulator-5554", "emulator-5582"],
        (id) => id === "emulator-5554",
        new Set(),
      ),
    ).toEqual(new Set(["emulator-5582"]));
  });

  test("withholds an excluded-port emulator even when this daemon holds it", () => {
    expect(
      selectUnownedOfflineRecoveryIds(
        ["emulator-5582", "emulator-5554"],
        () => true,
        new Set([5582]),
      ),
    ).toEqual(new Set(["emulator-5582"]));
  });

  test("an unresolvable exclusion withholds every emulator but not other held serials", () => {
    expect(
      selectUnownedOfflineRecoveryIds(["emulator-5554", "PHONE-USB"], () => true, "all"),
    ).toEqual(new Set(["emulator-5554"]));
  });
});

describe("ownedOfflineRecoveryCandidates (#18911)", () => {
  const held = heldAndroidDevice("emulator-5554");
  const idle = { ...heldAndroidDevice("emulator-5582"), sessionId: null, status: "idle" as const };
  const leased = { ...idle, id: "emulator-5590" };
  const pooled = [held, idle, leased];
  const services = {
    devicePool: () => ({
      getAllDevices: () => pooled,
      getDevice: (id: string) => pooled.find((device) => device.id === id) ?? null,
      isDeviceLeasedForAndroidStartup: (id: string) => id === "emulator-5590",
    }),
    sessionManager: () => ({ getAllSessions: () => [] }),
  };
  const recordings = [{ deviceId: "PHONE-USB", platform: "android" as const, recordingId: "r1" }];
  const owned = (env: NodeJS.ProcessEnv) =>
    ownedOfflineRecoveryCandidates(candidates, services, recordings, env);
  const candidates = new Set(["emulator-5554", "emulator-5582", "PHONE-USB", "emulator-5590"]);

  test("keeps held, recording and startup-leased devices and drops an idle pooled one", () => {
    expect(owned({})).toEqual(new Set(["emulator-5554", "PHONE-USB", "emulator-5590"]));
  });

  test("drops a held emulator on an excluded console port", () => {
    expect(owned({ AUTOMOBILE_EMULATOR_EXCLUDED_CONSOLE_PORTS: "emulator-5554" })).toEqual(
      new Set(["PHONE-USB", "emulator-5590"]),
    );
  });

  test("an invalid exclusion fails closed for every emulator", () => {
    expect(owned({ AUTOMOBILE_EMULATOR_EXCLUDED_CONSOLE_PORTS: "not-a-port" })).toEqual(
      new Set(["PHONE-USB"]),
    );
  });
});

class RecordingOfflineManager extends FakeDeviceManager {
  readonly received: string[][] = [];
  constructor(private readonly offline: string[]) {
    super();
  }
  async getAndroidOfflineDeviceIds() {
    return new Set(this.offline);
  }
  async recoverAndroidOfflineDevices(ids: Iterable<string>) {
    this.received.push([...ids]);
  }
}

function startMonitor(manager: RecordingOfflineManager, deviceId: string) {
  const timer = new FakeTimer();
  const device = heldAndroidDevice(deviceId);
  const harness = createMonitorDaemon({
    timer,
    device,
    missIncarnations: new Map([[deviceId, 1]]),
  });
  harness.daemon.testHooks.startDeviceDisconnectMonitor(manager, async () => []);
  return {
    ...harness,
    device,
    monitor: harness.daemon.testHooks.runtime.deviceDisconnectMonitor as SingleFlightInterval,
  };
}

const savedExcludedPorts = process.env[EXCLUDED_PORTS_ENV];

afterEach(() => {
  if (savedExcludedPorts === undefined) {
    delete process.env[EXCLUDED_PORTS_ENV];
  } else {
    process.env[EXCLUDED_PORTS_ENV] = savedExcludedPorts;
  }
  DaemonState.getInstance().reset();
});

test("an idle pooled offline emulator no session holds is never reconnected", async () => {
  process.env[EXCLUDED_PORTS_ENV] = "";
  const manager = new RecordingOfflineManager(["emulator-5554", "emulator-5582"]);
  const { device, monitor, spies } = startMonitor(manager, "emulator-5554");
  const idle = { ...heldAndroidDevice("emulator-5582"), sessionId: null, status: "idle" as const };
  spies.getAllDevices.mockImplementation(() => [device, idle]);
  spies.getDevice.mockImplementation((id: string) =>
    id === device.id ? device : id === idle.id ? idle : null,
  );
  try {
    await monitor.run();
    expect(manager.received).toEqual([["emulator-5554"]]);
  } finally {
    await monitor.stop();
  }
});

test("an emulator on an excluded console port is never reconnected, even when held", async () => {
  process.env[EXCLUDED_PORTS_ENV] = "5554";
  const manager = new RecordingOfflineManager(["emulator-5554"]);
  const { monitor, spies } = startMonitor(manager, "emulator-5554");
  spies.getAllSessions.mockImplementation(() => [heldSession("emulator-5554")]);
  try {
    await monitor.run();
    await monitor.run();
    expect(manager.received).toEqual([]);
  } finally {
    await monitor.stop();
  }
});
