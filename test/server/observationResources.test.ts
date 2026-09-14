import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { BootedDevice, ObserveResult } from "../../src/models";
import type { ScreenshotResult } from "../../src/models/ScreenshotResult";
import type { TrackedScreenshotService } from "../../src/features/observe/screenshot/ObserveScreenshotRecorder";
import type { ScreenshotJobOptions } from "../../src/utils/ScreenshotJobTracker";
import { RealObserveScreen } from "../../src/features/observe/ObserveScreen";
import { ScreenshotJobTracker } from "../../src/utils/ScreenshotJobTracker";
import { OPERATION_CANCELLED_MESSAGE } from "../../src/utils/constants";
import {
  RESOURCE_URIS,
  registerObservationResources,
  resetSessionScreenshotResourceDependencies,
  resetScreenshotFileSystem,
  setSessionScreenshotResourceDependencies,
  setScreenshotFileSystem,
} from "../../src/server/observationResources";
import {
  getScreenshotStateStore,
  InMemoryScreenshotStateStore,
  resetScreenshotStateStore,
  setScreenshotStateStore,
} from "../../src/features/observe/screenshot/ScreenshotStateRegistry";
import { ResourceRegistry, type ResourceReadContext } from "../../src/server/resourceRegistry";
import {
  clearDirectSessionDevices,
  registerDirectSessionDevice,
  resolveDirectSessionDevice,
} from "../../src/server/directSessionDeviceRegistry";
import { FakeAdbClientFactory } from "../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeObserveCacheStore } from "../fakes/FakeObserveCacheStore";
import { FakeTimer } from "../fakes/FakeTimer";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";
import { resetObserveCacheStore } from "../../src/features/observe/cache/ObserveCacheRegistry";

/** Resolves once the microtask queue has drained, to detect a pending promise. */
async function settleSentinel(): Promise<"still-pending"> {
  for (let i = 0; i < 100; i++) {
    await Promise.resolve();
  }
  return "still-pending";
}

/** A promise a test opens by hand, to hold a screenshot job in flight. */
function createGate(): { promise: Promise<void>; open: () => void } {
  let open: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

const sessionUuid = "session-123";
const sessionDevice: BootedDevice = {
  deviceId: "emulator-5554",
  name: "Pixel 9",
  platform: "android",
};

function activeSession(device: BootedDevice = sessionDevice) {
  return { sessionUuid, device };
}

function readTemplate(uri: string, context: ResourceReadContext = { sessionUuid }) {
  registerObservationResources();
  const match = ResourceRegistry.matchTemplate(uri);
  expect(match).toBeDefined();
  const { template, params } = match!;
  expect("handlerWithReadContext" in template).toBe(true);
  if ("handlerWithReadContext" in template) {
    return template.handlerWithReadContext(params, context);
  }
  return template.handler(params);
}

function readLatestScreenshot(context?: ResourceReadContext) {
  registerObservationResources();
  return ResourceRegistry.getResource(RESOURCE_URIS.LATEST_SCREENSHOT)!.handler(context);
}

const imageFixtures = [
  { extension: "jpg", mimeType: "image/jpeg", bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0]) },
  {
    extension: "png",
    mimeType: "image/png",
    bytes: Buffer.from("89504e470d0a1a0a", "hex"),
  },
  {
    extension: "webp",
    mimeType: "image/webp",
    bytes: Buffer.from("RIFF\x00\x00\x00\x00WEBPVP8 ", "binary"),
  },
] as const;

function createTrackedScreenshot(
  result: ScreenshotResult,
  deviceId: string = sessionDevice.deviceId,
): TrackedScreenshotService {
  return {
    async execute(): Promise<ScreenshotResult> {
      return result;
    },
    generateScreenshotPath(): string {
      return "/tmp/fresh.png";
    },
    async getActivityHash(): Promise<string> {
      return "hash";
    },
    startTrackedCapture(_options, trackerOptions) {
      return ScreenshotJobTracker.startJob(deviceId, async () => result, trackerOptions);
    },
  };
}

