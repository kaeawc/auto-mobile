import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  DEVICE_OWNED_BY_OTHER_DAEMON_CODE,
  DeviceOwnedByOtherDaemonError,
} from "../../src/daemon/deviceAcquisitionRefusals";
import { DevicePool } from "../../src/daemon/devicePool";
import {
  IOS_SIMULATOR_CLAIM_SCOPE,
  iosDeviceAllocationClaimPath,
  type ForeignDeviceOwnership,
} from "../../src/daemon/foreignDeviceOwnership";
import { releaseSessionAndDevice } from "../../src/daemon/releaseSessionAndDevice";
import { SessionManager } from "../../src/daemon/sessionManager";
import type { Platform } from "../../src/models";
import { DefaultRetryExecutor } from "../../src/utils/retry/RetryExecutor";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";

// #10980 (owner decision 2026-10-09): an explicit bind of a device another daemon has claimed is
// refused with a typed retryable device_owned_by_other_daemon error, on Android and iOS alike.

/** One host's claim files, shared by every daemon on it: device id -> owning daemon PID. */
class SharedClaimStore {
  readonly claims = new Map<string, number>();

  forDaemon(pid: number): ForeignDeviceOwnership {
    const store = this.claims;
    return {
      async refresh(): Promise<void> {},
      foreignOwnerPid(deviceId: string): number | undefined {
        const owner = store.get(deviceId);
        return owner === undefined || owner === pid ? undefined : owner;
      },
      async claim(deviceId: string): Promise<boolean> {
        const owner = store.get(deviceId);
        if (owner !== undefined && owner !== pid) {
          return false;
        }
        store.set(deviceId, pid);
        return true;
      },
      release(deviceId: string): void {
        if (store.get(deviceId) === pid) {
          store.delete(deviceId);
        }
      },
    };
  }
}

const DAEMON_A_PID = 1111;
const DAEMON_B_PID = 2222;

