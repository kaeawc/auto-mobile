import { deliverDaemonHeartbeat } from "../helpers/daemonHeartbeatHandler";
import { makePool } from "../helpers/makePool";
import { afterEach, describe, expect, test } from "bun:test";
import { Daemon } from "../../src/daemon/daemon";
import { DaemonState } from "../../src/daemon/daemonState";
import {
  OFFLINE_DEVICE_DISCONNECT_BUDGET_MS,
  MISSING_SIMULATOR_DISCONNECT_BUDGET_MS,
} from "../../src/daemon/disconnectMonitor";
import { InMemoryEmulatorLossIncidentStore } from "../../src/daemon/emulatorLossIncident";
import { SessionManager } from "../../src/daemon/sessionManager";
import type { BootedDevice, DeviceInfo } from "../../src/models";
import type { TransitionalSimulatorState } from "../../src/models/TransitionalSimulator";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";

const POLL_MS = 5_000;
const HELD: BootedDevice = { deviceId: "sim-held", name: "iPhone 16", platform: "ios" };
const UNHELD: BootedDevice = { deviceId: "sim-unheld", name: "iPhone 16 Plus", platform: "ios" };
const SESSION = "holder-session";

type SimulatorState = "Booted" | "Shutdown" | TransitionalSimulatorState;

/**
 * A `simctl list` stand-in: booted simulators are discovery's devices, `Booting` and
 * `Shutting Down` ones are its transitional listing, and `Shutdown` ones are in neither.
 */
class SimulatorListingManager extends FakeDeviceManager {
  readonly states = new Map<string, SimulatorState>();

  // Android offline probing is irrelevant to the simulator rows under test.
  async getAndroidOfflineDeviceIds() {
    return new Set<string>();
  }

  override async getBootedDevicesDetailed(
    platform: Parameters<FakeDeviceManager["getBootedDevicesDetailed"]>[0],
  ) {
    const known = [HELD, UNHELD].filter((device) => this.states.has(device.deviceId));
    this.bootedDevices = known.filter((device) => this.states.get(device.deviceId) === "Booted");
    const discovery = await super.getBootedDevicesDetailed(platform);
    if (!discovery.succeededSources?.has("ios-simulator")) {
      return discovery;
    }
    return {
      ...discovery,
      transitionalSimulators: known.flatMap((device) => {
        const state = this.states.get(device.deviceId);
        return state === "Booting" || state === "Shutting Down" ? [{ device, state }] : [];
      }),
    };
  }

  async recoverAndroidOfflineDevices() {}
}

/**
 * The real daemon disconnect tick over a real pool and session manager: the session's release,
 * its reason and the pool removal are the production path, only discovery is faked.
 */