describe("session screenshot resources", () => {
  afterEach(() => {
    RealObserveScreen.clearCache();
    clearDirectSessionDevices();
    resetSessionScreenshotResourceDependencies();
    resetScreenshotFileSystem();
  });

  test("returns the actual MIME type for the latest cached screenshot", async () => {
    const observeScreen = new RealObserveScreen(
      sessionDevice,
      new FakeAdbClientFactory(new FakeAdbExecutor()),
    );
    await observeScreen.cacheObserveResult(observeScreen.createBaseResult());

    for (const fixture of imageFixtures) {
      const screenshotPath = `/tmp/latest.${fixture.extension}`;
      getScreenshotStateStore().update(sessionDevice.deviceId, screenshotPath);
      setScreenshotFileSystem({
        stat: async () => ({ isFile: () => true }),
        readFile: async () => fixture.bytes,
      });

      const content = await readLatestScreenshot();

      expect(content.mimeType).toBe(fixture.mimeType);
      expect(content.blob).toBe(fixture.bytes.toString("base64"));
    }
  });

  test("registers session-scoped cached and fresh screenshot templates", () => {
    registerObservationResources();

    expect(ResourceRegistry.getTemplate(RESOURCE_URIS.SESSION_OBSERVATION)).toBeDefined();
    expect(ResourceRegistry.getTemplate(RESOURCE_URIS.SESSION_SCREENSHOT)).toBeDefined();
    expect(ResourceRegistry.getTemplate(RESOURCE_URIS.FRESH_SESSION_SCREENSHOT)).toBeDefined();
    expect(
      ResourceRegistry.getTemplate("automobile:observation/{deviceId}/latest"),
    ).toBeUndefined();
  });

  test("does not expose another device's cached observation through a session path", async () => {
    const otherDevice: BootedDevice = {
      deviceId: "emulator-5556",
      name: "Pixel 10",
      platform: "android",
    };
    const observeScreen = new RealObserveScreen(
      otherDevice,
      new FakeAdbClientFactory(new FakeAdbExecutor()),
    );
    const observed: ObserveResult = {
      ...observeScreen.createBaseResult(),
      viewHierarchy: "only-other-device",
    };
    await observeScreen.cacheObserveResult(observed);
    setSessionScreenshotResourceDependencies({
      resolveActiveSession: () => activeSession(),
      createScreenshotService: () => createTrackedScreenshot({ success: false }),
    });

    const content = await readTemplate("automobile:observation/session/session-123/latest");

    expect(content.uri).toBe("automobile:observation/session/session-123/latest");
    expect(content.mimeType).toBe("application/json");
    expect(JSON.parse(content.text!).error).toContain(
      "No observation available for sessionUuid session-123",
    );
  });

  test("resolves a direct-mode session registered by startDevice", async () => {
    const observeScreen = new RealObserveScreen(
      sessionDevice,
      new FakeAdbClientFactory(new FakeAdbExecutor()),
    );
    const observed: ObserveResult = {
      ...observeScreen.createBaseResult(),
      viewHierarchy: "direct-mode-session",
    };
    await observeScreen.cacheObserveResult(observed);
    registerDirectSessionDevice(sessionUuid, sessionDevice);

    const content = await readTemplate("automobile:observation/session/session-123/latest");

    expect(JSON.parse(content.text!).viewHierarchy).toBe("direct-mode-session");
  });

  test("rejects session resource reads outside the caller's bound session", async () => {
    let resolveCalls = 0;
    let screenshotServiceCalls = 0;
    setSessionScreenshotResourceDependencies({
      resolveActiveSession: () => {
        resolveCalls++;
        return activeSession();
      },
      createScreenshotService: () => {
        screenshotServiceCalls++;
        return createTrackedScreenshot({ success: true, path: "/tmp/fresh.png" });
      },
    });

    for (const uri of [
      "automobile:observation/session/session-123/latest",
      "automobile:observation/session/session-123/latest/screenshot",
      "automobile:device-session/session-123/screenshot",
    ]) {
      const content = await readTemplate(uri, { sessionUuid: "session-other" });

      expect(content.mimeType).toBe("application/json");
      expect(JSON.parse(content.text!).error).toContain("bound device session");
    }

    expect(resolveCalls).toBe(0);
    expect(screenshotServiceCalls).toBe(0);
  });

  test("rejects session resource reads without a bound session", async () => {
    let resolveCalls = 0;
    setSessionScreenshotResourceDependencies({
      resolveActiveSession: () => {
        resolveCalls++;
        return activeSession();
      },
      createScreenshotService: () => createTrackedScreenshot({ success: true }),
    });

    const content = await readTemplate("automobile:observation/session/session-123/latest", {});

    expect(JSON.parse(content.text!).error).toContain("bound device session");
    expect(resolveCalls).toBe(0);
  });

  test("returns a fresh PNG capture for an active session", async () => {
    const image = Buffer.from("fresh screenshot");
    let captureDevice: BootedDevice | undefined;
    setSessionScreenshotResourceDependencies({
      resolveActiveSession: () => activeSession(),
      createScreenshotService: (device) => {
        captureDevice = device;
        return createTrackedScreenshot({ success: true, path: "/tmp/fresh.png" });
      },
    });
    setScreenshotFileSystem({
      stat: async () => ({ isFile: () => true }),
      readFile: async () => image,
    });

    const content = await readTemplate("automobile:device-session/session-123/screenshot");

    expect(captureDevice).toEqual(sessionDevice);
    expect(content).toEqual({
      uri: "automobile:device-session/session-123/screenshot",
      mimeType: "image/png",
      blob: image.toString("base64"),
    });
  });

  test("returns the actual MIME type for fresh JPEG, PNG, and WebP captures", async () => {
    for (const fixture of imageFixtures) {
      const image = fixture.bytes;
      const screenshotPath = `/tmp/fresh.${fixture.extension}`;
      setSessionScreenshotResourceDependencies({
        resolveActiveSession: () => activeSession(),
        createScreenshotService: () =>
          createTrackedScreenshot({ success: true, path: screenshotPath }),
      });
      setScreenshotFileSystem({
        stat: async () => ({ isFile: () => true }),
        readFile: async () => image,
      });

      const content = await readTemplate("automobile:device-session/session-123/screenshot");

      expect(content.mimeType).toBe(fixture.mimeType);
      expect(content.blob).toBe(image.toString("base64"));
    }
  });

  test("returns a typed non-retryable failure when no fresh screenshot session is active", async () => {
    setSessionScreenshotResourceDependencies({
      resolveActiveSession: () => undefined,
      createScreenshotService: () => createTrackedScreenshot({ success: false }),
    });

    const content = await readTemplate("automobile:device-session/session-123/screenshot");

    expect(content.mimeType).toBe("application/json");
    expect(JSON.parse(content.text!)).toEqual({
      code: "SESSION_NOT_ACTIVE",
      retryable: false,
      error: "No active device session found for sessionUuid session-123.",
    });
  });

  test("does not authorize a replacement session from a released session identity", async () => {
    let screenshotServiceCalls = 0;
    setSessionScreenshotResourceDependencies({
      resolveActiveSession: () => activeSession(),
      createScreenshotService: () => {
        screenshotServiceCalls++;
        return createTrackedScreenshot({ success: true, path: "/tmp/fresh.png" });
      },
    });

    const content = await readTemplate("automobile:device-session/session-123/screenshot", {
      releasedSessionUuid: sessionUuid,
    });

    expect(JSON.parse(content.text!).error).toContain("bound device session");
    expect(screenshotServiceCalls).toBe(0);
  });

  test("returns a typed retryable failure when fresh screenshot capture fails", async () => {
    setSessionScreenshotResourceDependencies({
      resolveActiveSession: () => activeSession(),
      createScreenshotService: () =>
        createTrackedScreenshot({
          success: false,
          error: "ADB screencap timed out",
        }),
    });

    const content = await readTemplate("automobile:device-session/session-123/screenshot");

    expect(content.mimeType).toBe("application/json");
    expect(JSON.parse(content.text!)).toEqual({
      code: "SCREENSHOT_CAPTURE_FAILED",
      retryable: true,
      error: "ADB screencap timed out",
    });
  });

  test("returns a typed non-retryable failure when fresh screenshot capture is cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    setSessionScreenshotResourceDependencies({
      resolveActiveSession: () => activeSession(),
      createScreenshotService: () =>
        createTrackedScreenshot({
          success: false,
          error: OPERATION_CANCELLED_MESSAGE,
        }),
    });

    const content = await readTemplate("automobile:device-session/session-123/screenshot", {
      sessionUuid,
      signal: controller.signal,
    });

    expect(JSON.parse(content.text!)).toEqual({
      code: "SCREENSHOT_CAPTURE_CANCELLED",
      retryable: false,
      error: OPERATION_CANCELLED_MESSAGE,
    });
  });

  test("returns a typed non-retryable failure when the fresh screenshot cannot be read", async () => {
    setSessionScreenshotResourceDependencies({
      resolveActiveSession: () => activeSession(),
      createScreenshotService: () =>
        createTrackedScreenshot({
          success: true,
          path: "/tmp/fresh.png",
        }),
    });
    setScreenshotFileSystem({
      stat: async () => ({ isFile: () => true }),
      readFile: async () => {
        throw new Error("EACCES: permission denied");
      },
    });

    const content = await readTemplate("automobile:device-session/session-123/screenshot");

    expect(JSON.parse(content.text!)).toEqual({
      code: "SCREENSHOT_READ_FAILED",
      retryable: false,
      error:
        "Failed to read fresh screenshot for sessionUuid session-123: EACCES: permission denied",
    });
  });

  test("does not return a PNG when cancellation occurs while reading the fresh screenshot", async () => {
    const controller = new AbortController();
    let resolveRead: (image: Buffer) => void = () => {};
    const pendingRead = new Promise<Buffer>((resolve) => {
      resolveRead = resolve;
    });
    setSessionScreenshotResourceDependencies({
      resolveActiveSession: () => activeSession(),
      createScreenshotService: () =>
        createTrackedScreenshot({
          success: true,
          path: "/tmp/fresh.png",
        }),
    });
    setScreenshotFileSystem({
      stat: async () => ({ isFile: () => true }),
      readFile: () => pendingRead,
    });

    const readPromise = readTemplate("automobile:device-session/session-123/screenshot", {
      sessionUuid,
      signal: controller.signal,
    });
    controller.abort();
    resolveRead(Buffer.from("fresh"));

    expect(JSON.parse((await readPromise).text!)).toMatchObject({
      code: "SCREENSHOT_CAPTURE_CANCELLED",
      retryable: false,
    });
  });

  test("does not return a PNG when ownership is lost while reading the fresh screenshot", async () => {
    let owned = true;
    let resolveRead: (image: Buffer) => void = () => {};
    const pendingRead = new Promise<Buffer>((resolve) => {
      resolveRead = resolve;
    });
    setSessionScreenshotResourceDependencies({
      resolveActiveSession: () => (owned ? activeSession() : undefined),
      createScreenshotService: () =>
        createTrackedScreenshot({
          success: true,
          path: "/tmp/fresh.png",
        }),
    });
    setScreenshotFileSystem({
      stat: async () => ({ isFile: () => true }),
      readFile: () => pendingRead,
    });

    const readPromise = readTemplate("automobile:device-session/session-123/screenshot");
    owned = false;
    resolveRead(Buffer.from("fresh"));

    expect(JSON.parse((await readPromise).text!)).toMatchObject({
      code: "SESSION_OWNERSHIP_LOST",
      retryable: false,
    });
  });

  test("waits for a pending capture before taking a distinct fresh capture", async () => {
    let resolvePendingCapture: (result: ScreenshotResult) => void = () => {};
    const pendingCapture = new Promise<ScreenshotResult>((resolve) => {
      resolvePendingCapture = resolve;
    });
    ScreenshotJobTracker.startJob(sessionDevice.deviceId, async () => pendingCapture);

    const image = Buffer.from("fresh screenshot");
    let freshCaptureCount = 0;
    let freshTrackerOptions: ScreenshotJobOptions | undefined;
    setSessionScreenshotResourceDependencies({
      resolveActiveSession: () => activeSession(),
      createScreenshotService: () => ({
        ...createTrackedScreenshot({ success: true, path: "/tmp/fresh.png" }),
        startTrackedCapture(options, trackerOptions) {
          freshTrackerOptions = trackerOptions;
          return ScreenshotJobTracker.startJob(
            sessionDevice.deviceId,
            async () => {
              freshCaptureCount++;
              return { success: true, path: "/tmp/fresh.png" };
            },
            trackerOptions,
          );
        },
      }),
    });
    setScreenshotFileSystem({
      stat: async () => ({ isFile: () => true }),
      readFile: async () => image,
    });

    const contentPromise = readTemplate("automobile:device-session/session-123/screenshot");
    await Promise.resolve();
    expect(freshCaptureCount).toBe(0);

    resolvePendingCapture({ success: true, path: "/tmp/older.png" });
    const content = await contentPromise;

    expect(freshCaptureCount).toBe(1);
    expect(freshTrackerOptions).toMatchObject({ queueAfterPending: true });
    expect(content.blob).toBe(image.toString("base64"));
  });

  test("forwards the resource read cancellation signal to the fresh capture", async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    setSessionScreenshotResourceDependencies({
      resolveActiveSession: () => activeSession(),
      createScreenshotService: () => ({
        ...createTrackedScreenshot({ success: false, error: "cancelled" }),
        startTrackedCapture(_options, trackerOptions) {
          receivedSignal = trackerOptions?.parentSignal;
          return ScreenshotJobTracker.startJob(
            sessionDevice.deviceId,
            async () => ({ success: false, error: "cancelled" }),
            trackerOptions,
          );
        },
      }),
    });

    await readTemplate("automobile:device-session/session-123/screenshot", {
      sessionUuid,
      signal: controller.signal,
    });

    expect(receivedSignal).toBe(controller.signal);
  });

  test("rejects a fresh capture when the session no longer owns its device", async () => {
    let reads = 0;
    setSessionScreenshotResourceDependencies({
      resolveActiveSession: () => {
        reads += 1;
        return reads === 1 ? activeSession() : undefined;
      },
      createScreenshotService: () =>
        createTrackedScreenshot({
          success: true,
          path: "/tmp/fresh.png",
        }),
    });

    const content = await readTemplate("automobile:device-session/session-123/screenshot");

    expect(content.mimeType).toBe("application/json");
    expect(JSON.parse(content.text!)).toEqual({
      code: "SESSION_OWNERSHIP_LOST",
      retryable: false,
      error: "Device session ownership was lost while capturing a fresh screenshot.",
    });
  });

  test("replaces an older direct session for the same device", () => {
    registerDirectSessionDevice("session-old", sessionDevice);
    registerDirectSessionDevice("session-new", sessionDevice);

    expect(resolveDirectSessionDevice("session-old")).toBeUndefined();
    expect(resolveDirectSessionDevice("session-new")).toEqual({
      sessionUuid: "session-new",
      device: sessionDevice,
      incarnation: expect.any(Number),
    });
  });
});

