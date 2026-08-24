import { afterEach, describe, expect, test } from "bun:test";
import type { BootedDevice, ObserveResult } from "../../src/models";
import type { ScreenshotResult } from "../../src/models/ScreenshotResult";
import type { TrackedScreenshotService } from "../../src/features/observe/screenshot/ObserveScreenshotRecorder";
import type { ScreenshotJobOptions } from "../../src/utils/ScreenshotJobTracker";
import { RealObserveScreen } from "../../src/features/observe/ObserveScreen";
import { ScreenshotJobTracker } from "../../src/utils/ScreenshotJobTracker";
import {
  RESOURCE_URIS,
  registerObservationResources,
  resetSessionScreenshotResourceDependencies,
  resetScreenshotFileSystem,
  setSessionScreenshotResourceDependencies,
  setScreenshotFileSystem,
} from "../../src/server/observationResources";
import { ResourceRegistry, type ResourceReadContext } from "../../src/server/resourceRegistry";
import {
  clearDirectSessionDevices,
  registerDirectSessionDevice,
  resolveDirectSessionDevice,
} from "../../src/server/directSessionDeviceRegistry";
import { FakeAdbClientFactory } from "../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";

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
    expect(JSON.parse(content.text!).error).toContain("No active device session found");
  });

  test("replaces an older direct session for the same device", () => {
    registerDirectSessionDevice("session-old", sessionDevice);
    registerDirectSessionDevice("session-new", sessionDevice);

    expect(resolveDirectSessionDevice("session-old")).toBeUndefined();
    expect(resolveDirectSessionDevice("session-new")).toEqual({
      sessionUuid: "session-new",
      device: sessionDevice,
    });
  });
});
