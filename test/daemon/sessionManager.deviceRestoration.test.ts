import { describe, expect, test } from "bun:test";
import { SessionManager, type BiometricEnrollmentRestorer } from "../../src/daemon/sessionManager";
import { FakeTimer } from "../fakes/FakeTimer";
import {
  installSessionManagerFixture,
  makeRestoringManager,
  networkRestorer,
  recordingBiometricRestorer,
  recordingNetworkRestorers,
} from "../helpers/sessionManagerSuite";

describe("SessionManager", () => {
  let fakeTimer: FakeTimer;

  installSessionManagerFixture((fixture) => {
    fakeTimer = fixture.timer;
  });

  describe("biometric enrollment restoration", () => {
    test("restores the original iOS Simulator enrollment when a session releases", async () => {
      const restored: string[] = [];
      const restorer: BiometricEnrollmentRestorer = {
        restore: async (enrollment) => {
          restored.push(enrollment);
        },
      };
      const manager = makeRestoringManager({
        timer: fakeTimer,
        biometricEnrollmentRestorer: () => restorer,
      });

      await manager.createSession("ios-biometric", "sim-1", "ios");
      manager.setBiometricEnrollment("ios-biometric", { initialEnrollment: "not_enrolled" });
      // The initial state is write-once; a later change must not replace it.
      manager.setBiometricEnrollment("ios-biometric", { initialEnrollment: "enrolled" });

      await manager.releaseSession("ios-biometric");

      expect(restored).toEqual(["not_enrolled"]);
    });

    test("restores the old simulator enrollment before a session rebinds", async () => {
      const restored: Array<{ deviceId: string; enrollment: string }> = [];
      const manager = makeRestoringManager({
        timer: fakeTimer,
        biometricEnrollmentRestorer: recordingBiometricRestorer(restored),
      });

      await manager.createSession("ios-rebind", "sim-a", "ios");
      manager.setBiometricEnrollment("ios-rebind", { initialEnrollment: "enrolled" });

      await manager.rebindSession("ios-rebind", "sim-b", "ios");

      expect(restored).toEqual([{ deviceId: "sim-a", enrollment: "enrolled" }]);
      expect(manager.getBiometricEnrollment("ios-rebind")).toBeUndefined();
    });

    test("waits for an active biometric setup before restoring the old simulator", async () => {
      const restored: string[] = [];
      const manager = makeRestoringManager({
        timer: fakeTimer,
        biometricEnrollmentRestorer: () => ({
          restore: async (enrollment) => {
            restored.push(enrollment);
          },
        }),
      });
      const started = Promise.withResolvers<void>();
      const finished = Promise.withResolvers<void>();

      const session = await manager.createSession("ios-rebind-active", "sim-a", "ios");
      manager.setBiometricEnrollment("ios-rebind-active", { initialEnrollment: "enrolled" });
      const setup = manager.trackSessionSetup(session, async () => {
        started.resolve();
        await finished.promise;
      });
      await started.promise;

      const rebind = manager.rebindSession("ios-rebind-active", "sim-b", "ios");
      await Promise.resolve();
      expect(restored).toEqual([]);

      finished.resolve();
      await setup;
      await rebind;

      expect(restored).toEqual(["enrolled"]);
    });

    test("keeps the device quarantined and retries when the restore fails", async () => {
      const timer = new FakeTimer();
      let attempts = 0;
      const manager = makeRestoringManager({
        timer,
        biometricEnrollmentRestorer: () => ({
          restore: async () => {
            attempts += 1;
            if (attempts === 1) {
              throw new Error("simctl rejected the restore");
            }
          },
        }),
      });

      await manager.createSession("ios-restore-retry", "sim-dirty", "ios");
      manager.setBiometricEnrollment("ios-restore-retry", { initialEnrollment: "not_enrolled" });

      await manager.releaseSession("ios-restore-retry");

      // The failed first attempt must leave post-release work outstanding, so
      // DevicePool defers the device instead of idling it dirty.
      const cleanup = manager.getPendingDeviceCleanup("sim-dirty");
      expect(cleanup).not.toBeNull();
      expect(attempts).toBe(1);

      await timer.advanceTimeAsync(250);
      await cleanup;
      expect(attempts).toBe(2);
      expect(manager.getPendingDeviceCleanup("sim-dirty")).toBeNull();
    });

    test("stops retrying the restore after the bounded attempts are exhausted", async () => {
      const timer = new FakeTimer();
      let attempts = 0;
      const manager = makeRestoringManager({
        timer,
        biometricEnrollmentRestorer: () => ({
          restore: async () => {
            attempts += 1;
            throw new Error("simctl rejected the restore");
          },
        }),
      });

      await manager.createSession("ios-restore-exhausted", "sim-dirty-2", "ios");
      manager.setBiometricEnrollment("ios-restore-exhausted", {
        initialEnrollment: "not_enrolled",
      });

      await manager.releaseSession("ios-restore-exhausted");
      const cleanup = manager.getPendingDeviceCleanup("sim-dirty-2");
      await timer.advanceTimeAsync(250);
      await timer.advanceTimeAsync(250);
      await cleanup;

      // One initial attempt plus the bounded retries, then the device is freed
      // rather than quarantined forever.
      expect(attempts).toBe(3);
    });
  });

  describe("biometric enrollment restoration platform independence", () => {
    test("restores cached enrollment even when the session declares a non-iOS platform", async () => {
      const restored: Array<{ deviceId: string; enrollment: string }> = [];
      const manager = makeRestoringManager({
        timer: fakeTimer,
        biometricEnrollmentRestorer: recordingBiometricRestorer(restored),
      });

      // setActiveDevice stores the caller-declared platform, which can
      // disagree with the simulator actually bound. The cached enrollment is
      // iOS-only evidence and must still be restored.
      await manager.createSession("mislabelled", "sim-1", "android");
      manager.setBiometricEnrollment("mislabelled", { initialEnrollment: "not_enrolled" });

      await manager.releaseSession("mislabelled");

      expect(restored).toEqual([{ deviceId: "sim-1", enrollment: "not_enrolled" }]);
    });
  });

  describe("biometric enrollment restoration on rebind", () => {
    test("quarantines the old simulator and retries when the rebind restore fails", async () => {
      const timer = new FakeTimer();
      const attempts: string[] = [];
      const manager = makeRestoringManager({
        timer,
        biometricEnrollmentRestorer: (device) => ({
          restore: async () => {
            attempts.push(device.deviceId);
            if (attempts.length === 1) {
              throw new Error("simctl rejected the restore");
            }
          },
        }),
      });

      await manager.createSession("ios-rebind-dirty", "sim-old", "ios");
      manager.setBiometricEnrollment("ios-rebind-dirty", { initialEnrollment: "not_enrolled" });

      await manager.rebindSession("ios-rebind-dirty", "sim-new", "ios");

      // The rebind must not complete by silently abandoning the old simulator.
      const cleanup = manager.getPendingDeviceCleanup("sim-old");
      expect(cleanup).not.toBeNull();
      expect(manager.getPendingDeviceCleanup("sim-new")).toBeNull();

      await timer.advanceTimeAsync(250);
      await cleanup;

      // The retry targets the OLD simulator even though the session has
      // already been reassigned to the new one.
      expect(attempts).toEqual(["sim-old", "sim-old"]);
    });
  });

  describe("network condition restoration (#6012)", () => {
    test("restores normal connectivity when a session that degraded the network releases", async () => {
      const restored: Array<{ deviceId: string; profile: string }> = [];
      const manager = makeRestoringManager({
        timer: fakeTimer,
        restorers: recordingNetworkRestorers(restored),
      });

      await manager.createSession("net-1", "emulator-5554", "android");
      // Write-once: the first captured baseline wins over a later change.
      manager.setNetworkCondition("net-1", { initialProfile: "none" });
      manager.setNetworkCondition("net-1", { initialProfile: "3g" });

      await manager.releaseSession("net-1");

      expect(restored).toEqual([{ deviceId: "emulator-5554", profile: "none" }]);
    });

    test("does not attempt a network restore for a session that never degraded it", async () => {
      const restored: string[] = [];
      const manager = makeRestoringManager({
        timer: fakeTimer,
        restorers: networkRestorer(async (profile) => {
          restored.push(profile);
        }),
      });

      await manager.createSession("net-clean", "emulator-5554", "android");
      await manager.releaseSession("net-clean");
      expect(restored).toEqual([]);
    });

    test("restores normal connectivity on lazy expiry, keeping the device quarantined", async () => {
      let finishRestore!: () => void;
      const restoration = new Promise<void>((resolve) => {
        finishRestore = resolve;
      });
      let restoreStarted!: () => void;
      const restorationStarted = new Promise<void>((resolve) => {
        restoreStarted = resolve;
      });
      const restored: string[] = [];
      const manager = makeRestoringManager({
        timer: fakeTimer,
        restorers: networkRestorer(async (profile) => {
          restored.push(profile);
          restoreStarted();
          await restoration;
        }),
      });

      await manager.createSession("net-expiry", "emulator-5554", "android", { timeoutMs: 1 });
      manager.setNetworkCondition("net-expiry", { initialProfile: "none" });
      fakeTimer.advanceTime(2);

      // Accessing the expired session triggers lazy expiry -> release.
      expect(manager.getSession("net-expiry")).toBeNull();
      await restorationStarted;
      expect(restored).toEqual(["none"]);

      finishRestore();
      await manager.waitForSessionRelease("net-expiry");
    });

    test("waits for a tracked network setup before restoring none on release (#6012 review P1)", async () => {
      const timer = new FakeTimer();
      const restored: string[] = [];
      const manager = makeRestoringManager({
        timer,
        restorers: networkRestorer(async (profile) => {
          restored.push(profile);
        }),
      });
      const started = Promise.withResolvers<void>();
      const finished = Promise.withResolvers<void>();

      const session = await manager.createSession("net-seq", "emulator-5554", "android");
      manager.setNetworkCondition("net-seq", { initialProfile: "none" });
      // A tracked mutation that outlives the setup-drain timeout.
      const setup = manager.trackSessionSetup(session, async () => {
        started.resolve();
        await finished.promise;
      });
      await started.promise;

      const release = manager.releaseSession("net-seq");
      // Drain timeout elapses; the still-running setup is handed off as pending.
      await timer.advanceTimeAsync(1000);
      const cleanup = manager.getPendingDeviceCleanup("emulator-5554");
      expect(cleanup).not.toBeNull();
      // Critically: the `none` restore has NOT run while the mutation may still
      // issue delay/speed commands.
      expect(restored).toEqual([]);

      finished.resolve();
      await setup;
      await release;
      await cleanup;

      // Only after the tracked mutation settles does the restore run.
      expect(restored).toEqual(["none"]);
    });

    test("keeps the device quarantined and retries when the network restore fails (#6012 review)", async () => {
      const timer = new FakeTimer();
      let attempts = 0;
      const manager = makeRestoringManager({
        timer,
        restorers: networkRestorer(async () => {
          attempts += 1;
          if (attempts === 1) {
            throw new Error("emulator console rejected the restore");
          }
        }),
      });

      await manager.createSession("net-restore-retry", "emulator-5554", "android");
      manager.setNetworkCondition("net-restore-retry", { initialProfile: "none" });

      await manager.releaseSession("net-restore-retry");

      // A failed first attempt must keep the shaped emulator quarantined, not
      // return it to the idle pool (previously deferred as #6085).
      const cleanup = manager.getPendingDeviceCleanup("emulator-5554");
      expect(cleanup).not.toBeNull();
      expect(attempts).toBe(1);

      await timer.advanceTimeAsync(250);
      await cleanup;
      expect(attempts).toBe(2);
      expect(manager.getPendingDeviceCleanup("emulator-5554")).toBeNull();
    });

    test("stops retrying the network restore after bounded attempts are exhausted", async () => {
      const timer = new FakeTimer();
      let attempts = 0;
      const manager = makeRestoringManager({
        timer,
        restorers: networkRestorer(async () => {
          attempts += 1;
          throw new Error("emulator console rejected the restore");
        }),
      });

      await manager.createSession("net-restore-exhausted", "emulator-5556", "android");
      manager.setNetworkCondition("net-restore-exhausted", { initialProfile: "none" });

      await manager.releaseSession("net-restore-exhausted");
      const cleanup = manager.getPendingDeviceCleanup("emulator-5556");
      await timer.advanceTimeAsync(250);
      await timer.advanceTimeAsync(250);
      await cleanup;

      // One initial attempt plus the two bounded retries, then the device is
      // freed rather than quarantined forever.
      expect(attempts).toBe(3);
      expect(manager.getPendingDeviceCleanup("emulator-5556")).toBeNull();
    });

    test("restores the old emulator before a session rebinds to a new device", async () => {
      const restored: Array<{ deviceId: string; profile: string }> = [];
      const manager = makeRestoringManager({
        timer: fakeTimer,
        restorers: recordingNetworkRestorers(restored),
      });

      await manager.createSession("net-rebind", "emulator-5554", "android");
      // Baseline recorded before the session degraded the network.
      manager.setNetworkCondition("net-rebind", { initialProfile: "none" });

      await manager.rebindSession("net-rebind", "emulator-5556", "android");

      expect(restored).toEqual([{ deviceId: "emulator-5554", profile: "none" }]);
      expect(manager.getNetworkCondition("net-rebind")).toBeUndefined();
    });
  });

  describe("network condition TTL scheduling (#6085 item 2)", () => {
    const makeManagerWithNetworkRestorer = (
      timer: FakeTimer,
      restored: Array<{ deviceId: string; profile: string }>,
    ): SessionManager =>
      makeRestoringManager({
        timer,
        restorers: recordingNetworkRestorers(restored),
      });

    test("resets the device to none when the per-condition TTL elapses", async () => {
      const timer = new FakeTimer();
      const restored: Array<{ deviceId: string; profile: string }> = [];
      const manager = makeManagerWithNetworkRestorer(timer, restored);

      const session = await manager.createSession("net-ttl", "emulator-5554", "android");
      manager.setNetworkCondition("net-ttl", { initialProfile: "none" });
      manager.scheduleNetworkConditionExpiry(session, 60);

      // Not yet elapsed: no restore, slot still armed.
      timer.advanceTime(59_000);
      expect(restored).toEqual([]);

      // Elapsed: the TTL resets the device to `none`, independent of release.
      timer.advanceTime(1_000);
      const cleanup = manager.getPendingDeviceCleanup("emulator-5554");
      expect(cleanup).not.toBeNull();
      await cleanup;

      expect(restored).toEqual([{ deviceId: "emulator-5554", profile: "none" }]);
      // The restore slot is cleared so a later release cannot double-restore.
      expect(manager.getNetworkCondition("net-ttl")).toBeUndefined();
    });

    test("cancels the pending TTL when the session releases before it elapses", async () => {
      const timer = new FakeTimer();
      const restored: Array<{ deviceId: string; profile: string }> = [];
      const manager = makeManagerWithNetworkRestorer(timer, restored);

      const session = await manager.createSession("net-ttl-release", "emulator-5554", "android");
      manager.setNetworkCondition("net-ttl-release", { initialProfile: "none" });
      manager.scheduleNetworkConditionExpiry(session, 60);

      // Release before the TTL: the release-restore runs exactly once.
      await manager.releaseSession("net-ttl-release");
      expect(restored).toEqual([{ deviceId: "emulator-5554", profile: "none" }]);

      // Advancing past the TTL must NOT fire a second restore (timer cancelled).
      timer.advanceTime(120_000);
      expect(manager.getPendingDeviceCleanup("emulator-5554")).toBeNull();
      expect(restored).toEqual([{ deviceId: "emulator-5554", profile: "none" }]);
    });

    test("does not double-restore when the TTL fires and then the session releases", async () => {
      const timer = new FakeTimer();
      const restored: Array<{ deviceId: string; profile: string }> = [];
      const manager = makeManagerWithNetworkRestorer(timer, restored);

      const session = await manager.createSession("net-ttl-first", "emulator-5554", "android");
      manager.setNetworkCondition("net-ttl-first", { initialProfile: "none" });
      manager.scheduleNetworkConditionExpiry(session, 60);

      // TTL fires first and restores once.
      timer.advanceTime(60_000);
      await manager.getPendingDeviceCleanup("emulator-5554");
      expect(restored).toEqual([{ deviceId: "emulator-5554", profile: "none" }]);

      // Release afterwards sees the cleared slot, so it does not restore again.
      await manager.releaseSession("net-ttl-first");
      expect(restored).toEqual([{ deviceId: "emulator-5554", profile: "none" }]);
    });

    test("cancels the pending TTL when the session rebinds before it elapses", async () => {
      const timer = new FakeTimer();
      const restored: Array<{ deviceId: string; profile: string }> = [];
      const manager = makeManagerWithNetworkRestorer(timer, restored);

      const session = await manager.createSession("net-ttl-rebind", "emulator-5554", "android");
      manager.setNetworkCondition("net-ttl-rebind", { initialProfile: "none" });
      manager.scheduleNetworkConditionExpiry(session, 60);

      // Rebind restores the old device once and discards its cache.
      await manager.rebindSession("net-ttl-rebind", "emulator-5556", "android");
      expect(restored).toEqual([{ deviceId: "emulator-5554", profile: "none" }]);

      // The TTL for the old device must not fire after the rebind cancelled it.
      timer.advanceTime(120_000);
      expect(manager.getPendingDeviceCleanup("emulator-5554")).toBeNull();
      expect(restored).toEqual([{ deviceId: "emulator-5554", profile: "none" }]);
    });

    test("re-scheduling a TTL cancels the prior timer so only the latest fires", async () => {
      const timer = new FakeTimer();
      const restored: Array<{ deviceId: string; profile: string }> = [];
      const manager = makeManagerWithNetworkRestorer(timer, restored);

      const session = await manager.createSession("net-ttl-reapply", "emulator-5554", "android");
      manager.setNetworkCondition("net-ttl-reapply", { initialProfile: "none" });
      manager.scheduleNetworkConditionExpiry(session, 60);
      // Re-apply with a longer TTL: the first (60s) timer must be cancelled.
      manager.scheduleNetworkConditionExpiry(session, 120);

      timer.advanceTime(60_000);
      expect(restored).toEqual([]);
      expect(manager.getPendingDeviceCleanup("emulator-5554")).toBeNull();

      timer.advanceTime(60_000);
      await manager.getPendingDeviceCleanup("emulator-5554");
      expect(restored).toEqual([{ deviceId: "emulator-5554", profile: "none" }]);
    });

    test("clamps an overlong TTL so it does not overflow setTimeout and fire near-immediately (#6085 item 4)", async () => {
      const timer = new FakeTimer();
      const restored: Array<{ deviceId: string; profile: string }> = [];
      const manager = makeManagerWithNetworkRestorer(timer, restored);

      const session = await manager.createSession("net-ttl-overflow", "emulator-5554", "android");
      manager.setNetworkCondition("net-ttl-overflow", { initialProfile: "none" });
      // 30 days in seconds: 30*24*3600*1000 ms overflows setTimeout's signed
      // 32-bit delay and, unclamped, would wrap to ~1ms and reset immediately.
      manager.scheduleNetworkConditionExpiry(session, 30 * 24 * 3600);

      // The armed delay is the clamped ceiling, not a wrapped tiny value.
      expect(timer.getPendingTimeouts()).toContain(2_147_483 * 1000);
      // Advancing well past the wrapped-delay window fires nothing.
      timer.advanceTime(5_000);
      expect(restored).toEqual([]);
      expect(manager.getPendingDeviceCleanup("emulator-5554")).toBeNull();
    });

    test("routes TTL expiry through the bounded retry, keeping the device quarantined on a transient failure (#6085 review)", async () => {
      const timer = new FakeTimer();
      let attempts = 0;
      const manager = makeRestoringManager({
        timer,
        restorers: networkRestorer(async () => {
          attempts += 1;
          if (attempts === 1) {
            throw new Error("emulator console transiently rejected the reset");
          }
        }),
      });

      const session = await manager.createSession("net-ttl-retry", "emulator-5554", "android");
      manager.setNetworkCondition("net-ttl-retry", { initialProfile: "none" });
      manager.scheduleNetworkConditionExpiry(session, 60);

      await timer.advanceTimeAsync(60_000);
      const cleanup = manager.getPendingDeviceCleanup("emulator-5554");
      // First attempt failed: the device stays quarantined and the slot is
      // RETAINED (not released shaped, unlike the pre-fix fire-and-forget path).
      expect(cleanup).not.toBeNull();
      expect(attempts).toBe(1);
      expect(manager.getNetworkCondition("net-ttl-retry")).toEqual({ initialProfile: "none" });

      await timer.advanceTimeAsync(250);
      await cleanup;
      // The retry succeeds; only on success is the slot cleared.
      expect(attempts).toBe(2);
      expect(manager.getNetworkCondition("net-ttl-retry")).toBeUndefined();
      expect(manager.getPendingDeviceCleanup("emulator-5554")).toBeNull();
    });

    test("retains the restore slot when TTL retries are exhausted so a later release still restores (#6085 review)", async () => {
      const timer = new FakeTimer();
      let attempts = 0;
      const manager = makeRestoringManager({
        timer,
        restorers: networkRestorer(async () => {
          attempts += 1;
          throw new Error("emulator console rejected the reset");
        }),
      });

      const session = await manager.createSession("net-ttl-exhaust", "emulator-5556", "android");
      manager.setNetworkCondition("net-ttl-exhaust", { initialProfile: "none" });
      manager.scheduleNetworkConditionExpiry(session, 60);

      await timer.advanceTimeAsync(60_000);
      const cleanup = manager.getPendingDeviceCleanup("emulator-5556");
      await timer.advanceTimeAsync(250);
      await timer.advanceTimeAsync(250);
      await cleanup;

      // One initial attempt plus two bounded retries, all rejected.
      expect(attempts).toBe(3);
      // The slot is RETAINED (not cleared) so a subsequent release retries the
      // restore rather than handing back a still-shaped emulator.
      expect(manager.getNetworkCondition("net-ttl-exhaust")).toEqual({ initialProfile: "none" });
      expect(manager.getPendingDeviceCleanup("emulator-5556")).toBeNull();
    });

    test("does not arm a stale TTL against a released same-UUID session (#6085 review)", async () => {
      const timer = new FakeTimer();
      const restored: Array<{ deviceId: string; profile: string }> = [];
      const manager = makeManagerWithNetworkRestorer(timer, restored);

      const original = await manager.createSession("net-uuid", "emulator-5554", "android");
      manager.setNetworkCondition("net-uuid", { initialProfile: "none" });
      await manager.releaseSession("net-uuid");
      // The release-restore ran once.
      expect(restored).toEqual([{ deviceId: "emulator-5554", profile: "none" }]);

      // A late/stale setup tries to arm a TTL against the now-released instance:
      // the identity guard must refuse to arm it (a same-UUID replacement must
      // never inherit this stale timer).
      manager.scheduleNetworkConditionExpiry(original, 60);
      expect(timer.getPendingTimeoutCount()).toBe(0);

      timer.advanceTime(120_000);
      expect(manager.getPendingDeviceCleanup("emulator-5554")).toBeNull();
      expect(restored).toEqual([{ deviceId: "emulator-5554", profile: "none" }]);
    });

    test("a stale TTL (A) whose restore is still pending must not clobber a newer condition's (B's) restore slot (#6177)", async () => {
      const timer = new FakeTimer();
      const restoreCalls: string[] = [];
      let releaseFirstRestore: (() => void) | undefined;
      const manager = makeRestoringManager({
        timer,
        restorers: networkRestorer(async (profile) => {
          restoreCalls.push(profile);
          if (restoreCalls.length === 1) {
            // Condition A's TTL-expiry restore: deferred so the test can apply
            // condition B while it is still in flight.
            await new Promise<void>((resolve) => {
              releaseFirstRestore = resolve;
            });
          }
        }),
      });

      const sessionId = "net-ttl-generation";
      const session = await manager.createSession(sessionId, "emulator-5554", "android");

      // Apply condition A with a 60s TTL.
      manager.bumpNetworkConditionGeneration(sessionId);
      manager.setNetworkCondition(sessionId, { initialProfile: "none" });
      manager.scheduleNetworkConditionExpiry(session, 60);

      // A's TTL fires: its restore starts but hangs (deferred above).
      timer.advanceTime(60_000);
      const aCleanup = manager.getPendingDeviceCleanup("emulator-5554");
      expect(aCleanup).not.toBeNull();
      expect(restoreCalls).toEqual(["none"]);

      // While A's restore is still pending, condition B is applied on the same
      // session — bumping the generation and arming its own TTL, exactly as
      // runSessionNetworkMutation does for a real setDeviceState call.
      manager.bumpNetworkConditionGeneration(sessionId);
      manager.cancelNetworkConditionExpiry(sessionId);
      manager.scheduleNetworkConditionExpiry(session, 60);

      // A's deferred restore now settles. Its completion must detect it was
      // superseded and must NOT clear B's restore slot.
      releaseFirstRestore?.();
      await aCleanup;
      expect(manager.getNetworkCondition(sessionId)).toEqual({ initialProfile: "none" });

      // A later release must still restore the device — B's slot survived, so
      // the device is not handed back to the pool still shaped.
      await manager.releaseSession(sessionId);
      expect(restoreCalls).toEqual(["none", "none"]);
      expect(manager.getNetworkCondition(sessionId)).toBeUndefined();
    });

    test("a TTL captures the OWNING mutation's generation, not the shared counter re-read after a later mutation bumps it, across a three-way A/B/C overlap (#6181 review)", async () => {
      const timer = new FakeTimer();
      const restoreCalls: string[] = [];
      let releaseDeferredRestore: (() => void) | undefined;
      const manager = makeRestoringManager({
        timer,
        restorers: networkRestorer(async (profile) => {
          restoreCalls.push(profile);
          if (restoreCalls.length === 1) {
            // Condition B's TTL-expiry restore: deferred so condition C can be
            // applied while it is still in flight.
            await new Promise<void>((resolve) => {
              releaseDeferredRestore = resolve;
            });
          }
        }),
      });

      const sessionId = "net-ttl-three-way-generation";
      const session = await manager.createSession(sessionId, "emulator-5554", "android");

      // Condition A: establishes the restore slot at generation 1.
      manager.bumpNetworkConditionGeneration(sessionId);
      manager.setNetworkCondition(sessionId, { initialProfile: "none" });

      // Condition B's mutation begins: it bumps to generation 2 and captures
      // that value — exactly as runSessionNetworkMutation does — BEFORE its
      // own (slow) mutation resolves.
      const genB = manager.bumpNetworkConditionGeneration(sessionId);
      expect(genB).toBe(2);

      // Condition C's mutation ALSO begins and bumps to generation 3 while
      // B's mutation is still conceptually in flight — the exact interleaving
      // the review flagged: the shared counter has moved past B's own value
      // before B ever reaches its schedule call.
      const genC = manager.bumpNetworkConditionGeneration(sessionId);
      expect(genC).toBe(3);

      // B's mutation resolves first and arms a short TTL. It must be tagged
      // with B's OWN captured generation (2) — a re-read of "current" here
      // would wrongly pick up 3.
      manager.scheduleNetworkConditionExpiry(session, 10, genB);

      // B's TTL fires: its restore starts but hangs (deferred above). This
      // also removes B's timer entry, so there is nothing left to cancel.
      timer.advanceTime(10_000);
      const bCleanup = manager.getPendingDeviceCleanup("emulator-5554");
      expect(bCleanup).not.toBeNull();
      expect(restoreCalls).toEqual(["none"]);

      // C's mutation resolves after B's TTL has already fired and is still
      // awaiting its restore, and arms its own TTL at its own generation.
      manager.scheduleNetworkConditionExpiry(session, 100, genC);

      // B's deferred restore now settles. With the OWNING generation (2)
      // correctly captured, it must detect the mismatch against the current
      // generation (3) and NOT clear C's restore slot.
      releaseDeferredRestore?.();
      await bCleanup;
      expect(manager.getNetworkCondition(sessionId)).toEqual({ initialProfile: "none" });

      // A later release must still restore the device — C's slot survived, so
      // the device is not handed back to the pool still shaped.
      await manager.releaseSession(sessionId);
      expect(restoreCalls).toEqual(["none", "none"]);
      expect(manager.getNetworkCondition(sessionId)).toBeUndefined();
    });
  });
});
