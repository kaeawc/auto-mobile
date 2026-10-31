import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  AndroidAppEventRecorder,
  parseStackTrace,
  type AndroidAppEventRecorderContext,
  type AndroidAppEventStore,
  type AndroidPackageEvent,
} from "../../../../src/features/observe/android/AndroidAppEventRecorder";
import type {
  AndroidHandledExceptionEvent,
  AndroidSdkEventIngestor,
} from "../../../../src/features/observe/android/AndroidSdkEventIngestor";
import type { DbWriteBarrier } from "../../../../src/db/dbWriteBarrier";
import type { InstalledAppsCacheWriteCoordinator } from "../../../../src/db/installedAppsCacheWriteCoordinator";
import type {
  AnrEvent,
  CrashEvent,
  CrashEventSink,
} from "../../../../src/utils/interfaces/CrashMonitor";
import type {
  SdkAnrPayload,
  SdkCrashPayload,
} from "../../../../src/features/observe/crash/sdkCrashIngestion";
import { SdkFrameMetricsStore } from "../../../../src/features/performance/SdkFrameMetricsStore";
import { logger } from "../../../../src/utils/logger";
import { FakeTimer } from "../../../fakes/FakeTimer";

class FakeInstalledAppsStore implements AndroidAppEventStore {
  readonly upserts: Parameters<AndroidAppEventStore["upsertInstalledApp"]>[] = [];
  readonly removals: Parameters<AndroidAppEventStore["removeInstalledApp"]>[] = [];
  readonly deviceRemovals: Parameters<AndroidAppEventStore["removeInstalledAppForDevice"]>[] = [];
  readonly staleDevices: string[] = [];
  fail = false;

  async upsertInstalledApp(...args: Parameters<AndroidAppEventStore["upsertInstalledApp"]>) {
    if (this.fail) {
      throw new Error("store unavailable");
    }
    this.upserts.push(args);
  }
  async removeInstalledApp(...args: Parameters<AndroidAppEventStore["removeInstalledApp"]>) {
    this.removals.push(args);
  }
  async removeInstalledAppForDevice(
    ...args: Parameters<AndroidAppEventStore["removeInstalledAppForDevice"]>
  ) {
    this.deviceRemovals.push(args);
  }
  async markDeviceStale(deviceId: string) {
    if (this.fail) {
      throw new Error("store unavailable");
    }
    this.staleDevices.push(deviceId);
  }
}

class FakeCrashSink implements CrashEventSink {
  readonly crashes: CrashEvent[] = [];
  readonly anrs: AnrEvent[] = [];
  fail = false;
  pending: Promise<number> | null = null;

  async saveCrash(event: CrashEvent): Promise<number> {
    this.crashes.push(event);
    if (this.fail) {
      throw new Error("sink unavailable");
    }
    return this.pending ?? 1;
  }
  async saveAnr(event: AnrEvent): Promise<number> {
    this.anrs.push(event);
    if (this.fail) {
      throw new Error("sink unavailable");
    }
    return this.pending ?? 2;
  }
}

class FakeIngestor implements Pick<
  AndroidSdkEventIngestor,
  "recordCrashAnalytics" | "recordAnrAnalytics" | "recordHandledException"
> {
  readonly crashes: SdkCrashPayload[] = [];
  readonly anrs: Array<{ event: SdkAnrPayload; packageName: string }> = [];
  readonly handled: AndroidHandledExceptionEvent[] = [];

  async recordCrashAnalytics(event: SdkCrashPayload): Promise<void> {
    this.crashes.push(event);
  }
  async recordAnrAnalytics(event: SdkAnrPayload, packageName: string): Promise<void> {
    this.anrs.push({ event, packageName });
  }
  async recordHandledException(event: AndroidHandledExceptionEvent): Promise<void> {
    this.handled.push(event);
  }
}

class FakeBarrier implements Pick<DbWriteBarrier, "track"> {
  draining = false;
  readonly calls: string[] = [];

  async track<T>(write: () => Promise<T>): Promise<T | undefined> {
    this.calls.push("track");
    return this.draining ? undefined : write();
  }
}