async function simulatorMonitor() {
  const timer = new FakeTimer();
  const ids = new FakeIdGenerator();
  const sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
  const manager = new SimulatorListingManager();
  const pool = makePool(sessions, "daemon", {
    timer,
    idGenerator: ids,
    deviceManager: manager,
    emulatorLossIncidentStore: new InMemoryEmulatorLossIncidentStore(timer, ids),
    recoveryPolicy: { onLoss: false, maxAttempts: 0 },
    deviceSessionContinuityEnabled: false,
  });
  const image = (device: BootedDevice): DeviceInfo => ({
    name: device.name,
    platform: "ios",
    source: "local",
    isRunning: true,
  });
  manager.states.set(HELD.deviceId, "Booted").set(UNHELD.deviceId, "Booted");
  manager.bootedDevices = [HELD, UNHELD];
  await pool.addDevice(HELD, image(HELD));
  await pool.addDevice(UNHELD, image(UNHELD));
  await pool.bindOrReuseDeviceSession({
    sessionId: SESSION,
    deviceId: HELD.deviceId,
    platform: "ios",
    sourceImage: image(HELD),
    expectedIdentity: HELD,
  });

  const daemon = new Daemon({}, { timer });
  daemon.testHooks.replaceDevicePool(pool);
  daemon.testHooks.replaceSessionManager(sessions);
  daemon.testHooks.startDeviceDisconnectMonitor(manager, async () => []);

  /** Poll every 5 s for `ms`, the holder heartbeating throughout: only device loss can end it. */
  const pollFor = async (ms: number) => {
    for (let elapsed = 0; elapsed < ms; elapsed += POLL_MS) {
      if (sessions.getSession(SESSION)) {
        await deliverDaemonHeartbeat(sessions, SESSION);
      }
      timer.advanceTime(POLL_MS);
      await daemon.testHooks.runtime.deviceDisconnectMonitor!.run();
    }
  };
  return {
    daemon,
    pool,
    sessions,
    pollFor,
    set: (device: BootedDevice, state: SimulatorState) =>
      manager.states.set(device.deviceId, state),
    failSimctl: (failed: boolean) => {
      manager.failedSources = failed ? new Set(["ios-simulator"]) : new Set();
    },
    held: () => pool.getDevice(HELD.deviceId)?.sessionId === SESSION,
    releaseReason: () => sessions.getReleasedSessionReason(SESSION),
    stop: () => daemon.testHooks.runtime.deviceDisconnectMonitor!.stop(),
  };
}

async function withMonitor(
  action: (h: Awaited<ReturnType<typeof simulatorMonitor>>) => Promise<void>,
) {
  const h = await simulatorMonitor();
  try {
    await action(h);
  } finally {
    await h.stop();
  }
}

