import { describe, expect, test } from "bun:test";
import type { BootedDevice, ObserveResult } from "../../../src/models";
import { NoOpPerformanceTracker } from "../../../src/utils/PerformanceTracker";
import { ObservedAndroidDisplayCache } from "../../../src/features/observe/ObservationDisplay";
import { SingleDisplayCaptureStage } from "../../../src/features/observe/SingleDisplayCaptureStage";
import { SingleDisplayEnrichStage } from "../../../src/features/observe/SingleDisplayEnrichStage";
import { SingleDisplayReconcileStage } from "../../../src/features/observe/SingleDisplayReconcileStage";
import type { SingleDisplayRun } from "../../../src/features/observe/singleDisplayRun";
import type { PostCaptureForegroundIdentity } from "../../../src/features/observe/ActiveWindowAttribution";
import { platformObservationTraits } from "../../../src/features/observe/collectors/PlatformObservationTraits";
import { SafeAreaAuditor } from "../../../src/features/observe/audits/SafeAreaAuditor";
import { ObserveElementsBuilder } from "../../../src/features/observe/ObserveElementsBuilder";
import { createObserveScreenForTest } from "./observeScreenTestBuilders";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../fakes/FakeTimer";

const android: BootedDevice = { name: "Pixel", platform: "android", deviceId: "emulator-5554" };

function unused(name: string): never {
  throw new Error(`${name} must not be read by this stage path`);
}

function baseResult(): ObserveResult {
  const timer = new FakeTimer();
  return createObserveScreenForTest(
    android,
    new FakeAdbClientFactory(new FakeAdbExecutor()),
    {},
    timer,
  ).createBaseResult();
}

function fakeRun(overrides: Partial<SingleDisplayRun> = {}): SingleDisplayRun {
  return {
    options: undefined,
    perf: new NoOpPerformanceTracker(),
    queryOptions: undefined,
    skipWaitForFresh: true,
    minTimestamp: 0,
    signal: undefined,
    skipBackStack: false,
    observerMode: false,
    preserveDisplayState: false,
    displayRequest: undefined,
    androidDisplayCache: new ObservedAndroidDisplayCache(new FakeTimer()),
    screenshotMode: "none",
    iosLockState: undefined,
    observedAndroid: undefined,
    explicitlyRouted: false,
    requestedPanel: undefined,
    requestedDisplayId: undefined,
    result: baseResult(),
    startTime: 0,
    captureStart: { revision: 0, identityRevision: 0 },
    routedAggregateSecondary: false,
    cacheGeneration: 0,
    ...overrides,
  };
}

describe("SingleDisplayCaptureStage.resolveSingleDisplayIntent", () => {
  function stage(requestedDisplay: string | undefined, sharedCache: ObservedAndroidDisplayCache) {
    return new SingleDisplayCaptureStage({
      device: () => android,
      timer: () => new FakeTimer(),
      displayBinding: () => unused("displayBinding"),
      hierarchyCapture: () => unused("hierarchyCapture"),
      hierarchyCollector: () => unused("hierarchyCollector"),
      deviceStateCollector: () => unused("deviceStateCollector"),
      iosLockStateProbe: () => unused("iosLockStateProbe"),
      observedAndroidDisplayCache: () => sharedCache,
      requestedDisplay: () => requestedDisplay,
      selectedDisplayRead: () => ({}),
      createBaseResult: () => unused("createBaseResult"),
      createCriticalFallback: () => unused("createCriticalFallback"),
      collectAllData: () => unused("collectAllData"),
    });
  }

  test("an aggregate 'all' request resolves each panel itself, so no default display is pinned", () => {
    const intent = stage(
      "all",
      new ObservedAndroidDisplayCache(new FakeTimer()),
    ).resolveSingleDisplayIntent(undefined);
    expect(intent.displayRequest).toBeUndefined();
  });

  test("a constructor display is the default and a per-call display overrides it", () => {
    const s = stage("2", new ObservedAndroidDisplayCache(new FakeTimer()));
    expect(s.resolveSingleDisplayIntent(undefined).displayRequest).toBe("2");
    expect(s.resolveSingleDisplayIntent({ display: "1" }).displayRequest).toBe("1");
  });

  test("owner reads share the display cache; read-only probes get a private one", () => {
    const shared = new ObservedAndroidDisplayCache(new FakeTimer());
    const s = stage(undefined, shared);
    expect(s.resolveSingleDisplayIntent(undefined).androidDisplayCache).toBe(shared);
    expect(s.resolveSingleDisplayIntent({ observerMode: true }).androidDisplayCache).not.toBe(
      shared,
    );
  });

  test("no iOS lock-state probe starts on an Android device", () => {
    const intent = stage(
      undefined,
      new ObservedAndroidDisplayCache(new FakeTimer()),
    ).resolveSingleDisplayIntent(undefined);
    expect(intent.iosLockState).toBeUndefined();
  });
});

