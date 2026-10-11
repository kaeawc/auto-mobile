import { describe, expect, test } from "bun:test";
import { isolateToolRegistry } from "../../helpers/withTemporaryTool";
import {
  registerDeviceTools,
  resetDeviceToolsDependencies,
  setDeviceToolsDependencies,
} from "../../../src/server/deviceTools";
import { ToolRegistry } from "../../../src/server/toolRegistry";
import { DaemonState } from "../../../src/daemon/daemonState";
import { DevicePool } from "../../../src/daemon/devicePool";
import { DeviceSessionRegistry } from "../../../src/daemon/deviceSessionRegistry";
import type { ForeignDeviceOwnership } from "../../../src/daemon/foreignDeviceOwnership";
import { SessionManager } from "../../../src/daemon/sessionManager";
import { DEFAULT_SESSION_IDLE_TIMEOUT_MS } from "../../../src/daemon/sessionLivenessWindows";
import type { BootedDevice, DeviceInfo } from "../../../src/models";
import { clearDirectSessionDevices } from "../../../src/server/directSessionDeviceRegistry";
import { setDeviceManager } from "../../../src/server/bootedDeviceResources";
import { DefaultDeviceMatcher } from "../../../src/utils/deviceMatcher";
import { CountingIdGenerator } from "../../../src/utils/IdGenerator";
import { PlatformDeviceManagerFactory } from "../../../src/utils/factories/PlatformDeviceManagerFactory";
import { resetProvisionedDeviceTransportFenceForTests } from "../../../src/utils/provisionedDeviceTransportFence";
import { FakeDeviceSessionPersistence } from "../../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../../fakes/FakeDeviceUtils";
import { FakeInstalledAppsRepository } from "../../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../../helpers/devicePoolDependencies";
import { forbidHostCommands } from "../../daemon/hunt/timerInteractionRig";

isolateToolRegistry();
// Fake-only: nothing here may launch a host or adb command.
forbidHostCommands();

// Hunt 2026-10-10, lifecycle timer interactions, cell 8 (cancel-then-retry).
//
// A client cancels `getApple`/`getAndroid` mid-acquisition and immediately retries on the same
// connection. The acquisition's last awaited step is the cross-daemon claim publish
// (`ForeignDeviceOwnership.claim`), which runs AFTER the session is committed; #11565 made the
// cancelled call undo the bind once that publish settles. The retry arrives while the cancelled
// call's publish is still in flight, so it finds the cancelled call's session still bound to the
// device under the same connection.
//
// The contract driven here: the second call succeeds, and afterwards there is exactly one session,
// one device hold and one published claim, all for the session the retry returned.

const SIM_UDID = "AAAAAAAA-1111-4111-8111-AAAAAAAAAAAA";
const simulator: DeviceInfo = {
  name: "iPhone 16",
  platform: "ios",
  deviceId: SIM_UDID,
  isRunning: true,
  source: "local",
  osVersion: "18.2",
  iosVersion: "18.2",
  formFactor: "phone",
};
const bootedSimulator: BootedDevice = { name: simulator.name, platform: "ios", deviceId: SIM_UDID };
const AVD_SERIAL = "emulator-5554";
const avd: DeviceInfo = {
  name: "Pixel_7_API_34",
  platform: "android",
  deviceId: AVD_SERIAL,
  isRunning: true,
  source: "local",
  osVersion: "14",
  formFactor: "phone",
};
const bootedAvd: BootedDevice = { name: avd.name, platform: "android", deviceId: AVD_SERIAL };

/** Claim publishes stay in flight until the test settles each one, in whatever order it likes. */
class GatedClaimOwnership implements ForeignDeviceOwnership {
  readonly pending: Array<(outcome: boolean) => void> = [];
  readonly held = new Set<string>();
  readonly released: string[] = [];

  async refresh(): Promise<void> {}

  foreignOwnerPid(): number | undefined {
    return undefined;
  }

  claim(deviceId: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      this.pending.push((outcome) => {
        if (outcome) {
          this.held.add(deviceId);
        }
        resolve(outcome);
      });
    });
  }

  release(deviceId: string): void {
    this.released.push(deviceId);
    this.held.delete(deviceId);
  }
}

type Outcome = { ok: true; sessionUuid: string } | { ok: false; error: unknown };

async function withAcquisitionRig(
  run: (rig: Awaited<ReturnType<typeof buildRig>>) => Promise<void>,
): Promise<void> {
  const rig = await buildRig();
  try {
    await run(rig);
  } finally {
    resetDeviceToolsDependencies();
    DaemonState.getInstance().reset();
    rig.sessions.stopCleanupTimer();
    clearDirectSessionDevices();
    resetProvisionedDeviceTransportFenceForTests();
    setDeviceManager(null);
    PlatformDeviceManagerFactory.reset();
    rig.timer.reset();
  }
}