describe("disconnect monitor: held simulator in a transitional simctl state (#11592)", () => {
  test("missing, missing, source-unavailable, missing confirms simulator loss", async () => {
    await withMonitor(async (h) => {
      h.set(HELD, "Shutdown");
      await h.pollFor(2 * POLL_MS);
      h.failSimctl(true);
      await h.pollFor(POLL_MS);
      h.failSimctl(false);
      await h.pollFor(POLL_MS);
      expect(h.sessions.getSession(SESSION)).toBeNull();
      expect(await h.releaseReason()).toStartWith(`device-disconnected:${HELD.deviceId}`);
    });
  });

  test("unavailable then present resets simulator absence evidence", async () => {
    await withMonitor(async (h) => {
      h.set(HELD, "Shutdown");
      await h.pollFor(2 * POLL_MS);
      h.failSimctl(true);
      await h.pollFor(POLL_MS);
      h.failSimctl(false);
      h.set(HELD, "Booted");
      await h.pollFor(POLL_MS);
      expect(h.daemon.testHooks.deviceLoss.misses.has(HELD.deviceId)).toBe(false);
      expect(h.daemon.testHooks.deviceLoss.offlineEpisodes.has(HELD.deviceId)).toBe(false);
      h.set(HELD, "Shutdown");
      await h.pollFor(2 * POLL_MS);
      expect(h.held()).toBe(true);
      await h.pollFor(POLL_MS);
      expect(h.sessions.getSession(SESSION)).toBeNull();
    });
  });

  test("a missing simulator followed by failed sweeps resolves at the time bound", async () => {
    await withMonitor(async (h) => {
      h.set(HELD, "Shutdown");
      await h.pollFor(POLL_MS);
      h.failSimctl(true);
      await h.pollFor(MISSING_SIMULATOR_DISCONNECT_BUDGET_MS - POLL_MS);
      expect(h.held()).toBe(true);
      await h.pollFor(POLL_MS);
      expect(h.sessions.getSession(SESSION)).toBeNull();
      expect(await h.releaseReason()).toStartWith(`device-disconnected:${HELD.deviceId}`);
    });
  });

  test("unavailable-only sweeps never confirm simulator loss", async () => {
    await withMonitor(async (h) => {
      h.failSimctl(true);
      await h.pollFor(2 * MISSING_SIMULATOR_DISCONNECT_BUDGET_MS);
      expect(h.held()).toBe(true);
      expect(h.daemon.testHooks.deviceLoss.misses.has(HELD.deviceId)).toBe(false);
      expect(h.daemon.testHooks.deviceLoss.offlineEpisodes.size).toBe(0);
    });
  });

  test("a held simulator Booting for 20 s then Booted keeps its session", async () => {
    await withMonitor(async (h) => {
      await h.pollFor(POLL_MS);
      h.set(HELD, "Booting");
      await h.pollFor(20_000);
      expect(h.sessions.getSession(SESSION)).not.toBeNull();
      expect(h.held()).toBe(true);
      expect(h.daemon.testHooks.deviceLoss.misses.has(HELD.deviceId)).toBe(false);

      h.set(HELD, "Booted");
      await h.pollFor(POLL_MS);
      expect(h.held()).toBe(true);
      expect(h.daemon.testHooks.deviceLoss.offlineEpisodes.size).toBe(0);
    });
  });

  test("a restart through Shutting Down, a brief Shutdown and Booting keeps its session", async () => {
    await withMonitor(async (h) => {
      h.set(HELD, "Shutting Down");
      await h.pollFor(2 * POLL_MS);
      h.set(HELD, "Shutdown");
      await h.pollFor(2 * POLL_MS);
      h.set(HELD, "Booting");
      await h.pollFor(20_000);
      h.set(HELD, "Booted");
      await h.pollFor(POLL_MS);
      expect(h.sessions.getSession(SESSION)).not.toBeNull();
      expect(h.held()).toBe(true);
    });
  });

  test("a held simulator still Booting when the budget runs out is released as a device loss", async () => {
    await withMonitor(async (h) => {
      h.set(HELD, "Booting");
      await h.pollFor(OFFLINE_DEVICE_DISCONNECT_BUDGET_MS);
      expect(h.held()).toBe(true);

      await h.pollFor(POLL_MS);
      expect(h.sessions.getSession(SESSION)).toBeNull();
      expect(h.pool.getDevice(HELD.deviceId)).toBeNull();
      expect(await h.releaseReason()).toStartWith(`device-disconnected:${HELD.deviceId}`);
    });
  });

  test("Shutting Down that reaches Shutdown is released on the absent debounce, not a second budget", async () => {
    await withMonitor(async (h) => {
      h.set(HELD, "Shutting Down");
      await h.pollFor(2 * POLL_MS);
      expect(h.held()).toBe(true);

      h.set(HELD, "Shutdown");
      await h.pollFor(2 * POLL_MS);
      expect(h.held()).toBe(true);
      await h.pollFor(POLL_MS);
      expect(h.sessions.getSession(SESSION)).toBeNull();
      expect(await h.releaseReason()).toStartWith(`device-disconnected:${HELD.deviceId}`);
    });
  });

  test("a failed simctl sweep neither holds nor counts the simulator", async () => {
    await withMonitor(async (h) => {
      h.set(HELD, "Booting");
      h.failSimctl(true);
      await h.pollFor(30_000);
      expect(h.held()).toBe(true);
      expect(h.daemon.testHooks.deviceLoss.offlineEpisodes.size).toBe(0);
      expect(h.daemon.testHooks.deviceLoss.misses.has(HELD.deviceId)).toBe(false);
    });
  });

  test("an unheld pooled simulator that is Booting keeps the three-miss rule", async () => {
    await withMonitor(async (h) => {
      h.set(UNHELD, "Booting");
      await h.pollFor(2 * POLL_MS);
      expect(h.pool.getDevice(UNHELD.deviceId)).not.toBeNull();
      await h.pollFor(POLL_MS);
      expect(h.pool.getDevice(UNHELD.deviceId)).toBeNull();
      expect(h.held()).toBe(true);
    });
  });
});

afterEach(() => {
  DaemonState.getInstance().reset();
});
