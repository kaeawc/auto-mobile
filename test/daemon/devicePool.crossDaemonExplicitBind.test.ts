import { makePool } from "../helpers/makePool";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resolve, sep } from "node:path";
import type { AcquisitionReceipt } from "../../src/daemon/acquisitionReceipt";
import {
  DEVICE_OWNED_BY_OTHER_DAEMON_CODE,
  DeviceOwnedByOtherDaemonError,
} from "../../src/models/deviceAcquisitionRefusals";
import { DevicePool } from "../../src/daemon/devicePool";
import {
  IOS_SIMULATOR_CLAIM_SCOPE,
  WATCH_SIMULATOR_CLAIM_SCOPE,
  iosDeviceAllocationClaimPath,
  watchDeviceAllocationClaimPath,
  type ForeignDeviceOwnership,
} from "../../src/daemon/foreignDeviceOwnership";
import { releaseSessionAndDevice } from "../../src/daemon/releaseSessionAndDevice";
import { SessionManager } from "../../src/daemon/sessionManager";
import type { Platform } from "../../src/models";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../fakes/FakeTimer";

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

/** The pool dependency that carries `platform`'s claim store. */
function ownershipDependency(platform: Platform, ownership: ForeignDeviceOwnership) {
  switch (platform) {
    case "android":
      return { foreignDeviceOwnership: ownership };
    case "ios":
      return { iosForeignDeviceOwnership: ownership };
    case "watchos":
      return { watchForeignDeviceOwnership: ownership };
  }
}

const DAEMON_A_PID = 1111;
const DAEMON_B_PID = 2222;