class FakeCacheCoordinator implements Pick<InstalledAppsCacheWriteCoordinator, "invalidate"> {
  readonly devices: string[] = [];
  readonly writes: Array<() => Promise<void>> = [];
  defer = false;

  async invalidate(deviceId: string, write: () => Promise<void>): Promise<void> {
    this.devices.push(deviceId);
    this.writes.push(write);
    if (!this.defer) {
      await write();
    }
  }
}

function createRecorder() {
  const timer = new FakeTimer();
  timer.advanceTime(1234);
  const sink = new FakeCrashSink();
  const store = new FakeInstalledAppsStore();
  const ingestor = new FakeIngestor();
  const frames = new SdkFrameMetricsStore();
  const barrier = new FakeBarrier();
  const coordinator = new FakeCacheCoordinator();
  const invalidated: string[] = [];
  const profiles: Array<{ userId: number; enabled: boolean }> = [];
  const context: AndroidAppEventRecorderContext = {
    deviceId: "event-device",
    platform: "android",
    timer,
    crashEventSink: sink,
    getSdkEventIngestor: () => ingestor,
    getInstalledAppsStore: () => store,
    getWorkProfileMonitor: () => ({
      setProfileHasAccessibilityService: (userId, enabled) => {
        profiles.push({ userId, enabled });
      },
    }),
    invalidateBuildContext: (appId) => {
      invalidated.push(appId);
    },
    getLastForegroundPackage: () => null,
    getFrameMetricsStore: () => frames,
    getInstalledAppsCacheWriteCoordinator: () => coordinator,
    getDbWriteBarrier: () => barrier,
  };
  return {
    recorder: new AndroidAppEventRecorder(context),
    context,
    timer,
    sink,
    store,
    ingestor,
    frames,
    barrier,
    coordinator,
    invalidated,
    profiles,
  };
}

// Copied from AndroidCtrlProxyCrashEventWire.test.ts / sdkCrashIngestion.test.ts.
const CRASH_STACK = "at com.example.Main.run(Main.java:42)";
const ANR_STACK = "at android.os.MessageQueue.nativePollOnce(Native Method)";
const deviceInfo = { model: "Pixel 7", manufacturer: "Google", osVersion: "14", sdkInt: 34 };
const crash: SdkCrashPayload = {
  timestamp: 1700000000000,
  exceptionClass: "java.lang.NullPointerException",
  stackTrace: CRASH_STACK,
  threadName: "main",
  packageName: "com.example.app",
  deviceInfo,
};
const anr: SdkAnrPayload = {
  timestamp: 1700000000500,
  pid: 12345,
  processName: "com.example.app",
  importance: "FOREGROUND",
  reason: "Input dispatching timed out",
  trace: ANR_STACK,
  deviceInfo,
};
const added: AndroidPackageEvent = { action: "added", packageName: "com.example.app", userId: 0 };

