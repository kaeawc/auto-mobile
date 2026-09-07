import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { SessionManager } from "../../src/daemon/sessionManager";
import { DevicePool } from "../../src/daemon/devicePool";
import { createToolExecutionContext } from "../../src/server/ToolExecutionContext";
import { AndroidCtrlProxyManager } from "../../src/utils/CtrlProxyManager";
import { AndroidCtrlProxyClient } from "../../src/features/observe/android";
import {
  installNoOpReadinessDriver,
  setDeviceReadinessProxyDriverProviderForTesting,
} from "../helpers/stubCtrlProxySetup";
import { KeepScreenAwakeManager } from "../../src/utils/KeepScreenAwakeManager";
import { serverConfig } from "../../src/utils/ServerConfig";
import {
  acquireDeviceReadinessLock,
  deviceReadinessLockKey,
  trackDeviceAcquisitionReadiness,
} from "../../src/utils/deviceReadinessLock";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import type { BootedDevice, DeviceInfo } from "../../src/models";
import type { DeviceSession } from "../../src/db/types";

describe("ToolExecutionContext", () => {
  let sessionManager: SessionManager;
  let devicePool: DevicePool;
  let fakeAppsRepo: FakeInstalledAppsRepository;
  let fakeTimer: FakeTimer;
  let fakeDeviceManager: FakeDeviceManager;
  let originalGetInstance: typeof AndroidCtrlProxyManager.getInstance;
  let originalClientGetInstance: typeof AndroidCtrlProxyClient.getInstance;
  const sessionOptions = { keepScreenAwake: false };
  const createBootedDevice = (deviceId: string): BootedDevice => ({
    name: deviceId,
    platform: "android",
    deviceId,
  });

  beforeEach(async () => {
    fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    sessionManager = new SessionManager(fakeTimer, new FakeDeviceSessionPersistence());
    fakeAppsRepo = new FakeInstalledAppsRepository();
    fakeDeviceManager = new FakeDeviceManager();
    devicePool = new DevicePool(
      sessionManager,
      "test-daemon-session-id",
      fakeTimer,
      fakeAppsRepo,
      fakeDeviceManager,
    );
    await devicePool.initializeWithDevices([createBootedDevice("device-1")]);
    originalGetInstance = AndroidCtrlProxyManager.getInstance;
    originalClientGetInstance = AndroidCtrlProxyClient.getInstance;

    // These tests exercise the real `ensureAccessibilityServiceReady` path and
    // stub setup via the `AndroidCtrlProxyManager`/`AndroidCtrlProxyClient`
    // `getInstance` statics per test. Restore the real readiness driver (which
    // routes through those statics) so the overrides take effect; the shared
    // preload's no-op driver (#6227) is re-installed in `afterEach` so the rest
    // of the process stays neutralized.
    setDeviceReadinessProxyDriverProviderForTesting(null);

    // Reset AndroidCtrlProxyClient instances for clean test state
    AndroidCtrlProxyClient.resetInstances();
  });

  afterEach(() => {
    sessionManager.stopCleanupTimer();
    AndroidCtrlProxyManager.getInstance = originalGetInstance;
    AndroidCtrlProxyClient.getInstance = originalClientGetInstance;
    AndroidCtrlProxyClient.resetInstances();
    installNoOpReadinessDriver();
  });

  test("should run accessibility setup when creating a new session", async () => {
    let setupCalls = 0;
    AndroidCtrlProxyManager.getInstance = () =>
      ({
        resetSetupState: () => {},
        setup: async () => {
          setupCalls += 1;
          return { success: true, message: "ok" };
        },
      }) as any;

    const clientCallArgs: unknown[] = [];
    AndroidCtrlProxyClient.getInstance = ((device: unknown) => {
      clientCallArgs.push(device);
      return {
        waitForConnection: async () => true,
        close: async () => {},
      };
    }) as any;

    const context = await createToolExecutionContext(
      "session-1",
      sessionManager,
      devicePool,
      sessionOptions,
    );

    expect(context.deviceId).toBe("device-1");
    expect(setupCalls).toBe(1);
    expect(clientCallArgs.length).toBeGreaterThan(0);
    const passed = clientCallArgs[0] as BootedDevice;
    expect(typeof passed).toBe("object");
    expect(passed.deviceId).toBe("device-1");
    expect(passed.platform).toBe("android");
  });

  test("does not run accessibility setup when a pooled emulator serial is stale", async () => {
    const staleDeviceManager = new FakeDeviceManager();
    const stalePool = new DevicePool(
      sessionManager,
      "test-daemon-session-id",
      fakeTimer,
      fakeAppsRepo,
      staleDeviceManager,
    );
    await stalePool.initializeWithDevices([createBootedDevice("emulator-5554")]);
    staleDeviceManager.bootedDevices = [];

    let setupCalls = 0;
    AndroidCtrlProxyManager.getInstance = () =>
      ({
        resetSetupState: () => {},
        setup: async () => {
          setupCalls += 1;
          return { success: true, message: "ok" };
        },
      }) as any;

    await expect(
      createToolExecutionContext("session-stale", sessionManager, stalePool, sessionOptions),
    ).rejects.toThrow(/No devices in pool|not available|disconnected/);
    expect(setupCalls).toBe(0);
    expect(stalePool.getDevice("emulator-5554")).toBeNull();
  });

  test("writes the keep-awake state to the typed keepScreenAwake slot on setup (#2973)", async () => {
    AndroidCtrlProxyManager.getInstance = () =>
      ({
        resetSetupState: () => {},
        setup: async () => ({ success: true, message: "ok" }),
      }) as any;
    AndroidCtrlProxyClient.getInstance = (() => ({
      waitForConnection: async () => true,
      close: async () => {},
    })) as any;

    // keepScreenAwake:false → apply() short-circuits to an applied:false state,
    // which ensureKeepScreenAwake must persist to the typed slot (not customData).
    await createToolExecutionContext("session-1", sessionManager, devicePool, sessionOptions);

    const state = sessionManager.getKeepScreenAwake("session-1");
    expect(state).toBeDefined();
    expect(state!.applied).toBe(false);
    expect(
      (sessionManager.getSessionCache("session-1") as Record<string, unknown>).customData,
    ).toBeUndefined();
  });

  // #6227: the persisted daemon-session path (ToolRegistry passing sessionUuid
  // into createToolExecutionContext) must honor a tool's declared
  // deviceReadiness the same way the legacy/no-session path already does via
  // DeviceSessionManager.ensureDeviceReady's `readiness` option.
  test("skips accessibility setup for a new session when deviceReadiness is booted (#6227)", async () => {
    let setupCalls = 0;
    AndroidCtrlProxyManager.getInstance = () =>
      ({
        resetSetupState: () => {},
        setup: async () => {
          setupCalls += 1;
          return { success: true, message: "ok" };
        },
      }) as any;

    const context = await createToolExecutionContext("session-1", sessionManager, devicePool, {
      ...sessionOptions,
      deviceReadiness: "booted",
    });

    expect(context.deviceId).toBe("device-1");
    expect(setupCalls).toBe(0);
  });

  test("still runs accessibility setup for a new session when deviceReadiness is automationReady (#6227)", async () => {
    let setupCalls = 0;
    AndroidCtrlProxyManager.getInstance = () =>
      ({
        resetSetupState: () => {},
        setup: async () => {
          setupCalls += 1;
          return { success: true, message: "ok" };
        },
      }) as any;
    AndroidCtrlProxyClient.getInstance = (() => ({
      waitForConnection: async () => true,
      close: async () => {},
    })) as any;

    const context = await createToolExecutionContext("session-1", sessionManager, devicePool, {
      ...sessionOptions,
      deviceReadiness: "automationReady",
    });

    expect(context.deviceId).toBe("device-1");
    expect(setupCalls).toBe(1);
  });

  test("a tool not requiring readiness (deviceReadiness omitted) is unaffected on the persisted path (#6227)", async () => {
    let setupCalls = 0;
    AndroidCtrlProxyManager.getInstance = () =>
      ({
        resetSetupState: () => {},
        setup: async () => {
          setupCalls += 1;
          return { success: true, message: "ok" };
        },
      }) as any;
    AndroidCtrlProxyClient.getInstance = (() => ({
      waitForConnection: async () => true,
      close: async () => {},
    })) as any;

    // No deviceReadiness set — behaves exactly as before this fix (default
    // automationReady semantics), for both a new session...
    const freshContext = await createToolExecutionContext(
      "session-1",
      sessionManager,
      devicePool,
      sessionOptions,
    );
    expect(freshContext.deviceId).toBe("device-1");
    expect(setupCalls).toBe(1);

    // ...and an already-established session (existingSession short-circuit,
    // unrelated to deviceReadiness).
    const existingContext = await createToolExecutionContext(
      "session-1",
      sessionManager,
      devicePool,
      sessionOptions,
    );
    expect(existingContext.deviceId).toBe("device-1");
    expect(setupCalls).toBe(1);
  });

  // #6227 P1 (round 5): a NORMAL freshly-acquired session (getAndroid /
  // startDevice) already ran `prepareStartDeviceRunnerReadiness` — CtrlProxy /
  // accessibility-service setup genuinely completed — before the session was
  // bound. The acquisition/binding path now records that achieved level via
  // `setDeviceReadiness` at bind time (mirroring what `bindBootedDeviceSession`
  // in deviceTools.ts does), so the first subsequent `automationReady` tool
  // call must NOT see `undefined` and redundantly re-run setup.
  test("does not redundantly re-run setup for a session whose readiness was recorded at acquisition (#6227 round 5 P1)", async () => {
    let setupCalls = 0;
    AndroidCtrlProxyManager.getInstance = () =>
      ({
        resetSetupState: () => {},
        setup: async () => {
          setupCalls += 1;
          return { success: true, message: "ok" };
        },
      }) as any;
    AndroidCtrlProxyClient.getInstance = (() => ({
      waitForConnection: async () => true,
      close: async () => {},
    })) as any;

    // Simulate the acquisition/binding path: the session is created and its
    // achieved readiness is recorded (as `bindBootedDeviceSession` now does)
    // BEFORE any tool call reaches `createToolExecutionContext`.
    await sessionManager.createSession("session-acquired", "device-1", "android");
    sessionManager.setDeviceReadiness("session-acquired", "automationReady");

    const context = await createToolExecutionContext(
      "session-acquired",
      sessionManager,
      devicePool,
      {
        ...sessionOptions,
        deviceReadiness: "automationReady",
      },
    );

    expect(context.deviceId).toBe("device-1");
    expect(setupCalls).toBe(0);
  });

  // Companion case: a session recovered without its readiness genuinely
  // re-established (e.g. mid-recovery, unrecorded) must still be treated as
  // not-ready and run setup — the acquisition-time recording above must not
  // widen the concurrency-hole fix in `isReadinessSatisfied`.
  test("still runs setup for a genuinely-unrecorded recovered session (#6227 round 5 P1)", async () => {
    let setupCalls = 0;
    AndroidCtrlProxyManager.getInstance = () =>
      ({
        resetSetupState: () => {},
        setup: async () => {
          setupCalls += 1;
          return { success: true, message: "ok" };
        },
      }) as any;
    AndroidCtrlProxyClient.getInstance = (() => ({
      waitForConnection: async () => true,
      close: async () => {},
    })) as any;

    // No `setDeviceReadiness` call here — this session's readiness was never
    // recorded, mirroring a recovered session whose acquisition never
    // completed `prepareStartDeviceRunnerReadiness` cleanly.
    await sessionManager.createSession("session-unrecorded-recovery", "device-1", "android");

    const context = await createToolExecutionContext(
      "session-unrecorded-recovery",
      sessionManager,
      devicePool,
      { ...sessionOptions, deviceReadiness: "automationReady" },
    );

    expect(context.deviceId).toBe("device-1");
    expect(setupCalls).toBe(1);
  });

  // #6227 P1 follow-up: a session first reached via a `booted` tool must be
  // *upgraded* — not left disconnected — when a later call on the same
  // sessionUuid needs `automationReady`. The `existingSession` fast path must
  // not silently satisfy a stricter readiness requirement than the session
  // actually achieved.
  test("upgrades a booted-only session to automationReady when a later call needs it (#6227)", async () => {
    let setupCalls = 0;
    AndroidCtrlProxyManager.getInstance = () =>
      ({
        resetSetupState: () => {},
        setup: async () => {
          setupCalls += 1;
          return { success: true, message: "ok" };
        },
      }) as any;
    AndroidCtrlProxyClient.getInstance = (() => ({
      waitForConnection: async () => true,
      close: async () => {},
    })) as any;

    const bootedContext = await createToolExecutionContext(
      "session-1",
      sessionManager,
      devicePool,
      {
        ...sessionOptions,
        deviceReadiness: "booted",
      },
    );
    expect(bootedContext.deviceId).toBe("device-1");
    expect(setupCalls).toBe(0);
    expect(sessionManager.getDeviceReadiness("session-1")).toBe("booted");

    // Same sessionUuid, now via an automationReady tool — must run setup
    // (upgrade), not take the existingSession skip path.
    const upgradedContext = await createToolExecutionContext(
      "session-1",
      sessionManager,
      devicePool,
      {
        ...sessionOptions,
        deviceReadiness: "automationReady",
      },
    );
    expect(upgradedContext.deviceId).toBe("device-1");
    expect(setupCalls).toBe(1);
    expect(sessionManager.getDeviceReadiness("session-1")).toBe("automationReady");
  });

  test("does not redundantly re-run setup for a booted tool after an automationReady session (#6227)", async () => {
    let setupCalls = 0;
    AndroidCtrlProxyManager.getInstance = () =>
      ({
        resetSetupState: () => {},
        setup: async () => {
          setupCalls += 1;
          return { success: true, message: "ok" };
        },
      }) as any;
    AndroidCtrlProxyClient.getInstance = (() => ({
      waitForConnection: async () => true,
      close: async () => {},
    })) as any;

    const readyContext = await createToolExecutionContext("session-1", sessionManager, devicePool, {
      ...sessionOptions,
      deviceReadiness: "automationReady",
    });
    expect(readyContext.deviceId).toBe("device-1");
    expect(setupCalls).toBe(1);

    // Same sessionUuid, now via a booted-only tool — must NOT downgrade or
    // redundantly redo setup.
    const bootedContext = await createToolExecutionContext(
      "session-1",
      sessionManager,
      devicePool,
      {
        ...sessionOptions,
        deviceReadiness: "booted",
      },
    );
    expect(bootedContext.deviceId).toBe("device-1");
    expect(setupCalls).toBe(1);
    expect(sessionManager.getDeviceReadiness("session-1")).toBe("automationReady");
  });

  // #6227 P1 follow-up: a concurrency window where a `booted` request
  // publishes the recovered session into `SessionManager`'s in-memory map
  // (`this.sessions.set(...)`) and then pauses in `ensureKeepScreenAwake`
  // *before* recording its readiness. A concurrent `automationReady` request
  // that resolves the same sessionUuid in that window must NOT treat the
  // still-undefined recorded readiness as satisfied and skip setup.
  test("runs setup for a concurrent automationReady call that observes a published-but-unrecorded session (#6227)", async () => {
    let setupCalls = 0;
    AndroidCtrlProxyManager.getInstance = () =>
      ({
        resetSetupState: () => {},
        setup: async () => {
          setupCalls += 1;
          return { success: true, message: "ok" };
        },
      }) as any;
    AndroidCtrlProxyClient.getInstance = (() => ({
      waitForConnection: async () => true,
      close: async () => {},
    })) as any;

    // Simulate the race directly: a session already published into the
    // SessionManager's in-memory map (as `createSession` does), but with its
    // deviceReadiness NOT YET recorded — exactly the state a concurrent
    // `booted` request's session is in after publish but before
    // `runDeviceReadinessSetup` records the level.
    await sessionManager.createSession("session-race-window", "device-1", "android");
    expect(sessionManager.getDeviceReadiness("session-race-window")).toBeUndefined();

    // A concurrent automationReady request resolves this same session as
    // "existing" and must run setup rather than trusting the unrecorded
    // readiness.
    const context = await createToolExecutionContext(
      "session-race-window",
      sessionManager,
      devicePool,
      {
        ...sessionOptions,
        deviceReadiness: "automationReady",
      },
    );

    expect(context.deviceId).toBe("device-1");
    expect(setupCalls).toBe(1);
    expect(sessionManager.getDeviceReadiness("session-race-window")).toBe("automationReady");
  });

  // #6227 P1 review follow-up: two `automationReady` calls that reach a
  // freshly-published session (readiness still undefined) *concurrently* must
  // NOT both run `runDeviceReadinessSetup` — the second observing the first
  // mid-setup would call `resetSetupState()` on the shared per-device
  // CtrlProxy manager while the first's `setup()` is still in flight. Setup
  // must run exactly once (single-flight), and both callers must observe the
  // upgraded readiness once it resolves.
  test("serializes concurrent automationReady upgrades on the same session so setup runs exactly once (#6227)", async () => {
    let setupCalls = 0;
    let resetCalls = 0;
    let releaseSetup!: () => void;
    const setupGate = new Promise<void>((resolve) => {
      releaseSetup = resolve;
    });
    let setupEnteredResolve!: () => void;
    const setupEntered = new Promise<void>((resolve) => {
      setupEnteredResolve = resolve;
    });

    AndroidCtrlProxyManager.getInstance = () =>
      ({
        resetSetupState: () => {
          resetCalls += 1;
        },
        setup: async () => {
          setupCalls += 1;
          setupEnteredResolve();
          await setupGate;
          return { success: true, message: "ok" };
        },
      }) as any;
    AndroidCtrlProxyClient.getInstance = (() => ({
      waitForConnection: async () => true,
      close: async () => {},
    })) as any;

    // Publish the session with readiness NOT YET recorded — the same window
    // a recovered/newly-published session sits in before this module's own
    // setup pass records a level.
    await sessionManager.createSession("session-race-concurrent", "device-1", "android");
    expect(sessionManager.getDeviceReadiness("session-race-concurrent")).toBeUndefined();

    const call1 = createToolExecutionContext(
      "session-race-concurrent",
      sessionManager,
      devicePool,
      { ...sessionOptions, deviceReadiness: "automationReady" },
    );

    // Let call1 run until it has actually entered `setup()` (i.e. it has
    // already registered itself as the in-flight upgrade for this session)
    // before starting the second, concurrent caller.
    await setupEntered;

    const call2 = createToolExecutionContext(
      "session-race-concurrent",
      sessionManager,
      devicePool,
      { ...sessionOptions, deviceReadiness: "automationReady" },
    );

    // Give call2 a chance to observe the in-flight upgrade and start
    // awaiting it, then let the single in-flight setup complete.
    await Promise.resolve();
    await Promise.resolve();
    releaseSetup();

    const [context1, context2] = await Promise.all([call1, call2]);

    expect(context1.deviceId).toBe("device-1");
    expect(context2.deviceId).toBe("device-1");
    expect(setupCalls).toBe(1);
    expect(resetCalls).toBe(1);
    expect(sessionManager.getDeviceReadiness("session-race-concurrent")).toBe("automationReady");
  });

  // #6227 P1 follow-up (round 3): the round-2 single-flight above only
  // serialized the *existing-session upgrade* path. A brand-new sessionUuid
  // that two callers race for concurrently hits a second, unguarded hole:
  // `getSessionForNewExecution` returns `null` (existingSession) for BOTH
  // callers before either's `getOrCreateSession` call has published the
  // session, so both `setupSession` invocations take the *fresh-session*
  // branch (`existingSession === session` is false for both) — and, before
  // this fix, that branch called `runDeviceReadinessSetup` directly,
  // unguarded by `readinessUpgradeInFlight`. Both callers join the same
  // `pendingSessionAssignments` entry (so they resolve to the identical
  // `Session` object), then both would concurrently call
  // `resetSetupState()`/`setup()` on the shared per-device CtrlProxy manager.
  // Routing the fresh-session branch through `ensureReadinessUpgraded` too
  // (same map, keyed by `session.sessionId`) closes this: setup must run
  // exactly once even when both concurrent callers take the fresh path.
  test("routes concurrent fresh-session setups for the same new sessionUuid through the single-flight so setup runs exactly once (#6227)", async () => {
    let setupCalls = 0;
    let resetCalls = 0;
    let releaseSetup!: () => void;
    const setupGate = new Promise<void>((resolve) => {
      releaseSetup = resolve;
    });
    let setupEnteredResolve!: () => void;
    const setupEntered = new Promise<void>((resolve) => {
      setupEnteredResolve = resolve;
    });

    AndroidCtrlProxyManager.getInstance = () =>
      ({
        resetSetupState: () => {
          resetCalls += 1;
        },
        setup: async () => {
          setupCalls += 1;
          setupEnteredResolve();
          await setupGate;
          return { success: true, message: "ok" };
        },
      }) as any;
    AndroidCtrlProxyClient.getInstance = (() => ({
      waitForConnection: async () => true,
      close: async () => {},
    })) as any;

    // Neither call awaits before the other starts: both synchronously
    // observe `getSessionForNewExecution` returning `null` for this
    // never-before-seen sessionUuid, then join the same
    // `pendingSessionAssignments` entry once the second call reaches it —
    // exactly the race described above.
    const call1 = createToolExecutionContext(
      "session-race-fresh-both",
      sessionManager,
      devicePool,
      { ...sessionOptions, deviceReadiness: "automationReady" },
    );
    const call2 = createToolExecutionContext(
      "session-race-fresh-both",
      sessionManager,
      devicePool,
      { ...sessionOptions, deviceReadiness: "automationReady" },
    );

    // Let the single in-flight setup actually enter `setup()` before
    // releasing it, then give any second (would-be) caller a chance to
    // observe the in-flight upgrade before it completes.
    await setupEntered;
    await Promise.resolve();
    await Promise.resolve();
    releaseSetup();

    const [context1, context2] = await Promise.all([call1, call2]);

    expect(context1.deviceId).toBe("device-1");
    expect(context2.deviceId).toBe("device-1");
    expect(setupCalls).toBe(1);
    expect(resetCalls).toBe(1);
    expect(sessionManager.getDeviceReadiness("session-race-fresh-both")).toBe("automationReady");
  });

  // #6227 P1 follow-up (round 4): a `booted`-only caller (e.g. `listApps`)
  // must not join — or fail because of — an in-flight `automationReady`
  // setup started by a concurrent caller for the same session. Reaching
  // `ensureReadinessUpgraded` already implies the device itself is booted
  // (`devicePool.assertSessionReadyForAutomation` ran earlier), so a booted
  // caller has nothing to gain from waiting on stricter automation setup and
  // must not inherit its rejection.
  test("a concurrent booted call bypasses (and does not fail from) an in-flight automationReady setup that later rejects (#6227)", async () => {
    let automationSetupCalls = 0;
    let setupEnteredResolve!: () => void;
    const setupEntered = new Promise<void>((resolve) => {
      setupEnteredResolve = resolve;
    });
    let triggerReject!: () => void;
    const rejectSignal = new Promise<void>((resolve) => {
      triggerReject = resolve;
    });

    AndroidCtrlProxyManager.getInstance = () =>
      ({
        resetSetupState: () => {},
        setup: async () => {
          automationSetupCalls += 1;
          setupEnteredResolve();
          await rejectSignal;
          throw new Error("simulated automation setup failure");
        },
      }) as any;
    AndroidCtrlProxyClient.getInstance = (() => ({
      waitForConnection: async () => true,
      close: async () => {},
    })) as any;

    await sessionManager.createSession("session-booted-bypass", "device-1", "android");

    const automationCall = createToolExecutionContext(
      "session-booted-bypass",
      sessionManager,
      devicePool,
      { ...sessionOptions, deviceReadiness: "automationReady" },
    );

    // Let the automationReady call actually enter (and register as the
    // in-flight upgrade for) setup before the concurrent booted call starts.
    await setupEntered;

    const bootedContext = await createToolExecutionContext(
      "session-booted-bypass",
      sessionManager,
      devicePool,
      { ...sessionOptions, deviceReadiness: "booted" },
    );

    // The booted call must succeed without waiting for the still-pending
    // automationReady setup, and must record the booted baseline itself.
    expect(bootedContext.deviceId).toBe("device-1");
    expect(sessionManager.getDeviceReadiness("session-booted-bypass")).toBe("booted");

    // Now let the automationReady setup actually reject — the booted call
    // above already resolved and must be unaffected by this.
    triggerReject();
    await expect(automationCall).rejects.toThrow();
    expect(automationSetupCalls).toBe(1);
  });

  // #6227 P2 follow-up: the single-flight map must be scoped to the session
  // INCARNATION, not the bare session UUID. A recreated session with the
  // same UUID (e.g. restart recovery re-binding it after a nonterminal
  // release's setup-drain timeout) must never join a stale flight left
  // behind by its predecessor.
  test("scopes the readiness single-flight to the session incarnation, not the bare UUID (#6227 P2 follow-up)", async () => {
    let setupCalls = 0;
    let oldEnteredResolve!: () => void;
    const oldEntered = new Promise<void>((resolve) => {
      oldEnteredResolve = resolve;
    });
    let releaseOldGate!: () => void;
    const oldGate = new Promise<void>((resolve) => {
      releaseOldGate = resolve;
    });
    let mode: "old" | "new" = "old";

    AndroidCtrlProxyManager.getInstance = () =>
      ({
        resetSetupState: () => {},
        setup: async () => {
          setupCalls += 1;
          if (mode === "old") {
            oldEnteredResolve();
            await oldGate;
          }
          return { success: true, message: "ok" };
        },
      }) as any;
    AndroidCtrlProxyClient.getInstance = (() => ({
      waitForConnection: async () => true,
      close: async () => {},
    })) as any;

    const original = await sessionManager.createSession(
      "session-incarnation-scope",
      "device-1",
      "android",
    );

    // The old incarnation's readiness setup starts and hangs mid-flight — it
    // is never released within this test, standing in for setup that is
    // still pending when the release below reaches its drain timeout.
    const oldCall = createToolExecutionContext(
      "session-incarnation-scope",
      sessionManager,
      devicePool,
      { ...sessionOptions, deviceReadiness: "automationReady" },
      undefined,
      original,
    );
    await oldEntered;

    // A nonterminal release reaches the ~1s setup-drain timeout while the
    // old incarnation's setup is still pending, and proceeds anyway
    // (fakeTimer auto-advance fires the drain timeout without a real wait).
    await sessionManager.releaseSession("session-incarnation-scope");

    // The UUID is recreated as a brand-new incarnation (e.g. restart
    // recovery re-binding it, possibly to a different device).
    const replacement = await sessionManager.createSession(
      "session-incarnation-scope",
      "device-1",
      "android",
    );
    expect(replacement).not.toBe(original);
    mode = "new";

    // The replacement must start its OWN flight rather than joining (and
    // resolving from) the predecessor's still-pending one. It queues behind the
    // old incarnation on the shared per-device readiness lock (#6227 FIX 2), so
    // release the old (now-released) incarnation's hung setup to free that lock;
    // the replacement then runs its own setup (setupCalls -> 2) rather than the
    // predecessor's.
    const newContextPromise = createToolExecutionContext(
      "session-incarnation-scope",
      sessionManager,
      devicePool,
      { ...sessionOptions, deviceReadiness: "automationReady" },
      undefined,
      replacement,
    );

    releaseOldGate();
    await oldCall.catch(() => {
      // The old incarnation's own call is expected to fail once its setup
      // finally resolves against an already-released session; only the
      // replacement's outcome is under test here.
    });

    const newContext = await newContextPromise;

    expect(newContext.deviceId).toBe("device-1");
    expect(setupCalls).toBe(2);
    expect(sessionManager.getDeviceReadiness("session-incarnation-scope")).toBe("automationReady");
  });

  // #6227 P1 review follow-up: the readiness UPGRADE path must honor
  // `--skip-ctrl-proxy-download` exactly as the fresh acquisition path does.
  // A booted-only session upgraded to automationReady while downloads are
  // disabled and CtrlProxy is NOT installed must refuse (actionable error)
  // rather than trigger `setup()`'s download/install of the missing artifact.
  test("does not download CtrlProxy when upgrading a booted-only session while --skip-ctrl-proxy-download is set (#6227)", async () => {
    let setupCalls = 0;
    let installed = false;
    let versionCompatible = true;
    AndroidCtrlProxyManager.getInstance = () =>
      ({
        resetSetupState: () => {},
        isInstalled: async () => installed,
        isVersionCompatible: async () => versionCompatible,
        setup: async () => {
          setupCalls += 1;
          return { success: true, message: "ok" };
        },
      }) as any;
    AndroidCtrlProxyClient.getInstance = (() => ({
      waitForConnection: async () => true,
      close: async () => {},
    })) as any;

    serverConfig.setSkipCtrlProxyDownload(true);
    try {
      // A booted-only first touch skips accessibility setup entirely.
      const bootedContext = await createToolExecutionContext(
        "session-skip-dl",
        sessionManager,
        devicePool,
        { ...sessionOptions, deviceReadiness: "booted" },
      );
      expect(bootedContext.deviceId).toBe("device-1");
      expect(setupCalls).toBe(0);
      expect(sessionManager.getDeviceReadiness("session-skip-dl")).toBe("booted");

      // Upgrade to automationReady while CtrlProxy is NOT installed: the fresh
      // path fails here rather than downloading, so the upgrade must too —
      // `setup()` (the download/install path) must never run.
      await expect(
        createToolExecutionContext("session-skip-dl", sessionManager, devicePool, {
          ...sessionOptions,
          deviceReadiness: "automationReady",
        }),
      ).rejects.toThrow(/not installed and runner downloads are disabled/);
      expect(setupCalls).toBe(0);
      expect(sessionManager.getDeviceReadiness("session-skip-dl")).toBe("booted");

      // Installed but INCOMPATIBLE version: downloads are disabled, so the
      // incompatible proxy cannot be upgraded. The upgrade must refuse with the
      // version-mismatch actionable error rather than run `setup()` against the
      // incompatible installed proxy.
      installed = true;
      versionCompatible = false;
      await expect(
        createToolExecutionContext("session-skip-dl", sessionManager, devicePool, {
          ...sessionOptions,
          deviceReadiness: "automationReady",
        }),
      ).rejects.toThrow(/CtrlProxy version mismatch/);
      expect(setupCalls).toBe(0);
      expect(sessionManager.getDeviceReadiness("session-skip-dl")).toBe("booted");

      // With the artifact already present AND compatible, the upgrade proceeds
      // without a download (setup runs against an installed package).
      versionCompatible = true;
      const upgraded = await createToolExecutionContext(
        "session-skip-dl",
        sessionManager,
        devicePool,
        { ...sessionOptions, deviceReadiness: "automationReady" },
      );
      expect(upgraded.deviceId).toBe("device-1");
      expect(setupCalls).toBe(1);
      expect(sessionManager.getDeviceReadiness("session-skip-dl")).toBe("automationReady");
    } finally {
      serverConfig.setSkipCtrlProxyDownload(false);
    }
  });

  // #6227 P1 review follow-up: a session-scoped readiness upgrade must
  // participate in the SAME per-device readiness lock the acquisition paths
  // (startDevice/getAndroid/provision, via RunnerReadinessService) hold while
  // preparing a device, so an upgrade and a concurrent device preparation
  // never both reset+setup the shared per-device CtrlProxy manager. Here a
  // concurrent device preparation holds that lock; the upgrade must not run
  // accessibility setup until the preparation releases it.
  test("serializes a session upgrade behind a concurrent device preparation holding the per-device readiness lock (#6227)", async () => {
    let setupCalls = 0;
    AndroidCtrlProxyManager.getInstance = () =>
      ({
        resetSetupState: () => {},
        setup: async () => {
          setupCalls += 1;
          return { success: true, message: "ok" };
        },
      }) as any;
    AndroidCtrlProxyClient.getInstance = (() => ({
      waitForConnection: async () => true,
      close: async () => {},
    })) as any;

    await sessionManager.createSession("session-device-lock", "device-1", "android");

    // Stand in for a concurrent device preparation (startDevice/getAndroid/
    // provision via RunnerReadinessService) holding the SAME per-device lock.
    const release = await acquireDeviceReadinessLock(deviceReadinessLockKey("android", "device-1"));

    const upgrade = createToolExecutionContext("session-device-lock", sessionManager, devicePool, {
      ...sessionOptions,
      deviceReadiness: "automationReady",
    });

    // While the device preparation holds the lock, the upgrade cannot run
    // accessibility setup — no concurrent reset+setup on the shared manager.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(setupCalls).toBe(0);

    // Once the device preparation releases, the queued upgrade proceeds and
    // runs setup exactly once.
    release();
    const context = await upgrade;
    expect(context.deviceId).toBe("device-1");
    expect(setupCalls).toBe(1);
    expect(sessionManager.getDeviceReadiness("session-device-lock")).toBe("automationReady");
  });

  // #6280 P2 review follow-up: a device acquisition (startDevice/getAndroid)
  // releases the per-device readiness lock as soon as CtrlProxy setup
  // finishes — well before it goes on to bind/reuse the session and record
  // its achieved readiness. A concurrent upgrade for that SAME (already
  // reused, post-restart recovered) session must not race a second setup in
  // that gap; it must join the acquisition's marker and observe the recorded
  // readiness once the acquisition finishes.
  test("joins an in-flight device acquisition instead of redoing CtrlProxy setup for a reused session (#6280)", async () => {
    let setupCalls = 0;
    AndroidCtrlProxyManager.getInstance = () =>
      ({
        resetSetupState: () => {},
        setup: async () => {
          setupCalls += 1;
          return { success: true, message: "ok" };
        },
      }) as any;
    AndroidCtrlProxyClient.getInstance = (() => ({
      waitForConnection: async () => true,
      close: async () => {},
    })) as any;

    // A post-restart recovered session: already tracked, readiness never
    // recorded — mirrors a session reused by a concurrent acquisition.
    await sessionManager.createSession("session-acquisition-race", "device-1", "android");

    // Stand in for a device acquisition that has already released the
    // per-device readiness lock (CtrlProxy setup finished) but has not yet
    // bound/recorded readiness for the reused session.
    let resolveAcquisition!: () => void;
    const acquisitionDone = new Promise<void>((resolve) => {
      resolveAcquisition = resolve;
    });
    const acquisitionPromise = trackDeviceAcquisitionReadiness(
      deviceReadinessLockKey("android", "device-1"),
      async () => {
        await acquisitionDone;
        sessionManager.setDeviceReadiness("session-acquisition-race", "automationReady");
      },
    );

    const upgrade = createToolExecutionContext(
      "session-acquisition-race",
      sessionManager,
      devicePool,
      { ...sessionOptions, deviceReadiness: "automationReady" },
    );

    // While the acquisition marker is set, the upgrade must wait on it
    // instead of racing its own CtrlProxy setup on the device just prepared.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(setupCalls).toBe(0);

    resolveAcquisition();
    await acquisitionPromise;
    const context = await upgrade;

    expect(context.deviceId).toBe("device-1");
    expect(setupCalls).toBe(0);
    expect(sessionManager.getDeviceReadiness("session-acquisition-race")).toBe("automationReady");
  });

  test("should not run accessibility setup for existing sessions", async () => {
    let setupCalls = 0;
    AndroidCtrlProxyManager.getInstance = () =>
      ({
        resetSetupState: () => {},
        setup: async () => {
          setupCalls += 1;
          return { success: true, message: "ok" };
        },
      }) as any;

    await sessionManager.createSession("session-1", "device-1", "android");
    // #6227 P1 follow-up: `undefined` recorded readiness is no longer treated
    // as satisfied on the existingSession path (a session whose readiness was
    // never recorded must not be assumed ready — see isReadinessSatisfied).
    // A direct `SessionManager.createSession` call bypasses this module's own
    // setup entirely, so record the readiness explicitly, exactly as a real
    // setup pass would have by the time a session is genuinely "existing".
    sessionManager.setDeviceReadiness("session-1", "automationReady");
    const context = await createToolExecutionContext(
      "session-1",
      sessionManager,
      devicePool,
      sessionOptions,
    );

    expect(context.deviceId).toBe("device-1");
    expect(setupCalls).toBe(0);
  });

  test("does not recreate an admitted session released before setup", async () => {
    const admittedSession = await sessionManager.createSession("session-1", "device-1", "android");
    await sessionManager.releaseSession("session-1", "explicit-release");

    await expect(
      createToolExecutionContext(
        "session-1",
        sessionManager,
        devicePool,
        sessionOptions,
        undefined,
        admittedSession,
      ),
    ).rejects.toThrow("Session session-1 was released during setup");
    expect(sessionManager.getSession("session-1")).toBeNull();
  });

  test("quarantines preserved reset-cohort session routing until recovery settles", async () => {
    const first: BootedDevice = {
      name: "Pixel_8_API_35",
      platform: "android",
      deviceId: "emulator-5554",
    };
    const second: BootedDevice = {
      name: "Pixel_9_API_36",
      platform: "android",
      deviceId: "emulator-5556",
    };
    const image = (device: BootedDevice): DeviceInfo => ({
      name: device.name,
      platform: "android",
      isRunning: true,
      source: "local",
    });
    fakeDeviceManager.bootedDevices = [first, second];
    await devicePool.addDevice(first, image(first));
    await devicePool.addDevice(second, image(second));
    await devicePool.bindOrReuseDeviceSession(
      "reset-session-1",
      first.deviceId,
      "android",
      image(first),
    );
    await devicePool.bindOrReuseDeviceSession(
      "reset-session-2",
      second.deviceId,
      "android",
      image(second),
    );
    const detached = await devicePool.detachAdbServerResetCohort([
      devicePool.getDevice(first.deviceId)!,
      devicePool.getDevice(second.deviceId)!,
    ]);

    try {
      await expect(
        createToolExecutionContext("reset-session-2", sessionManager, devicePool, sessionOptions),
      ).rejects.toThrow(/device-disconnected:emulator-5556;incident=/);
    } finally {
      await devicePool.releaseAdbServerResetCohortReservations(detached.devices);
    }

    expect(() => devicePool.assertSessionReadyForAutomation("reset-session-2")).toThrow(
      /device-disconnected:emulator-5556;incident=/,
    );
    await sessionManager.releaseSession("reset-session-2", "explicit-release");
    expect(() => devicePool.assertSessionReadyForAutomation("reset-session-2")).not.toThrow();
  });

  test("retains an implicit autolock mapping while its reset cohort is quarantined", async () => {
    process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = "1";
    const device: BootedDevice = {
      name: "Pixel_8_API_35",
      platform: "android",
      deviceId: "emulator-5554",
    };
    const image: DeviceInfo = {
      name: device.name,
      platform: "android",
      isRunning: true,
      source: "local",
    };
    fakeDeviceManager.bootedDevices = [device];
    await devicePool.addDevice(device, image);
    const sessionId = await devicePool.autolockDevice(
      device.deviceId,
      "android",
      "mcp-session",
      image,
    );
    const detached = await devicePool.detachAdbServerResetCohort([
      devicePool.getDevice(device.deviceId)!,
    ]);

    try {
      expect(devicePool.resolveAutolockSessionForMcpSession("mcp-session", "android")).toBe(
        sessionId,
      );
      await expect(
        createToolExecutionContext(sessionId, sessionManager, devicePool, sessionOptions),
      ).rejects.toThrow(/device-disconnected:emulator-5554;incident=/);
      expect(devicePool.resolveAutolockSessionForMcpSession("mcp-session", "android")).toBe(
        sessionId,
      );
    } finally {
      await devicePool.releaseAdbServerResetCohortReservations(detached.devices);
      delete process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
    }
  });

  test("runs first-session setup when a released UUID is recreated during context creation", async () => {
    let setupCalls = 0;
    AndroidCtrlProxyManager.getInstance = () =>
      ({
        resetSetupState: () => {},
        setup: async () => {
          setupCalls += 1;
          return { success: true, message: "ok" };
        },
      }) as any;
    AndroidCtrlProxyClient.getInstance = (() => ({
      waitForConnection: async () => true,
      close: async () => {},
    })) as any;

    const original = await sessionManager.createSession("session-recreated", "device-1", "android");
    let finishSetup!: () => void;
    const setup = sessionManager.trackSessionSetup(
      original,
      () =>
        new Promise<void>((resolve) => {
          finishSetup = resolve;
        }),
    );
    const release = sessionManager.releaseSession("session-recreated");
    await Promise.resolve();
    const context = createToolExecutionContext(
      "session-recreated",
      sessionManager,
      devicePool,
      sessionOptions,
    );
    finishSetup();
    await setup;
    await release;

    await expect(context).resolves.toMatchObject({ deviceId: "device-1" });
    expect(setupCalls).toBe(1);
  });

  test("rejects an admitted session once its release begins", async () => {
    const session = await sessionManager.createSession("session-releasing", "device-1", "android");
    let finishSetup!: () => void;
    const setup = sessionManager.trackSessionSetup(
      session,
      () =>
        new Promise<void>((resolve) => {
          finishSetup = resolve;
        }),
    );
    const release = sessionManager.releaseSession("session-releasing");
    await Promise.resolve();

    await expect(
      createToolExecutionContext(
        "session-releasing",
        sessionManager,
        devicePool,
        sessionOptions,
        undefined,
        session,
      ),
    ).rejects.toThrow("released during setup");

    finishSetup();
    await setup;
    await release;
  });

  test("rechecks admission after setup releases its session", async () => {
    const session = await sessionManager.createSession("session-releasing", "device-1", "android");
    // #6227 P1 follow-up: `undefined` readiness is no longer treated as
    // satisfied on the existingSession path, so record it explicitly here —
    // this test exercises the post-setup admission recheck, not accessibility
    // setup, and must not make a real CtrlProxy/adb call.
    sessionManager.setDeviceReadiness("session-releasing", "automationReady");
    const trackSetup = spyOn(sessionManager, "trackSessionSetup").mockImplementation(
      async (trackedSession, setup) => {
        await setup();
        await sessionManager.releaseSession(trackedSession.sessionId, "explicit-release");
      },
    );

    try {
      await expect(
        createToolExecutionContext(
          "session-releasing",
          sessionManager,
          devicePool,
          sessionOptions,
          undefined,
          session,
        ),
      ).rejects.toThrow("released during setup");
    } finally {
      trackSetup.mockRestore();
    }
  });

  test("does not apply keep-awake after a session is released during setup", async () => {
    let allowActivityWrite!: () => void;
    const activityWrite = new Promise<void>((resolve) => {
      allowActivityWrite = resolve;
    });
    let activityStarted!: () => void;
    const activityStartedPromise = new Promise<void>((resolve) => {
      activityStarted = resolve;
    });
    const repository = {
      async upsertActiveSession(): Promise<void> {},
      async recordActivity(): Promise<void> {
        activityStarted();
        await activityWrite;
      },
      async markReleased(): Promise<void> {},
      async markStaleActiveSessionsExpired(): Promise<void> {},
    };
    const manager = new SessionManager(fakeTimer, repository);
    const pool = new DevicePool(
      manager,
      "test-daemon-session-id",
      fakeTimer,
      fakeAppsRepo,
      new FakeDeviceManager(),
    );
    const applySpy = spyOn(KeepScreenAwakeManager.prototype, "apply").mockResolvedValue({
      applied: false,
      skipReason: "disabled",
    });

    try {
      await pool.initializeWithDevices([createBootedDevice("device-race")]);
      await manager.createSession("session-race", "device-race", "android");

      const context = createToolExecutionContext("session-race", manager, pool, sessionOptions);
      await activityStartedPromise;
      await manager.releaseSession("session-race");
      allowActivityWrite();

      await expect(context).rejects.toThrow("released during setup");
      expect(applySpy).not.toHaveBeenCalled();
    } finally {
      applySpy.mockRestore();
      manager.stopCleanupTimer();
    }
  });

  test("bounds accessibility setup and rejects it after the session releases", async () => {
    const boundedTimer = new FakeTimer();
    const boundedSessionManager = new SessionManager(boundedTimer, {
      async upsertActiveSession(): Promise<void> {},
      async recordActivity(): Promise<void> {},
      async markReleased(): Promise<void> {},
      async markStaleActiveSessionsExpired(): Promise<void> {},
    });
    const boundedPool = new DevicePool(
      boundedSessionManager,
      "test-daemon-session-id",
      boundedTimer,
      fakeAppsRepo,
      new FakeDeviceManager(),
    );
    await boundedPool.initializeWithDevices([createBootedDevice("device-1")]);
    let finishSetup!: () => void;
    const setupFinished = new Promise<void>((resolve) => {
      finishSetup = resolve;
    });
    let setupStarted!: () => void;
    const setupStartedPromise = new Promise<void>((resolve) => {
      setupStarted = resolve;
    });
    AndroidCtrlProxyManager.getInstance = () =>
      ({
        resetSetupState: () => {},
        setup: async () => {
          setupStarted();
          await setupFinished;
          return { success: true, message: "ok" };
        },
      }) as any;
    AndroidCtrlProxyClient.getInstance = (() => ({
      waitForConnection: async () => true,
      close: async () => {},
    })) as any;

    try {
      const context = createToolExecutionContext(
        "session-setup-race",
        boundedSessionManager,
        boundedPool,
        sessionOptions,
      );
      await setupStartedPromise;
      const release = boundedSessionManager.releaseSession("session-setup-race");
      for (
        let attempt = 0;
        attempt < 10 && !boundedTimer.getPendingTimeouts().includes(1_000);
        attempt++
      ) {
        await Promise.resolve();
      }
      expect(boundedTimer.getPendingTimeouts()).toContain(1_000);
      boundedTimer.advanceTime(1_000);
      let releasedDevice: string | null | undefined;
      void release.then((deviceId) => {
        releasedDevice = deviceId;
      });
      for (let attempt = 0; attempt < 10 && releasedDevice === undefined; attempt++) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      expect(releasedDevice).toBe("device-1");
      await boundedPool.releaseDevice("device-1", "session-setup-race");

      expect(boundedSessionManager.getSession("session-setup-race")).toBeNull();
      expect(boundedPool.getDevice("device-1")).toMatchObject({
        sessionId: "session-setup-race",
        status: "busy",
      });

      finishSetup();
      await expect(context).rejects.toThrow("released during setup");
      await Promise.resolve();
      expect(boundedPool.getDevice("device-1")).toMatchObject({
        sessionId: null,
        status: "idle",
      });
    } finally {
      boundedSessionManager.stopCleanupTimer();
    }
  });

  // #6069: A never-issued sessionUuid reaching the device-tool path must be
  // rejected even when the caller's connection already holds a live session —
  // the residual of #6019 that #6045 left open. `requireIssuedSession` is the
  // flag toolRegistry sets for exactly this (caller-provided) path.
  describe("rejects an unissued sessionUuid on the device-tool path (#6069)", () => {
    const nonTerminalPersisted = (sessionUuid: string, deviceId: string): DeviceSession => ({
      session_uuid: sessionUuid,
      device_id: deviceId,
      platform: "android",
      status: "active",
      source: null,
      autolock_enabled: 0,
      mcp_session_id: null,
      daemon_session_id: "old-daemon",
      created_at_ms: 1,
      last_used_at_ms: 20,
      expires_at_ms: 30,
      released_at_ms: 25,
      release_reason: "daemon-restart",
      session_timeout_ms: 10,
      heartbeat_timeout_ms: 5,
      has_received_heartbeat: 1,
      created_at: "2026-09-03T00:00:00.000Z",
      updated_at: "2026-09-03T00:00:00.000Z",
    });

    test("rejects a fabricated UUID and never assigns a pooled device while a session is active", async () => {
      let setupCalls = 0;
      AndroidCtrlProxyManager.getInstance = () =>
        ({
          resetSetupState: () => {},
          setup: async () => {
            setupCalls += 1;
            return { success: true, message: "ok" };
          },
        }) as any;
      AndroidCtrlProxyClient.getInstance = (() => ({
        waitForConnection: async () => true,
        close: async () => {},
      })) as any;

      // The connection already holds a live, issued session on device-1.
      await devicePool.assignDeviceToSession("issued-session", "android");
      expect(sessionManager.getSession("issued-session")?.assignedDevice).toBe("device-1");

      const assignSpy = spyOn(devicePool, "assignDeviceToSession");

      await expect(
        createToolExecutionContext(
          "kumquat-D",
          sessionManager,
          devicePool,
          sessionOptions,
          undefined,
          undefined,
          true, // requireIssuedSession — the device-tool boundary
        ),
      ).rejects.toThrow(/not an active daemon session/);

      // No pooled device was minted for the fabricated id, and the caller's own
      // live session is untouched.
      expect(assignSpy).not.toHaveBeenCalled();
      expect(sessionManager.getSession("kumquat-D")).toBeNull();
      expect(sessionManager.getSession("issued-session")?.assignedDevice).toBe("device-1");
      expect(setupCalls).toBe(0);
      assignSpy.mockRestore();
    });

    test("still recovers a persisted, non-terminal session (live-during-restart)", async () => {
      AndroidCtrlProxyManager.getInstance = () =>
        ({
          resetSetupState: () => {},
          setup: async () => ({ success: true, message: "ok" }),
        }) as any;
      AndroidCtrlProxyClient.getInstance = (() => ({
        waitForConnection: async () => true,
        close: async () => {},
      })) as any;

      const persisted = nonTerminalPersisted("restarted-session", "device-1");
      const recoveryManager = new SessionManager(fakeTimer, {
        async getSession() {
          return persisted;
        },
        async upsertActiveSession() {},
        async recordActivity() {},
        async markReleased() {},
      });
      const recoveryPool = new DevicePool(
        recoveryManager,
        "test-daemon-session-id",
        fakeTimer,
        fakeAppsRepo,
        fakeDeviceManager,
      );
      await recoveryPool.initializeWithDevices([createBootedDevice("device-1")]);

      try {
        const context = await createToolExecutionContext(
          "restarted-session",
          recoveryManager,
          recoveryPool,
          sessionOptions,
          undefined,
          undefined,
          true, // requireIssuedSession must NOT block restart recovery
        );
        expect(context.deviceId).toBe("device-1");
        expect(recoveryManager.getSession("restarted-session")?.assignedDevice).toBe("device-1");
      } finally {
        recoveryManager.stopCleanupTimer();
      }
    });

    test("the caller's own issued session still resolves without a new assignment", async () => {
      AndroidCtrlProxyManager.getInstance = () =>
        ({
          resetSetupState: () => {},
          setup: async () => ({ success: true, message: "ok" }),
        }) as any;
      AndroidCtrlProxyClient.getInstance = (() => ({
        waitForConnection: async () => true,
        close: async () => {},
      })) as any;

      await sessionManager.createSession("mine", "device-1", "android");
      const assignSpy = spyOn(devicePool, "assignDeviceToSession");

      const context = await createToolExecutionContext(
        "mine",
        sessionManager,
        devicePool,
        sessionOptions,
        undefined,
        undefined,
        true,
      );

      expect(context.deviceId).toBe("device-1");
      expect(assignSpy).not.toHaveBeenCalled();
      assignSpy.mockRestore();
    });

    test("device-label / internal fresh mint is unaffected (requireIssuedSession defaults false)", async () => {
      AndroidCtrlProxyManager.getInstance = () =>
        ({
          resetSetupState: () => {},
          setup: async () => ({ success: true, message: "ok" }),
        }) as any;
      AndroidCtrlProxyClient.getInstance = (() => ({
        waitForConnection: async () => true,
        close: async () => {},
      })) as any;

      // Mirrors deviceLabelMapping.registerDeviceLabelMap, which mints a fresh
      // derived session without passing requireIssuedSession.
      const context = await createToolExecutionContext(
        "base:B",
        sessionManager,
        devicePool,
        sessionOptions,
      );
      expect(context.deviceId).toBe("device-1");
      expect(sessionManager.getSession("base:B")?.assignedDevice).toBe("device-1");
    });
  });
});