describe("SingleDisplayEnrichStage", () => {
  function stage(
    deferred: WeakMap<ObserveResult, number>,
    audits: { count: number },
    options: { device?: BootedDevice; round?: boolean } = {},
  ) {
    const auditor = {
      run: async () => {
        audits.count += 1;
      },
    };
    return new SingleDisplayEnrichStage({
      device: () => options.device ?? android,
      timer: () => new FakeTimer(),
      platformTraits: () => platformObservationTraits("android", () => android),
      screenshotRecorder: () => unused("screenshotRecorder"),
      pathProtection: () => ({
        removeIfUnprotected: async () => {
          throw new Error("Unexpected removal");
        },
        isProtected: () => false,
        start: () => {},
        sweep: async () => {},
        sweepOnce: async () => {},
        write: async () => {
          throw new Error("Unexpected write");
        },
        protect: async (p: string) => (p === "/shot.png" ? 99 : 0),
      }),
      performanceAuditor: () => auditor,
      accessibilityAuditor: () => auditor,
      accessibilityStateDetector: () => auditor,
      predictiveUIState: () => unused("predictiveUIState"),
      safeAreaAuditor: () => new SafeAreaAuditor(),
      elementsBuilder: () => new ObserveElementsBuilder(),
      screenRound: () => ({ isScreenRound: async () => options.round }),
      deferredBackStackDisplays: () => deferred,
      stampScreenSizeUnits: () => undefined,
      processRecomposition: async () => undefined,
      captureSettledScreenshot: async () => undefined,
    });
  }

  test("publish protects the screenshot and defers the back stack to its display", async () => {
    const deferred = new WeakMap<ObserveResult, number>();
    const run = fakeRun({ skipBackStack: true, requestedDisplayId: 2 });
    run.result.screenshotPath = "/shot.png";

    const published = await stage(deferred, { count: 0 }).publishSingleDisplay(run);

    expect(published.screenshotExpiresAt).toBe(99);
    expect(deferred.get(run.result)).toBe(2);
  });

  test("publish leaves an observer read without a deferred back stack", async () => {
    const deferred = new WeakMap<ObserveResult, number>();
    const run = fakeRun({ skipBackStack: true, observerMode: true });

    await stage(deferred, { count: 0 }).publishSingleDisplay(run);

    expect(deferred.has(run.result)).toBe(false);
  });

  test("an observer read with screenshots off skips the capture and every audit", async () => {
    const audits = { count: 0 };
    const run = fakeRun({ observerMode: true });

    await stage(new WeakMap(), audits).enrichSingleDisplay(run);

    expect(run.result.screenshotCaptureAttempted).toBe(false);
    expect(audits.count).toBe(0);
  });

  test("a watch read reports isScreenRound; a phone read never asks", async () => {
    const watch: BootedDevice = { ...android, formFactor: "watch" };
    const onWatch = fakeRun();
    await stage(new WeakMap(), { count: 0 }, { device: watch, round: true }).enrichSingleDisplay(
      onWatch,
    );
    expect(onWatch.result.isScreenRound).toBe(true);

    const onPhone = fakeRun();
    await stage(new WeakMap(), { count: 0 }, { round: true }).enrichSingleDisplay(onPhone);
    expect(onPhone.result.isScreenRound).toBeUndefined();

    const unreadable = fakeRun();
    await stage(new WeakMap(), { count: 0 }, { device: watch }).enrichSingleDisplay(unreadable);
    expect(unreadable.result.isScreenRound).toBeUndefined();
  });

  test("an ordinary read runs the performance, accessibility and state audits", async () => {
    const audits = { count: 0 };

    await stage(new WeakMap(), audits).enrichSingleDisplay(fakeRun());

    expect(audits.count).toBe(3);
  });
});

describe("SingleDisplayReconcileStage", () => {
  test("an observer read neither recovers nor reconciles attribution", async () => {
    let reconciled = 0;
    const stage = new SingleDisplayReconcileStage({
      device: () => android,
      timer: () => new FakeTimer(),
      windowIdentity: () => unused("windowIdentity"),
      staleRecovery: () => unused("staleRecovery"),
      displayBinding: () => ({
        resolveTarget: () => unused("resolveTarget"),
        bindFinalDisplay: () => ({ recordProvenance: { revision: 7, identityRevision: 8 } }),
      }),
      platformValidator: () => ({ validate: () => ({ valid: true }) }),
      reconcileActiveWindowAttribution: async (): Promise<PostCaptureForegroundIdentity> => {
        reconciled += 1;
        return unused("reconcileActiveWindowAttribution");
      },
      isConfirmedFrameworkErrorDialog: async () => false,
    });
    const run = fakeRun({ observerMode: true });

    const reconciledStage = await stage.reconcileSingleDisplay(run, {
      earlyResult: undefined,
      foregroundSnapshot: Promise.resolve(null),
      foregroundIdentity: Promise.resolve(undefined),
    });

    expect(reconciled).toBe(0);
    expect(reconciledStage.postCaptureForeground.activityAttributionMismatch).toBe(false);
    expect(reconciledStage.recordProvenance).toEqual({ revision: 7, identityRevision: 8 });
  });
});