async function buildRig() {
  resetDeviceToolsDependencies();
  DaemonState.getInstance().reset();
  clearDirectSessionDevices();
  resetProvisionedDeviceTransportFenceForTests();
  const timer = new FakeTimer();
  const devices = new FakeDeviceUtils();
  devices.setBootedDevices("android", [bootedAvd]);
  devices.setBootedDevices("ios", [bootedSimulator]);
  devices.setDeviceImages("android", [avd]);
  devices.setDeviceImages("ios", [simulator]);
  const ownership = new GatedClaimOwnership();
  const idGenerator = new CountingIdGenerator("cancel-retry");
  const env = { AUTOMOBILE_DEVICE_POOL_AUTOLOCK: "0" };
  setDeviceToolsDependencies({
    env,
    deviceManagerFactory: () => devices,
    deviceMatcherFactory: () => new DefaultDeviceMatcher(),
    avdManagerFactory: () => ({ listDeviceImages: async () => [] }),
    notifyResourcesChanged: async () => {},
    notifyDeviceInventoryResourcesChanged: async () => {},
    syncInstalledAppResourceRegistry: async () => false,
    clearInstalledAppsForDevice: async () => {},
    ensureCtrlProxyReady: async () => {},
    timer,
    idGenerator,
  });
  PlatformDeviceManagerFactory.setInstance(devices);
  setDeviceManager(devices);
  const sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
  const releases: Array<[string, string]> = [];
  sessions.onSessionRelease((sessionId, _deviceId, reason) => {
    releases.push([sessionId, reason ?? ""]);
  });
  const pool = new DevicePool(
    createDevicePoolDependencies(sessions, "cancel-retry-daemon", {
      env,
      timer,
      idGenerator,
      deviceManager: devices,
      installedAppsRepository: new FakeInstalledAppsRepository(),
      deviceSessionRepository: { markAutolockSession: async () => {} },
      foreignDeviceOwnership: ownership,
      iosForeignDeviceOwnership: ownership,
    }),
  );
  DaemonState.getInstance().initialize(
    sessions,
    pool,
    new DeviceSessionRegistry(timer, idGenerator),
  );
  registerDeviceTools();
  await pool.initializeWithDevices([bootedSimulator, bootedAvd]);

  const spin = async (turns = 200): Promise<void> => {
    for (let turn = 0; turn < turns; turn++) {
      await Promise.resolve();
    }
  };
  const acquire = (
    tool: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Outcome> =>
    (
      ToolRegistry.getTool(tool)!.handler(
        { ...args, __mcpSessionId: "mcp-client" },
        undefined,
        signal,
      ) as Promise<{ content: Array<{ text: string }> }>
    ).then(
      (response) => ({
        ok: true as const,
        sessionUuid: (
          JSON.parse(response.content[0].text) as {
            runtime: { session: { sessionUuid: string } };
          }
        ).runtime.session.sessionUuid,
      }),
      (error: unknown) => ({ ok: false as const, error }),
    );
  const untilClaimsPending = async (count: number): Promise<number> => {
    for (let turn = 0; turn < 5_000 && ownership.pending.length < count; turn++) {
      await Promise.resolve();
    }
    return ownership.pending.length;
  };
  /** Room for every deferred cancellation settlement and grace timer to run. */
  const drain = async (): Promise<void> => {
    for (let second = 0; second < 10; second++) {
      await spin();
      timer.advanceTime(1_000);
    }
    await spin();
  };
  return { timer, sessions, pool, ownership, releases, acquire, untilClaimsPending, drain, spin };
}

describe.each([
  ["getApple", { udid: SIM_UDID }, SIM_UDID],
  ["getAndroid", { deviceId: AVD_SERIAL }, AVD_SERIAL],
] as const)("%s cancelled mid-acquisition and immediately retried", (tool, args, deviceId) => {
  test("the retry waits for the cancelled call's undo, then binds the one session, hold and claim", async () => {
    await withAcquisitionRig(async (rig) => {
      const controller = new AbortController();
      const cancelled = rig.acquire(tool, args, controller.signal);
      expect(await rig.untilClaimsPending(1)).toBe(1);
      controller.abort(new Error("client cancelled"));
      const retry = rig.acquire(tool, args);
      await rig.spin();
      // The retry is serialized behind the cancelled call: it has not published a claim of its own.
      expect(rig.ownership.pending).toHaveLength(1);

      rig.ownership.pending[0]!(true);
      expect(await rig.untilClaimsPending(2)).toBe(2);
      rig.ownership.pending[1]!(true);
      const first = await cancelled;
      const second = await retry;
      const acquiredAt = rig.timer.now();
      await rig.drain();

      expect(first.ok).toBe(false);
      const retried = second.ok
        ? second.sessionUuid
        : `failed: ${String(!second.ok && second.error)}`;
      expect({
        retried,
        liveSessions: rig.sessions.getAllSessions().map((session) => session.sessionId),
        deviceHeldBy: rig.pool.getDevice(deviceId)?.sessionId ?? null,
        claimPublished: [...rig.ownership.held],
      }).toEqual({
        retried: expect.stringMatching(/^(?!failed)/),
        liveSessions: [retried],
        deviceHeldBy: retried,
        claimPublished: [deviceId],
      });
      // Exactly one release: the cancelled call's own session, never the retry's.
      expect(rig.releases.map(([sessionId]) => sessionId)).not.toContain(retried);
      expect(rig.releases).toHaveLength(1);
      // The surviving session's idle window runs from its own acquisition.
      expect(rig.sessions.getSession(retried)!.expiresAt).toBe(
        acquiredAt + DEFAULT_SESSION_IDLE_TIMEOUT_MS,
      );
    });
  });
});