for (const [platform, deviceId] of [
  ["android", "emulator-5554"],
  ["ios", "8F2C1A9E-4B1D-4C3E-9A55-0D6E1F2A3B4C"],
  // #14908: a watch is claimed by UDID too, so a second daemon can neither bind nor stop it.
  ["watchos", "3D4E5F60-7182-4A93-B4C5-D6E7F8091A2B"],
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
      const pool = makePool(sessions, `daemon-${pid}`, {
        timer,
        deviceManager: devices,
        ...ownershipDependency(platform, ownership),
      });
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

      await a.pool.bindOrReuseDeviceSession({ sessionId: "a-session", deviceId, platform });
      expect(store.claims.get(deviceId)).toBe(DAEMON_A_PID);

      const refusal = await b.pool
        .bindOrReuseDeviceSession({ sessionId: "b-session", deviceId, platform })
        .then(
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

      await releaseSessionAndDevice(a.sessions, a.pool, deviceId, "a-session", {
        reason: "explicit-release",
      });
      expect(store.claims.has(deviceId)).toBe(false);

      await b.pool.bindOrReuseDeviceSession({ sessionId: "b-session", deviceId, platform });
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

      const refusal = await b.pool
        .bindOrReuseDeviceSession({ sessionId: "b-session", deviceId, platform })
        .then(
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

      await releaseSessionAndDevice(a.sessions, a.pool, deviceId, aSession!, {
        reason: "explicit-release",
      });
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
      await a.pool.bindOrReuseDeviceSession({ sessionId: "a-session", deviceId, platform });

      let settled = false;
      void b.pool.assignDeviceToSession("b-session", platform).finally(() => {
        settled = true;
      });
      await timer.advanceTimeAsync(2_000);
      expect(settled).toBe(false);
      expect(b.pool.getDevice(deviceId)?.sessionId ?? null).toBeNull();
      b.pool.releaseDeviceClaimsForShutdown();
    });

    // #11565: the claim publish is awaited after the session committed, so a request can be
    // cancelled (or the publish can fail) with the session already bound and its id undelivered.
    describe("an acquisition whose result is never delivered (#11565)", () => {
      /** This daemon's ownership with every claim publish held until the test settles it. */
      const gated = (pid: number) => {
        const own = store.forDaemon(pid);
        const pending: Array<(outcome?: Error) => void> = [];
        const ownership: ForeignDeviceOwnership = {
          refresh: (ids) => own.refresh(ids),
          foreignOwnerPid: (id) => own.foreignOwnerPid(id),
          claim: async (id) => {
            const failure = await new Promise<Error | undefined>((settle) => pending.push(settle));
            if (failure) {
              throw failure;
            }
            return await own.claim(id);
          },
          release: (id) => own.release(id),
        };
        return { ownership, pending };
      };
      const untilPending = async (pending: readonly unknown[], count: number) => {
        for (let turn = 0; turn < 2_000 && pending.length < count; turn++) {
          await Promise.resolve();
        }
        expect(pending.length).toBe(count);
      };
      const bind = (
        pool: DevicePool,
        sessionId: string,
        receipt?: AcquisitionReceipt,
        allowSessionRebind = false,
      ) =>
        pool.bindOrReuseDeviceSession({
          sessionId,
          deviceId,
          platform,
          allowSessionRebind,
          oneShotCli: false,
          receipt,
        });
      const autolockWith = (pool: DevicePool, receipt: AcquisitionReceipt) =>
        pool.autolockDevice(
          deviceId,
          platform,
          "mcp-a",
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          "automationReady",
          undefined,
          { autolockEnabled: true, receipt },
        );
      const countReleases = (sessions: SessionManager): string[] => {
        const released: string[] = [];
        const releaseSession = sessions.releaseSession.bind(sessions);
        sessions.releaseSession = async (sessionId, ...rest) => {
          released.push(sessionId);
          return await releaseSession(sessionId, ...rest);
        };
        return released;
      };

      const acquisitions = {
        "explicit bind": (pool: DevicePool, receipt: AcquisitionReceipt) =>
          bind(pool, "a-session", receipt),
        autolock: autolockWith,
      };

      for (const [kind, acquire] of Object.entries(acquisitions)) {
        test(`${kind}: the session it minted is released for good, exactly once, and the claim withdrawn`, async () => {
          const a = await daemon(DAEMON_A_PID);
          const receipt: AcquisitionReceipt = {};
          const minted = (await acquire(a.pool, receipt))!;
          expect(receipt.minted).toMatchObject({
            session: a.sessions.getSession(minted)!,
            deviceId,
          });
          const released = countReleases(a.sessions);

          await a.pool.releaseUndeliveredAcquisition(receipt);
          await a.pool.releaseUndeliveredAcquisition(receipt);

          expect(released).toEqual([minted]);
          expect(a.pool.getDevice(deviceId)).toMatchObject({ sessionId: null, status: "idle" });
          expect(a.sessions.getAllSessions()).toEqual([]);
          expect(store.claims.has(deviceId)).toBe(false);
          expect(a.pool.resolveAutolockSessionForMcpSession("mcp-a")).toBeUndefined();
          // Terminal: the id no client ever received is never handed out again.
          await expect(bind(a.pool, minted, undefined, true)).rejects.toThrow();
        });

        test(`${kind}: a repeat acquisition that reused the session takes nothing back`, async () => {
          const a = await daemon(DAEMON_A_PID);
          const held = (await acquire(a.pool, {}))!;
          const receipt: AcquisitionReceipt = {};

          const reused =
            kind === "autolock"
              ? await autolockWith(a.pool, receipt)
              : await bind(a.pool, "b-session", receipt);
          await a.pool.releaseUndeliveredAcquisition(receipt);

          expect(reused).toBe(held);
          expect(receipt.minted).toBeUndefined();
          expect(a.pool.getDevice(deviceId)?.sessionId).toBe(held);
          expect(store.claims.get(deviceId)).toBe(DAEMON_A_PID);
        });

        test(`${kind}: a publish that fails releases the session it minted`, async () => {
          const { ownership, pending } = gated(DAEMON_A_PID);
          const a = await daemon(DAEMON_A_PID, ownership);
          const failure = new Error("claim directory is not writable");

          const outcome = acquire(a.pool, {}).then(
            () => undefined,
            (error: unknown) => error,
          );
          await untilPending(pending, 1);
          pending[0](failure);

          expect(await outcome).toBe(failure);
          expect(a.pool.getDevice(deviceId)).toMatchObject({ sessionId: null, status: "idle" });
          expect(a.sessions.getAllSessions()).toEqual([]);
        });

        test(`${kind}: nothing is taken back from the session that acquired the device since`, async () => {
          const a = await daemon(DAEMON_A_PID);
          const receipt: AcquisitionReceipt = {};
          const first = (await acquire(a.pool, receipt))!;
          await releaseSessionAndDevice(a.sessions, a.pool, deviceId, first, {
            reason: "explicit-release",
          });
          await bind(a.pool, "second");
          const released = countReleases(a.sessions);

          await a.pool.releaseUndeliveredAcquisition(receipt);

          expect(released).toEqual([]);
          expect(a.pool.getDevice(deviceId)).toMatchObject({ sessionId: "second", status: "busy" });
          expect(a.sessions.getSession("second")?.assignedDevice).toBe(deviceId);
          expect(store.claims.get(deviceId)).toBe(DAEMON_A_PID);
        });
      }

      test("a rebind of a session id the client supplied mints nothing to take back", async () => {
        const a = await daemon(DAEMON_A_PID);
        const receipt: AcquisitionReceipt = {};

        await bind(a.pool, "client-session", receipt, true);
        await a.pool.releaseUndeliveredAcquisition(receipt);

        expect(receipt.minted).toBeUndefined();
        expect(a.pool.getDevice(deviceId)?.sessionId).toBe("client-session");
        expect(store.claims.get(deviceId)).toBe(DAEMON_A_PID);
      });

      test("a publish that lands after another session took the device leaves that session's claim", async () => {
        const { ownership, pending } = gated(DAEMON_A_PID);
        const a = await daemon(DAEMON_A_PID, ownership);
        const receipt: AcquisitionReceipt = {};

        const first = bind(a.pool, "first", receipt);
        await untilPending(pending, 1);
        await releaseSessionAndDevice(a.sessions, a.pool, deviceId, "first", {
          reason: "explicit-release",
        });
        const second = bind(a.pool, "second");
        await untilPending(pending, 2);
        pending[1]();
        expect(await second).toBe("second");
        pending[0]();
        await first;
        await a.pool.releaseUndeliveredAcquisition(receipt);

        expect(a.pool.getDevice(deviceId)?.sessionId).toBe("second");
        expect(a.sessions.getSession("second")?.assignedDevice).toBe(deviceId);
        expect(store.claims.get(deviceId)).toBe(DAEMON_A_PID);
      });
    });
  });
}