describe("unscoped latest observation resources", () => {
  const deviceA: BootedDevice = { deviceId: "emulator-5554", name: "Pixel A", platform: "android" };
  const deviceB: BootedDevice = { deviceId: "emulator-5556", name: "Pixel B", platform: "android" };

  // Injected once per test so both devices share one in-memory cache, and so
  // these tests never write through the process-wide FileSystemObserveCacheStore
  // into the shared cache directory.
  let cacheTimer: FakeTimer;
  let cacheStore: FakeObserveCacheStore;
  let observationIdGenerator: CountingIdGenerator;

  beforeEach(() => {
    cacheTimer = new FakeTimer();
    cacheStore = new FakeObserveCacheStore(cacheTimer);
    observationIdGenerator = new CountingIdGenerator("observation");
  });

  afterEach(() => {
    // The store is process-wide once injected, so drop it entirely rather than
    // only clearing entries out of the shared on-disk store.
    resetObserveCacheStore();
    ScreenshotJobTracker.clear();
    resetScreenshotStateStore();
    resetScreenshotFileSystem();
    ScreenshotJobTracker.resetTimer();
    clearDirectSessionDevices();
  });

  function readLatestObservation(context?: ResourceReadContext) {
    registerObservationResources();
    return ResourceRegistry.getResource(RESOURCE_URIS.LATEST_OBSERVATION)!.handler(context);
  }

  function readObservationScreenshot(deviceId: string, observationId: string) {
    registerObservationResources();
    const uri = `automobile:observation/${deviceId}/${observationId}/screenshot`;
    const match = ResourceRegistry.matchTemplate(uri);
    expect(match).toBeDefined();
    const { template, params } = match!;
    expect("handler" in template).toBe(true);
    if (!("handler" in template)) {
      throw new Error("Expected an observation screenshot template handler");
    }
    return template.handler(params);
  }

  async function cacheObservationFor(
    device: BootedDevice,
    marker: string,
    observationId?: string,
  ): Promise<ObserveResult> {
    const observeScreen = new RealObserveScreen(
      device,
      new FakeAdbClientFactory(new FakeAdbExecutor()),
      { cacheStore },
      cacheTimer,
      observationIdGenerator,
    );
    const observation = {
      ...observeScreen.createBaseResult(),
      ...(observationId ? { observationId } : {}),
      viewHierarchy: marker,
    } as ObserveResult;
    await observeScreen.cacheObserveResult(observation);
    return observation;
  }

  test("registers the observation-identity-scoped screenshot template", () => {
    registerObservationResources();

    expect(ResourceRegistry.getTemplate(RESOURCE_URIS.OBSERVATION_SCREENSHOT)).toBeDefined();
  });

  test("serves the screenshot captured with the requested observation", async () => {
    const { observationId } = await cacheObservationFor(deviceA, "device-a-hierarchy");
    const image = Buffer.from("89504e470d0a1a0a", "hex");
    getScreenshotStateStore().updateForObservation(
      deviceA.deviceId,
      observationId,
      "/tmp/device-a.png",
    );
    setScreenshotFileSystem({
      stat: async () => ({ isFile: () => true }),
      readFile: async () => image,
    });

    const screenshot = await readObservationScreenshot(deviceA.deviceId, observationId);

    expect(screenshot.uri).toBe(
      `automobile:observation/${deviceA.deviceId}/${observationId}/screenshot`,
    );
    expect(screenshot.mimeType).toBe("image/png");
    expect(screenshot.blob).toBe(image.toString("base64"));
  });

  test("serves an observation's stored screenshot without waiting for an unrelated pending capture", async () => {
    const { observationId } = await cacheObservationFor(deviceA, "device-a-hierarchy");
    const image = Buffer.from("89504e470d0a1a0a", "hex");
    getScreenshotStateStore().updateForObservation(
      deviceA.deviceId,
      observationId,
      "/tmp/device-a-stored.png",
    );
    ScreenshotJobTracker.setTimer(new FakeTimer());
    ScreenshotJobTracker.startJob(deviceA.deviceId, async () => new Promise(() => {}));
    setScreenshotFileSystem({
      stat: async () => ({ isFile: () => true }),
      readFile: async () => image,
    });

    const outcome = await Promise.race([
      readObservationScreenshot(deviceA.deviceId, observationId),
      settleSentinel(),
    ]);

    expect(outcome).not.toBe("still-pending");
    expect(outcome).toMatchObject({
      mimeType: "image/png",
      blob: image.toString("base64"),
    });
  });

  test("returns a JSON error when the observation id is unknown or evicted", async () => {
    await cacheObservationFor(deviceA, "device-a-hierarchy");

    const screenshot = await readObservationScreenshot(deviceA.deviceId, "evicted-observation");

    expect(screenshot.mimeType).toBe("application/json");
    expect(screenshot.text).toContain("unknown or has been superseded");
  });

  test("waits for a pending capture for the requested observation", async () => {
    const { observationId } = await cacheObservationFor(deviceA, "device-a-hierarchy");
    getScreenshotStateStore().beginObservation(deviceA.deviceId, observationId);
    const gate = createGate();
    const image = Buffer.from("89504e470d0a1a0a", "hex");
    const job = ScreenshotJobTracker.startJob(deviceA.deviceId, async () => {
      await gate.promise;
      getScreenshotStateStore().updateForObservation(
        deviceA.deviceId,
        observationId,
        "/tmp/device-a-pending.png",
      );
      return { success: true, path: "/tmp/device-a-pending.png" };
    });
    ScreenshotJobTracker.setTimer(new FakeTimer());
    setScreenshotFileSystem({
      stat: async () => ({ isFile: () => true }),
      readFile: async () => image,
    });

    const screenshotPromise = readObservationScreenshot(deviceA.deviceId, observationId);

    expect(await Promise.race([screenshotPromise, settleSentinel()])).toBe("still-pending");
    gate.open();

    const screenshot = await screenshotPromise;
    expect(screenshot.mimeType).toBe("image/png");
    expect(screenshot.blob).toBe(image.toString("base64"));
    await job.promise;
  });

  test("waits for the observation-scoped write after the raw capture job resolves", async () => {
    const { observationId } = await cacheObservationFor(deviceA, "device-a-hierarchy");
    const gate = createGate();
    const image = Buffer.from("89504e470d0a1a0a", "hex");
    const store = getScreenshotStateStore();
    store.beginObservation(deviceA.deviceId, observationId);
    const job = ScreenshotJobTracker.startJob(deviceA.deviceId, async () => {
      await gate.promise;
      return { success: true, path: "/tmp/device-a-after-job.png" };
    });
    ScreenshotJobTracker.setTimer(new FakeTimer());
    setScreenshotFileSystem({
      stat: async () => ({ isFile: () => true }),
      readFile: async () => image,
    });

    const screenshotPromise = readObservationScreenshot(deviceA.deviceId, observationId);
    expect(await Promise.race([screenshotPromise, settleSentinel()])).toBe("still-pending");

    gate.open();
    await job.promise;

    // `ScreenshotJobTracker.waitForCompletion` would have resolved above, but
    // the recorder's later path-existence/write step has not completed yet.
    expect(await Promise.race([screenshotPromise, settleSentinel()])).toBe("still-pending");
    store.updateForObservation(deviceA.deviceId, observationId, "/tmp/device-a-after-job.png");

    expect((await screenshotPromise).blob).toBe(image.toString("base64"));
  });

  test("does not wait behind a later queued fresh capture for another observation", async () => {
    const { observationId } = await cacheObservationFor(deviceA, "device-a-hierarchy");
    const gate = createGate();
    const image = Buffer.from("89504e470d0a1a0a", "hex");
    const store = getScreenshotStateStore();
    store.beginObservation(deviceA.deviceId, observationId);
    const observationJob = ScreenshotJobTracker.startJob(deviceA.deviceId, async () => {
      await gate.promise;
      store.updateForObservation(deviceA.deviceId, observationId, "/tmp/device-a-exact.png");
      return { success: true, path: "/tmp/device-a-exact.png" };
    });
    ScreenshotJobTracker.startJob(
      deviceA.deviceId,
      async () => new Promise<ScreenshotResult>(() => {}),
      { queueAfterPending: true },
    );
    ScreenshotJobTracker.setTimer(new FakeTimer());
    setScreenshotFileSystem({
      stat: async () => ({ isFile: () => true }),
      readFile: async () => image,
    });

    const screenshotPromise = readObservationScreenshot(deviceA.deviceId, observationId);
    expect(await Promise.race([screenshotPromise, settleSentinel()])).toBe("still-pending");

    gate.open();
    await observationJob.promise;

    // The second job remains pending, but this resource is keyed to the first observation.
    expect((await screenshotPromise).blob).toBe(image.toString("base64"));
  });

  test("waits for the pending capture instead of serving a prior observation's screenshot", async () => {
    await cacheObservationFor(deviceA, "device-a-prior-hierarchy");
    getScreenshotStateStore().update(deviceA.deviceId, "/tmp/device-a-prior.png");
    cacheTimer.advanceTime(1);
    const { observationId } = await cacheObservationFor(deviceA, "device-a-current-hierarchy");
    getScreenshotStateStore().beginObservation(deviceA.deviceId, observationId);
    const gate = createGate();
    const priorImage = Buffer.from("prior screenshot");
    const currentImage = Buffer.from("current screenshot");
    const job = ScreenshotJobTracker.startJob(deviceA.deviceId, async () => {
      await gate.promise;
      getScreenshotStateStore().updateForObservation(
        deviceA.deviceId,
        observationId,
        "/tmp/device-a-current.png",
      );
      return { success: true, path: "/tmp/device-a-current.png" };
    });
    ScreenshotJobTracker.setTimer(new FakeTimer());
    setScreenshotFileSystem({
      stat: async () => ({ isFile: () => true }),
      readFile: async (path) => (path === "/tmp/device-a-prior.png" ? priorImage : currentImage),
    });

    const screenshotPromise = readObservationScreenshot(deviceA.deviceId, observationId);

    expect(await Promise.race([screenshotPromise, settleSentinel()])).toBe("still-pending");
    gate.open();

    const screenshot = await screenshotPromise;
    expect(screenshot.blob).toBe(currentImage.toString("base64"));
    await job.promise;
  });

  test("does not serve a newer screenshot when the requested observation is replaced while waiting", async () => {
    const { observationId } = await cacheObservationFor(deviceA, "device-a-hierarchy");
    getScreenshotStateStore().beginObservation(deviceA.deviceId, observationId);
    const gate = createGate();
    const job = ScreenshotJobTracker.startJob(deviceA.deviceId, async () => {
      await gate.promise;
      getScreenshotStateStore().updateForObservation(
        deviceA.deviceId,
        observationId,
        "/tmp/device-a-newer.png",
      );
      return { success: true, path: "/tmp/device-a-newer.png" };
    });
    ScreenshotJobTracker.setTimer(new FakeTimer());

    const screenshotPromise = readObservationScreenshot(deviceA.deviceId, observationId);
    expect(await Promise.race([screenshotPromise, settleSentinel()])).toBe("still-pending");

    cacheTimer.advanceTime(1);
    await cacheObservationFor(deviceA, "device-a-newer-hierarchy");
    gate.open();

    const screenshot = await screenshotPromise;
    expect(screenshot.mimeType).toBe("application/json");
    expect(screenshot.text).toContain("unknown or has been superseded");
    await job.promise;
  });

  test("does not use a stale device-wide screenshot after the exact capture wait times out", async () => {
    const { observationId } = await cacheObservationFor(deviceA, "device-a-hierarchy");
    const timer = new FakeTimer();
    setScreenshotStateStore(new InMemoryScreenshotStateStore(timer));
    getScreenshotStateStore().beginObservation(deviceA.deviceId, observationId);
    getScreenshotStateStore().update(deviceA.deviceId, "/tmp/stale.png");
    ScreenshotJobTracker.setTimer(timer);
    ScreenshotJobTracker.startJob(deviceA.deviceId, async () => new Promise(() => {}));
    setScreenshotFileSystem({
      stat: async () => ({ isFile: () => true }),
      readFile: async () => Buffer.from("stale screenshot"),
    });

    const screenshotPromise = readObservationScreenshot(deviceA.deviceId, observationId);
    await Promise.resolve();
    timer.advanceTime(10_000);

    const screenshot = await screenshotPromise;
    expect(screenshot.mimeType).toBe("application/json");
    expect(screenshot.text).toContain("not ready");
  });

  test("decodes encoded observation screenshot path parameters", async () => {
    const encodedDevice: BootedDevice = {
      deviceId: "192.168.1.10:5555",
      name: "Wireless Pixel",
      platform: "android",
    };
    const observation = await cacheObservationFor(
      encodedDevice,
      "wireless-hierarchy",
      "observation:one",
    );
    getScreenshotStateStore().updateForObservation(
      encodedDevice.deviceId,
      observation.observationId,
      "/tmp/wireless.png",
    );
    setScreenshotFileSystem({
      stat: async () => ({ isFile: () => true }),
      readFile: async () => Buffer.from("89504e470d0a1a0a", "hex"),
    });

    const screenshot = await readObservationScreenshot(
      encodeURIComponent(encodedDevice.deviceId),
      encodeURIComponent(observation.observationId),
    );

    expect(screenshot.mimeType).toBe("image/png");
  });

  test("returns a typed JSON error for malformed observation screenshot path parameters", async () => {
    const screenshot = await readObservationScreenshot("device%ZZ", "observation%ZZ");

    expect(screenshot.mimeType).toBe("application/json");
    expect(screenshot.text).toContain("Malformed resource URI");
  });

  test("assigns a new observation identity even when hierarchy timestamps are reused", async () => {
    const screen = new RealObserveScreen(
      deviceA,
      new FakeAdbClientFactory(new FakeAdbExecutor()),
      { cacheStore },
      cacheTimer,
      new CountingIdGenerator("observation"),
    );
    const first = { ...screen.createBaseResult(), updatedAt: "reused-hierarchy-timestamp" };
    const second = { ...screen.createBaseResult(), updatedAt: "reused-hierarchy-timestamp" };

    expect(first.updatedAt).toBe(second.updatedAt);
    expect(first.observationId).not.toBe(second.observationId);
  });

  test("does not pair one device's hierarchy with another device's screenshot", async () => {
    // Device A observed first and its screenshot landed; device B observed after
    // but its screenshot write is still in flight (issue #6600).
    await cacheObservationFor(deviceA, "device-a-hierarchy");
    getScreenshotStateStore().update(deviceA.deviceId, "/tmp/device-a.png");
    await cacheObservationFor(deviceB, "device-b-hierarchy");
    setScreenshotFileSystem({
      stat: async () => ({ isFile: () => true }),
      readFile: async () => Buffer.from("89504e470d0a1a0a", "hex"),
    });

    const observation = await readLatestObservation();
    const screenshot = await readLatestScreenshot();

    expect(JSON.parse(observation.text!).viewHierarchy).toBe("device-b-hierarchy");
    // Device A's screenshot must never be served for device B's hierarchy.
    expect(screenshot.blob).toBeUndefined();
    expect(screenshot.mimeType).toBe("application/json");
    expect(JSON.parse(screenshot.text!).error).toContain("No screenshot available");
  });

  test("waits for the observed device's pending job, not the newest pending job", async () => {
    // Device A has a stale cached capture and, later, the newest pending job;
    // device B is the device the latest observation belongs to (issue #6600).
    await cacheObservationFor(deviceA, "device-a-hierarchy");
    getScreenshotStateStore().update(deviceA.deviceId, "/tmp/device-a-stale.png");
    await cacheObservationFor(deviceB, "device-b-hierarchy");

    const gateB = createGate();
    const gateA = createGate();
    const jobB = ScreenshotJobTracker.startJob(deviceB.deviceId, async () => {
      await gateB.promise;
      getScreenshotStateStore().update(deviceB.deviceId, "/tmp/device-b.png");
      return { success: true, path: "/tmp/device-b.png" };
    });
    // Started last, so a global newest-pending lookup would settle on device A.
    const jobA = ScreenshotJobTracker.startJob(deviceA.deviceId, async () => {
      await gateA.promise;
      getScreenshotStateStore().update(deviceA.deviceId, "/tmp/device-a-fresh.png");
      return { success: true, path: "/tmp/device-a-fresh.png" };
    });
    // A fake timer keeps the 3s wait budget from expiring, so the read can only
    // finish by actually awaiting a job - never by timing out and re-reading.
    ScreenshotJobTracker.setTimer(new FakeTimer());

    const readPaths: string[] = [];
    setScreenshotFileSystem({
      stat: async () => ({ isFile: () => true }),
      readFile: async (path) => {
        readPaths.push(path);
        return Buffer.from("89504e470d0a1a0a", "hex");
      },
    });

    const screenshotPromise = readLatestScreenshot();
    // Only device B's capture lands; device A's stays in flight throughout, so
    // a read that awaited device A's job would never settle.
    gateB.open();
    const outcome = await Promise.race([screenshotPromise, settleSentinel()]);
    expect(outcome).not.toBe("still-pending");

    const screenshot = await screenshotPromise;

    expect(screenshot.mimeType).toBe("image/png");
    expect(readPaths).toEqual(["/tmp/device-b.png"]);

    gateA.open();
    await Promise.all([jobA.promise, jobB.promise]);
  });

  test("still serves the cached screenshot when only one device is observed", async () => {
    await cacheObservationFor(deviceA, "device-a-hierarchy");
    getScreenshotStateStore().update(deviceA.deviceId, "/tmp/device-a.png");
    const readPaths: string[] = [];
    setScreenshotFileSystem({
      stat: async () => ({ isFile: () => true }),
      readFile: async (path) => {
        readPaths.push(path);
        return Buffer.from("89504e470d0a1a0a", "hex");
      },
    });

    const observation = await readLatestObservation();
    const screenshot = await readLatestScreenshot();

    expect(JSON.parse(observation.text!).viewHierarchy).toBe("device-a-hierarchy");
    expect(screenshot.mimeType).toBe("image/png");
    expect(readPaths).toEqual(["/tmp/device-a.png"]);
  });

  test("re-resolves the screenshot to the latest observation after a hierarchy read", async () => {
    // Both devices have a landed screenshot; device B owns the latest observation.
    await cacheObservationFor(deviceA, "device-a-hierarchy");
    getScreenshotStateStore().update(deviceA.deviceId, "/tmp/device-a.png");
    cacheTimer.advanceTime(1);
    await cacheObservationFor(deviceB, "device-b-hierarchy");
    getScreenshotStateStore().update(deviceB.deviceId, "/tmp/device-b.png");

    const readPaths: string[] = [];
    setScreenshotFileSystem({
      stat: async () => ({ isFile: () => true }),
      readFile: async (path) => {
        readPaths.push(path);
        return Buffer.from("89504e470d0a1a0a", "hex");
      },
    });

    const context: ResourceReadContext = { sessionUuid: "client-1" };
    const observation = await readLatestObservation(context);
    expect(JSON.parse(observation.text!).viewHierarchy).toBe("device-b-hierarchy");

    // Device A completes an observation in between the client's two reads, so a
    // second global "most recent" lookup would now resolve to device A.
    cacheTimer.advanceTime(1);
    await cacheObservationFor(deviceA, "device-a-hierarchy-2");
    getScreenshotStateStore().update(deviceA.deviceId, "/tmp/device-a-2.png");

    const screenshot = await readLatestScreenshot(context);

    expect(screenshot.mimeType).toBe("image/png");
    // The unscoped screenshot is the current latest at this read, not a
    // per-client binding to the earlier hierarchy (issue #6600 hole 1).
    expect(readPaths).toEqual(["/tmp/device-a-2.png"]);
  });

  test("serves each client the current latest screenshot after separate hierarchy reads", async () => {
    await cacheObservationFor(deviceA, "device-a-hierarchy");
    getScreenshotStateStore().update(deviceA.deviceId, "/tmp/device-a.png");

    const readPaths: string[] = [];
    setScreenshotFileSystem({
      stat: async () => ({ isFile: () => true }),
      readFile: async (path) => {
        readPaths.push(path);
        return Buffer.from("89504e470d0a1a0a", "hex");
      },
    });

    const clientOne: ResourceReadContext = { sessionUuid: "client-1" };
    const clientTwo: ResourceReadContext = { sessionUuid: "client-2" };
    await readLatestObservation(clientOne);

    cacheTimer.advanceTime(1);
    await cacheObservationFor(deviceB, "device-b-hierarchy");
    getScreenshotStateStore().update(deviceB.deviceId, "/tmp/device-b.png");
    await readLatestObservation(clientTwo);

    await readLatestScreenshot(clientOne);
    await readLatestScreenshot(clientTwo);

    // Unscoped reads do not preserve a per-client binding; both resolve device
    // B because it is latest at the time each screenshot is read (issue #6600).
    expect(readPaths).toEqual(["/tmp/device-b.png", "/tmp/device-b.png"]);
  });

  test("falls back to the globally latest observation when no hierarchy was read", async () => {
    await cacheObservationFor(deviceA, "device-a-hierarchy");
    getScreenshotStateStore().update(deviceA.deviceId, "/tmp/device-a.png");
    cacheTimer.advanceTime(1);
    await cacheObservationFor(deviceB, "device-b-hierarchy");
    getScreenshotStateStore().update(deviceB.deviceId, "/tmp/device-b.png");

    const readPaths: string[] = [];
    setScreenshotFileSystem({
      stat: async () => ({ isFile: () => true }),
      readFile: async (path) => {
        readPaths.push(path);
        return Buffer.from("89504e470d0a1a0a", "hex");
      },
    });

    await readLatestScreenshot({ sessionUuid: "client-1" });

    expect(readPaths).toEqual(["/tmp/device-b.png"]);
  });

  test("serves the new latest screenshot after the previously latest observation is invalidated", async () => {
    await cacheObservationFor(deviceB, "device-b-hierarchy");
    getScreenshotStateStore().update(deviceB.deviceId, "/tmp/device-b.png");

    const readPaths: string[] = [];
    setScreenshotFileSystem({
      stat: async () => ({ isFile: () => true }),
      readFile: async (path) => {
        readPaths.push(path);
        return Buffer.from("89504e470d0a1a0a", "hex");
      },
    });

    const context: ResourceReadContext = { sessionUuid: "client-1" };
    await readLatestObservation(context);

    // Device B's cache is invalidated, and device A becomes the latest observation.
    cacheStore.clear(deviceB.deviceId);
    cacheTimer.advanceTime(1);
    await cacheObservationFor(deviceA, "device-a-hierarchy");
    getScreenshotStateStore().update(deviceA.deviceId, "/tmp/device-a.png");

    await readLatestScreenshot(context);

    // There is no binding to drop: each screenshot read resolves the current
    // latest entry, which is device A after device B is invalidated.
    expect(readPaths).toEqual(["/tmp/device-a.png"]);
  });

  test("re-resolves screenshot-only rereads after another device becomes latest", async () => {
    await cacheObservationFor(deviceA, "device-a-hierarchy");
    getScreenshotStateStore().update(deviceA.deviceId, "/tmp/device-a.png");
    const readPaths: string[] = [];
    setScreenshotFileSystem({
      stat: async () => ({ isFile: () => true }),
      readFile: async (path) => {
        readPaths.push(path);
        return Buffer.from("89504e470d0a1a0a", "hex");
      },
    });

    const context: ResourceReadContext = { sessionUuid: "client-1" };
    await readLatestObservation(context);

    cacheTimer.advanceTime(1);
    await cacheObservationFor(deviceB, "device-b-hierarchy");
    getScreenshotStateStore().update(deviceB.deviceId, "/tmp/device-b.png");

    await readLatestScreenshot(context);

    // A screenshot-only reread must not retain device A after device B becomes
    // latest (PRRT_kwDOP-GF5M6h5Kov).
    expect(readPaths).toEqual(["/tmp/device-b.png"]);
  });

  test("resolves sessionless interleaved reads from the current latest entry", async () => {
    await cacheObservationFor(deviceA, "device-a-hierarchy");
    getScreenshotStateStore().update(deviceA.deviceId, "/tmp/device-a.png");
    const readPaths: string[] = [];
    setScreenshotFileSystem({
      stat: async () => ({ isFile: () => true }),
      readFile: async (path) => {
        readPaths.push(path);
        return Buffer.from("89504e470d0a1a0a", "hex");
      },
    });

    // Both callers are literally sessionless, so no context identity is
    // available to share or collide on (PRRT_kwDOP-GF5M6h5Kox).
    await readLatestObservation(undefined);
    cacheTimer.advanceTime(1);
    await cacheObservationFor(deviceB, "device-b-hierarchy");
    getScreenshotStateStore().update(deviceB.deviceId, "/tmp/device-b.png");
    await readLatestObservation(undefined);

    await readLatestScreenshot(undefined);

    expect(readPaths).toEqual(["/tmp/device-b.png"]);
  });

  test("resolves a concurrent screenshot independently after a later observation lands", async () => {
    await cacheObservationFor(deviceA, "device-a-hierarchy");
    getScreenshotStateStore().update(deviceA.deviceId, "/tmp/device-a.png");
    const readPaths: string[] = [];
    setScreenshotFileSystem({
      stat: async () => ({ isFile: () => true }),
      readFile: async (path) => {
        readPaths.push(path);
        return Buffer.from("89504e470d0a1a0a", "hex");
      },
    });

    // Schedule the screenshot concurrently but defer its synchronous device
    // resolution until after device B lands. The hierarchy promise is still
    // unobserved; this proves the screenshot does not depend on a hierarchy
    // binding having committed first (PRRT_kwDOP-GF5M6h5Koy).
    const hierarchyPromise = readLatestObservation();
    const screenshotPromise = Promise.resolve().then(() => readLatestScreenshot());
    cacheTimer.advanceTime(1);
    const cacheDeviceB = cacheObservationFor(deviceB, "device-b-hierarchy");
    getScreenshotStateStore().update(deviceB.deviceId, "/tmp/device-b.png");
    await cacheDeviceB;

    const [hierarchy, screenshot] = await Promise.all([hierarchyPromise, screenshotPromise]);

    expect(JSON.parse(hierarchy.text!).viewHierarchy).toBe("device-a-hierarchy");
    expect(screenshot.mimeType).toBe("image/png");
    expect(readPaths).toEqual(["/tmp/device-b.png"]);
  });
});