for (const [platform, deviceId] of [
  ["android", "emulator-5554"],
  ["ios", "8F2C1A9E-4B1D-4C3E-9A55-0D6E1F2A3B4C"],
] as const satisfies readonly (readonly [Platform, string])[]) {
  describe(`explicit binds across daemons on ${platform} (#10980)`, () => {
    let timer: FakeTimer;
    let store: SharedClaimStore;
    const managers: SessionManager[] = [];

    const daemon = async (pid: number, ownership = store.forDaemon(pid)) => {
      const sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
      managers.push(sessions);
      const devices = new FakeDeviceManager();
      const device = { deviceId, name: `${platform}-device`, platform };
      devices.bootedDevices = [device];
      const pool = new DevicePool(
        createDevicePoolDependencies(sessions, `daemon-${pid}`, {
          timer,
          deviceManager: devices,
          retryExecutor: new DefaultRetryExecutor(timer),
          installedAppsRepository: new FakeInstalledAppsRepository(),
          ...(platform === "android"
            ? { foreignDeviceOwnership: ownership }
            : { iosForeignDeviceOwnership: ownership }),
        }),
      );
      await pool.initializeWithDevices([device]);
      return { sessions, pool };
    };

    beforeEach(() => {
      timer = new FakeTimer();
      store = new SharedClaimStore();
    });
    afterEach(() => {
      for (const sessions of managers.splice(0)) {
        sessions.stopCleanupTimer();
      }
      timer.reset();
    });

    test("the second daemon's bind is refused with the typed code, and succeeds after the first releases", async () => {
      const a = await daemon(DAEMON_A_PID);
      const b = await daemon(DAEMON_B_PID);

      await a.pool.bindOrReuseDeviceSession("a-session", deviceId, platform);
      expect(store.claims.get(deviceId)).toBe(DAEMON_A_PID);

      const refusal = await b.pool.bindOrReuseDeviceSession("b-session", deviceId, platform).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(refusal).toBeInstanceOf(DeviceOwnedByOtherDaemonError);
      expect(refusal).toMatchObject({
        code: DEVICE_OWNED_BY_OTHER_DAEMON_CODE,
        retryable: true,
        deviceId,
        ownerPid: DAEMON_A_PID,
      });
      expect(b.pool.getDevice(deviceId)?.sessionId ?? null).toBeNull();
      expect(b.sessions.getSession("b-session")).toBeNull();

      await releaseSessionAndDevice(a.sessions, a.pool, deviceId, "a-session", "explicit-release");
      expect(store.claims.has(deviceId)).toBe(false);

      await b.pool.bindOrReuseDeviceSession("b-session", deviceId, platform);
      expect(b.pool.getDevice(deviceId)?.sessionId).toBe("b-session");
      expect(store.claims.get(deviceId)).toBe(DAEMON_B_PID);
    });

    test("a claim taken between the check and the bind rolls the bind back", async () => {
      const own = store.forDaemon(DAEMON_B_PID);
      // The other daemon claims the device after this bind's pre-check passed.
      const racing: ForeignDeviceOwnership = {
        refresh: (ids) => own.refresh(ids),
        foreignOwnerPid: (id) => own.foreignOwnerPid(id),
        claim: async (id) => {
          store.claims.set(id, DAEMON_A_PID);
          return await own.claim(id);
        },
        release: (id) => own.release(id),
      };
      const b = await daemon(DAEMON_B_PID, racing);

      const refusal = await b.pool.bindOrReuseDeviceSession("b-session", deviceId, platform).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(refusal).toBeInstanceOf(DeviceOwnedByOtherDaemonError);
      expect(b.pool.getDevice(deviceId)?.sessionId ?? null).toBeNull();
      expect(b.sessions.getSession("b-session")).toBeNull();
      expect(store.claims.get(deviceId)).toBe(DAEMON_A_PID);
    });

    // #11071: with autolock on, explicit acquisition (startDevice/getAndroid/getApple) went through
    // autolock, which neither checked nor published the claim, so two daemons owned one device.
    const autolock = (pool: DevicePool, mcpSessionId: string) =>
      pool.autolockDevice(
        deviceId,
        platform,
        mcpSessionId,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        "automationReady",
        undefined,
        { autolockEnabled: true },
      );

    test("an autolock acquisition is refused while another daemon claims the device, and claims it after release", async () => {
      const a = await daemon(DAEMON_A_PID);
      const b = await daemon(DAEMON_B_PID);

      const aSession = await autolock(a.pool, "mcp-a");
      expect(aSession).toBeDefined();
      expect(store.claims.get(deviceId)).toBe(DAEMON_A_PID);

      const refusal = await autolock(b.pool, "mcp-b").then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(refusal).toBeInstanceOf(DeviceOwnedByOtherDaemonError);
      expect(refusal).toMatchObject({
        code: DEVICE_OWNED_BY_OTHER_DAEMON_CODE,
        ownerPid: DAEMON_A_PID,
      });
      expect(b.pool.getDevice(deviceId)?.sessionId ?? null).toBeNull();
      expect(b.pool.getDevice(deviceId)?.autolockSessionId).toBeUndefined();

      await releaseSessionAndDevice(a.sessions, a.pool, deviceId, aSession!, "explicit-release");
      const bSession = await autolock(b.pool, "mcp-b");
      expect(b.pool.getDevice(deviceId)?.sessionId).toBe(bSession!);
      expect(store.claims.get(deviceId)).toBe(DAEMON_B_PID);
    });

    test("a claim taken between the check and the autolock rolls the autolock back", async () => {
      const own = store.forDaemon(DAEMON_B_PID);
      const racing: ForeignDeviceOwnership = {
        refresh: (ids) => own.refresh(ids),
        foreignOwnerPid: (id) => own.foreignOwnerPid(id),
        claim: async (id) => {
          store.claims.set(id, DAEMON_A_PID);
          return await own.claim(id);
        },
        release: (id) => own.release(id),
      };
      const b = await daemon(DAEMON_B_PID, racing);

      const refusal = await autolock(b.pool, "mcp-b").then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(refusal).toBeInstanceOf(DeviceOwnedByOtherDaemonError);
      expect(b.pool.getDevice(deviceId)?.sessionId ?? null).toBeNull();
      expect(b.pool.getDevice(deviceId)?.autolockSessionId).toBeUndefined();
      expect(b.pool.resolveAutolockSessionForMcpSession("mcp-b")).toBeUndefined();
      expect(store.claims.get(deviceId)).toBe(DAEMON_A_PID);
    });

    test("platform allocation skips a device another daemon claimed", async () => {
      const a = await daemon(DAEMON_A_PID);
      const b = await daemon(DAEMON_B_PID);
      await a.pool.bindOrReuseDeviceSession("a-session", deviceId, platform);

      let settled = false;
      void b.pool.assignDeviceToSession("b-session", platform).finally(() => {
        settled = true;
      });
      await timer.advanceTimeAsync(2_000);
      expect(settled).toBe(false);
      expect(b.pool.getDevice(deviceId)?.sessionId ?? null).toBeNull();
      b.pool.releaseDeviceClaimsForShutdown();
    });
  });
}

test("iOS claims are keyed by UDID under one host-wide scope (#10980)", () => {
  const path = iosDeviceAllocationClaimPath("ABC-123", {}, "/home/someone");
  expect(path).toContain(IOS_SIMULATOR_CLAIM_SCOPE);
  expect(path.startsWith("/home/someone/.auto-mobile/")).toBe(true);
  expect(iosDeviceAllocationClaimPath("ABC-123", { AUTOMOBILE_COORDINATION_DIR: "/x" }, "/h")).toBe(
    iosDeviceAllocationClaimPath("ABC-123", {}, "/h"),
  );
});