test("iOS claims are keyed by UDID under one host-wide scope (#10980)", () => {
  const path = iosDeviceAllocationClaimPath("ABC-123", {}, "/home/someone");
  expect(path).toContain(IOS_SIMULATOR_CLAIM_SCOPE);
  // resolve(): on Windows an absolute POSIX-style home is anchored to the current drive.
  expect(path.startsWith(resolve("/home/someone", ".auto-mobile") + sep)).toBe(true);
  expect(iosDeviceAllocationClaimPath("ABC-123", { AUTOMOBILE_COORDINATION_DIR: "/x" }, "/h")).toBe(
    iosDeviceAllocationClaimPath("ABC-123", {}, "/h"),
  );
});

test("watch claims are keyed by UDID under their own host-wide scope (#14908)", () => {
  const path = watchDeviceAllocationClaimPath("ABC-123", {}, "/home/someone");
  expect(path).toContain(WATCH_SIMULATOR_CLAIM_SCOPE);
  expect(path).not.toBe(iosDeviceAllocationClaimPath("ABC-123", {}, "/home/someone"));
  expect(path.startsWith(resolve("/home/someone", ".auto-mobile") + sep)).toBe(true);
  expect(
    watchDeviceAllocationClaimPath("ABC-123", { AUTOMOBILE_COORDINATION_DIR: "/x" }, "/h"),
  ).toBe(watchDeviceAllocationClaimPath("ABC-123", {}, "/h"));
});

test("an inventory refresh re-reads which idle watches another daemon claims (#14908)", async () => {
  const timer = new FakeTimer();
  const sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
  const watch = { deviceId: "WATCH-UDID-14908", name: "Apple Watch", platform: "watchos" as const };
  const peerClaims = new Map<string, number>();
  const seen = new Map<string, number>();
  // Like the claim-file reader: a peer's claim is visible only once a refresh has read it.
  const ownership: ForeignDeviceOwnership = {
    async refresh(ids) {
      for (const id of ids) {
        const owner = peerClaims.get(id);
        if (owner === undefined) {
          seen.delete(id);
        } else {
          seen.set(id, owner);
        }
      }
    },
    foreignOwnerPid: (id) => seen.get(id),
    claim: async () => true,
    release: () => {},
  };
  try {
    const pool = makePool(sessions, "daemon-watch-refresh", {
      timer,
      watchForeignDeviceOwnership: ownership,
    });
    await pool.initializeWithDevices([watch]);
    peerClaims.set(watch.deviceId, DAEMON_A_PID);

    await pool.refreshInventoryOwnership();

    expect(pool.genericAvailability(watch.deviceId)).not.toBe("free");
  } finally {
    sessions.stopCleanupTimer();
    timer.reset();
  }
});
