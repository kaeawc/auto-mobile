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
  resetScreenshotStateStore,
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

function readLatestScreenshot() {
  registerObservationResources();
  return ResourceRegistry.getResource(RESOURCE_URIS.LATEST_SCREENSHOT)!.handler();
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

  beforeEach(() => {
    cacheTimer = new FakeTimer();
    cacheStore = new FakeObserveCacheStore(cacheTimer);
  });

  afterEach(() => {
    // The store is process-wide once injected, so drop it entirely rather than
    // only clearing entries out of the shared on-disk store.
    resetObserveCacheStore();
    ScreenshotJobTracker.clear();
    resetScreenshotStateStore();
    resetScreenshotFileSystem();
    ScreenshotJobTracker.resetTimer();
  });

  function readLatestObservation() {
    registerObservationResources();
    return ResourceRegistry.getResource(RESOURCE_URIS.LATEST_OBSERVATION)!.handler();
  }

  async function cacheObservationFor(device: BootedDevice, marker: string): Promise<void> {
    const observeScreen = new RealObserveScreen(
      device,
      new FakeAdbClientFactory(new FakeAdbExecutor()),
      { cacheStore },
      cacheTimer,
    );
    await observeScreen.cacheObserveResult({
      ...observeScreen.createBaseResult(),
      viewHierarchy: marker,
    } as ObserveResult);
  }

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
});