describe("AndroidAppEventRecorder", () => {
  let info: ReturnType<typeof spyOn<typeof logger, "info">>;
  let warn: ReturnType<typeof spyOn<typeof logger, "warn">>;
  let error: ReturnType<typeof spyOn<typeof logger, "error">>;

  beforeEach(() => {
    info = spyOn(logger, "info").mockImplementation(() => {});
    warn = spyOn(logger, "warn").mockImplementation(() => {});
    error = spyOn(logger, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    info.mockRestore();
    warn.mockRestore();
    error.mockRestore();
  });

  test.each(["added", "replaced"] as const)(
    "upserts %s and invalidates build provenance",
    async (action) => {
      const h = createRecorder();
      await h.recorder.handlePackageEvent({ ...added, action, isSystem: true });
      expect(h.store.upserts).toEqual([
        ["event-device", 0, added.packageName, { isSystem: true, timestampMs: 1234 }],
      ]);
      expect(h.invalidated).toEqual([added.packageName]);
      expect(h.profiles).toEqual([]);
    },
  );

  test("honors timestamp zero and defaults a non-system package", async () => {
    const h = createRecorder();
    await h.recorder.handlePackageEvent(added, 0);
    expect(h.store.upserts).toEqual([
      ["event-device", 0, added.packageName, { isSystem: false, timestampMs: 0 }],
    ]);
  });

  test.each([false, true])(
    "removes packages (removedForAllUsers=%s) and invalidates provenance",
    async (allUsers) => {
      const h = createRecorder();
      await h.recorder.handlePackageEvent({
        ...added,
        action: "removed",
        userId: 10,
        removedForAllUsers: allUsers,
      });
      expect(h.store.removals).toEqual(allUsers ? [] : [["event-device", 10, added.packageName]]);
      expect(h.store.deviceRemovals).toEqual(allUsers ? [["event-device", added.packageName]] : []);
      expect(h.invalidated).toEqual([added.packageName]);
      expect(h.profiles).toEqual([{ userId: 10, enabled: true }]);
    },
  );

  test.each([{ packageName: "" }, { userId: -1 }, { userId: 1.5 }, { userId: NaN }])(
    "ignores invalid package data %j",
    async (invalid) => {
      const h = createRecorder();
      await h.recorder.handlePackageEvent({ ...added, ...invalid });
      expect(h.store.upserts).toEqual([]);
      expect(h.invalidated).toEqual([]);
      expect(h.profiles).toEqual([]);
      expect(warn).toHaveBeenCalledWith("[CTRL_PROXY] Ignoring package event with missing data");
    },
  );

  test("skips package events and stale writes on non-Android platforms", async () => {
    const h = createRecorder();
    h.context.platform = "ios";
    await h.recorder.handlePackageEvent(added);
    await h.recorder.markInstalledAppsStale("closed");
    expect(h.store.upserts).toEqual([]);
    expect(h.invalidated).toEqual([]);
    expect(h.coordinator.devices).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  test("decodes legacy UIDs and flags only work profiles with an existing monitor", async () => {
    const h = createRecorder();
    await h.recorder.handlePackageEvent({ ...added, userId: 1012345 });
    await h.recorder.handlePackageEvent({ ...added, userId: 12345 });
    expect(h.store.upserts.map((row) => row[1])).toEqual([10, 0]);
    expect(h.profiles).toEqual([{ userId: 10, enabled: true }]);
    h.context.getWorkProfileMonitor = () => null;
    await h.recorder.handlePackageEvent({ ...added, userId: 11, uid: 1112345 });
    delete h.context.getWorkProfileMonitor;
    await h.recorder.handlePackageEvent({ ...added, userId: 12, uid: 1212345 });
    expect(h.profiles).toHaveLength(1);
    expect(h.store.upserts.map((row) => row[1])).toEqual([10, 0, 11, 12]);
  });

  test("invalidates build context before a failed write and skips the profile flag", async () => {
    const h = createRecorder();
    h.store.fail = true;
    await h.recorder.handlePackageEvent({ ...added, userId: 10 });
    expect(h.invalidated).toEqual([added.packageName]);
    expect(h.profiles).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      "[CTRL_PROXY] Failed to apply package event: Error: store unavailable",
    );
  });

  test("normalizes crash persistence and records analytics concurrently", async () => {
    const h = createRecorder();
    const pending = Promise.withResolvers<number>();
    h.sink.pending = pending.promise;
    const work = h.recorder.handleCrashEvent(crash);
    expect(h.ingestor.crashes).toEqual([crash]);
    expect(h.sink.crashes).toEqual([
      {
        deviceId: "event-device",
        packageName: crash.packageName,
        crashType: "java",
        detectionSource: "sdk_websocket",
        timestamp: crash.timestamp,
        threadName: "main",
        exceptionClass: crash.exceptionClass,
        exceptionMessage: undefined,
        stacktrace: CRASH_STACK,
        currentScreen: undefined,
        appVersion: undefined,
        deviceInfo,
      },
    ]);
    pending.resolve(1);
    await work;
    expect(info).toHaveBeenCalledWith(
      "[CTRL_PROXY] Received crash: java.lang.NullPointerException on thread main from com.example.app",
    );
  });

  test.each([undefined, "com.other.app"])(
    "uses ANR package fallback only when absent (%s)",
    async (packageName) => {
      const h = createRecorder();
      const pending = Promise.withResolvers<number>();
      h.sink.pending = pending.promise;
      const event = { ...anr, packageName };
      const work = h.recorder.handleAnrEvent(event);
      expect(h.ingestor.anrs).toEqual([{ event, packageName: packageName ?? anr.processName }]);
      expect(h.sink.anrs[0]).toEqual({
        deviceId: "event-device",
        packageName: packageName ?? anr.processName,
        detectionSource: "sdk_websocket",
        timestamp: anr.timestamp,
        processName: anr.processName,
        pid: anr.pid,
        reason: anr.reason,
        stacktrace: ANR_STACK,
        importance: anr.importance,
        appVersion: undefined,
        deviceInfo,
      });
      pending.resolve(2);
      await work;
      expect(info).toHaveBeenCalledWith(
        "[CTRL_PROXY] Received ANR: pid=12345, process=com.example.app, importance=FOREGROUND",
      );
    },
  );

  test("logs crash persistence failure and still records analytics without throwing", async () => {
    const h = createRecorder();
    h.sink.fail = true;
    await h.recorder.handleCrashEvent(crash);
    expect(h.ingestor.crashes).toEqual([crash]);
    expect(error).toHaveBeenCalledWith(
      "[CTRL_PROXY] Failed to persist crash: Error: sink unavailable",
    );
  });

  test("logs ANR persistence failure and still records analytics without throwing", async () => {
    const h = createRecorder();
    h.sink.fail = true;
    await h.recorder.handleAnrEvent(anr);
    expect(h.ingestor.anrs).toEqual([{ event: anr, packageName: anr.processName }]);
    expect(error).toHaveBeenCalledWith(
      "[CTRL_PROXY] Failed to persist ANR: Error: sink unavailable",
    );
  });

  test("forwards handled exceptions and resolves the ingestor per event", async () => {
    const h = createRecorder();
    const event: AndroidHandledExceptionEvent = { ...crash, customMessage: "caught" };
    await h.recorder.handleHandledExceptionEvent(event);
    const replacement = new FakeIngestor();
    h.context.getSdkEventIngestor = () => replacement;
    await h.recorder.handleHandledExceptionEvent(event);
    expect(h.ingestor.handled).toEqual([event]);
    expect(replacement.handled).toEqual([event]);
    expect(info).toHaveBeenCalledWith(
      "[CTRL_PROXY] Received handled exception: java.lang.NullPointerException from com.example.app",
    );
  });

  test("stale writes resolve their store and barrier inside the coordinator callback", async () => {
    const h = createRecorder();
    h.coordinator.defer = true;
    await h.recorder.markInstalledAppsStale("WS closed");
    expect(h.coordinator.devices).toEqual(["event-device"]);
    expect(h.barrier.calls).toEqual([]);
    const replacement = new FakeInstalledAppsStore();
    const barrier = new FakeBarrier();
    h.context.getInstalledAppsStore = () => replacement;
    h.context.getDbWriteBarrier = () => barrier;
    await h.coordinator.writes[0]();
    expect(barrier.calls).toEqual(["track"]);
    expect(replacement.staleDevices).toEqual(["event-device"]);
    expect(h.store.staleDevices).toEqual([]);
    expect(info).toHaveBeenCalledWith("[CTRL_PROXY] Marked installed apps cache stale (WS closed)");
  });

  test("skips stale writes during barrier drain", async () => {
    const h = createRecorder();
    h.barrier.draining = true;
    await h.recorder.markInstalledAppsStale("shutdown");
    expect(h.barrier.calls).toEqual(["track"]);
    expect(h.store.staleDevices).toEqual([]);
  });

  test("logs stale-cache write failures without throwing", async () => {
    const h = createRecorder();
    h.store.fail = true;
    await h.recorder.markInstalledAppsStale("closed");
    expect(warn).toHaveBeenCalledWith(
      "[CTRL_PROXY] Failed to mark installed apps stale: Error: store unavailable",
    );
  });

  test("attributes frame metrics to the app before the foreground fallback and stamps FakeTimer", () => {
    const h = createRecorder();
    h.context.getLastForegroundPackage = () => "com.foreground";
    h.recorder.handleFrameMetricsEvent({
      applicationId: "com.sdk",
      fps: 60,
      frameTimeMs: 16,
      jankFrames: 2,
    });
    expect(h.frames.getFresh("event-device", "com.sdk", 1234, 0)).toEqual({
      fps: 60,
      frameTimeMs: 16,
      jankFrames: 2,
      receivedAt: 1234,
    });
    expect(h.frames.getFresh("event-device", "com.foreground", 1234, 0)).toBeNull();
    h.timer.advanceTime(1);
    h.recorder.handleFrameMetricsEvent({ fps: 0 });
    expect(h.frames.getFresh("event-device", "com.foreground", 1235, 0)).toEqual({
      fps: 0,
      frameTimeMs: null,
      jankFrames: null,
      receivedAt: 1235,
    });
  });

  test("skips frame metrics with no package (including an explicit empty app id)", () => {
    const h = createRecorder();
    h.context.getFrameMetricsStore = () => {
      throw new Error("store must not be resolved");
    };
    h.recorder.handleFrameMetricsEvent({ fps: 60 });
    h.context.getLastForegroundPackage = () => "com.foreground";
    h.recorder.handleFrameMetricsEvent({ applicationId: "", fps: 60 });
  });
});

describe("parseStackTrace", () => {
  test("parses existing crash and ANR frames, ignoring exception headers", () => {
    expect(
      parseStackTrace(
        `java.lang.NullPointerException\n\t${CRASH_STACK}\n  ${ANR_STACK}\nCaused by: failure`,
        "com.example.app",
      ),
    ).toEqual([
      {
        className: "com.example.Main",
        methodName: "run",
        fileName: "Main.java",
        lineNumber: 42,
        isAppCode: true,
      },
      {
        className: "android.os.MessageQueue",
        methodName: "nativePollOnce",
        fileName: "Native Method",
        lineNumber: null,
        isAppCode: false,
      },
    ]);
  });

  test("preserves direct-package and shared-prefix app-code attribution", () => {
    expect(parseStackTrace(CRASH_STACK, "com.example.Main")[0].isAppCode).toBe(true);
    expect(parseStackTrace(CRASH_STACK, "com.example.other")[0].isAppCode).toBe(true);
    expect(parseStackTrace(CRASH_STACK, "org.other.app")[0].isAppCode).toBe(false);
    expect(parseStackTrace("", "com.example.app")).toEqual([]);
  });

  test("parses captured constructor, nested class and static initializer frames", () => {
    // Copied from avdmanager.test.ts's JAXB NoClassDefFoundError fixture.
    const stack = `Exception in thread "main" java.lang.NoClassDefFoundError: javax/xml/bind/annotation/XmlSchema
\tat com.android.repository.api.SchemaModule$SchemaModuleVersion.<init>(SchemaModule.java:156)
\tat com.android.repository.api.SchemaModule.<init>(SchemaModule.java:75)
\tat com.android.sdklib.repository.AndroidSdkHandler.<clinit>(AndroidSdkHandler.java:81)`;
    expect(parseStackTrace(stack, "com.android.repository")).toEqual([
      {
        className: "com.android.repository.api.SchemaModule$SchemaModuleVersion",
        methodName: "<init>",
        fileName: "SchemaModule.java",
        lineNumber: 156,
        isAppCode: true,
      },
      {
        className: "com.android.repository.api.SchemaModule",
        methodName: "<init>",
        fileName: "SchemaModule.java",
        lineNumber: 75,
        isAppCode: true,
      },
      {
        className: "com.android.sdklib.repository.AndroidSdkHandler",
        methodName: "<clinit>",
        fileName: "AndroidSdkHandler.java",
        lineNumber: 81,
        isAppCode: true,
      },
    ]);
  });
});
