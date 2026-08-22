import { afterEach, describe, expect, test } from "bun:test";
import type { BootedDevice, ObserveResult } from "../../src/models";
import type { ScreenshotResult } from "../../src/models/ScreenshotResult";
import type { TrackedScreenshotService } from "../../src/features/observe/screenshot/ObserveScreenshotRecorder";
import { RealObserveScreen } from "../../src/features/observe/ObserveScreen";
import {
  RESOURCE_URIS,
  registerObservationResources,
  resetSessionScreenshotResourceDependencies,
  resetScreenshotFileSystem,
  setSessionScreenshotResourceDependencies,
  setScreenshotFileSystem,
} from "../../src/server/observationResources";
import { ResourceRegistry } from "../../src/server/resourceRegistry";
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

function readTemplate(uri: string) {
  registerObservationResources();
  const match = ResourceRegistry.matchTemplate(uri);
  expect(match).toBeDefined();
  return match!.template.handler(match!.params);
}

function createTrackedScreenshot(result: ScreenshotResult): TrackedScreenshotService {
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
    startTrackedCapture() {
      const controller = new AbortController();
      return {
        jobId: "fresh-capture",
        promise: Promise.resolve(result),
        signal: controller.signal,
      };
    },
  };
}

describe("session screenshot resources", () => {
  afterEach(() => {
    RealObserveScreen.clearCache();
    resetSessionScreenshotResourceDependencies();
    resetScreenshotFileSystem();
  });

  test("registers session-scoped cached and fresh screenshot templates", () => {
    registerObservationResources();

    expect(ResourceRegistry.getTemplate(RESOURCE_URIS.SESSION_OBSERVATION)).toBeDefined();
    expect(ResourceRegistry.getTemplate(RESOURCE_URIS.SESSION_SCREENSHOT)).toBeDefined();
    expect(ResourceRegistry.getTemplate(RESOURCE_URIS.FRESH_SESSION_SCREENSHOT)).toBeDefined();
    expect(ResourceRegistry.getTemplate("automobile:observation/{deviceId}/latest")).toBeUndefined();
  });

  test("does not expose another device's cached observation through a session path", async () => {
    const otherDevice: BootedDevice = {
      deviceId: "emulator-5556",
      name: "Pixel 10",
      platform: "android",
    };
    const observeScreen = new RealObserveScreen(otherDevice, new FakeAdbClientFactory(new FakeAdbExecutor()));
    const observed: ObserveResult = {
      ...observeScreen.createBaseResult(),
      viewHierarchy: "only-other-device",
    };
    await observeScreen.cacheObserveResult(observed);
    setSessionScreenshotResourceDependencies({
      resolveActiveSession: () => activeSession(),
      createScreenshotService: () => createTrackedScreenshot({ success: false }),
    });

    const content = await readTemplate(
      "automobile:observation/session/session-123/latest",
    );

    expect(content.uri).toBe("automobile:observation/session/session-123/latest");
    expect(content.mimeType).toBe("application/json");
    expect(JSON.parse(content.text!).error).toContain("No observation available for sessionUuid session-123");
  });

  test("returns a fresh PNG capture for an active session", async () => {
    const image = Buffer.from("fresh screenshot");
    let captureDevice: BootedDevice | undefined;
    setSessionScreenshotResourceDependencies({
      resolveActiveSession: () => activeSession(),
      createScreenshotService: device => {
        captureDevice = device;
        return createTrackedScreenshot({ success: true, path: "/tmp/fresh.png" });
      },
    });
    setScreenshotFileSystem({
      stat: async () => ({ isFile: () => true }),
      readFile: async () => image,
    });

    const content = await readTemplate(
      "automobile:device-session/session-123/screenshot",
    );

    expect(captureDevice).toEqual(sessionDevice);
    expect(content).toEqual({
      uri: "automobile:device-session/session-123/screenshot",
      mimeType: "image/png",
      blob: image.toString("base64"),
    });
  });

  test("rejects a fresh capture when the session no longer owns its device", async () => {
    let reads = 0;
    setSessionScreenshotResourceDependencies({
      resolveActiveSession: () => {
        reads += 1;
        return reads === 1 ? activeSession() : undefined;
      },
      createScreenshotService: () => createTrackedScreenshot({
        success: true,
        path: "/tmp/fresh.png",
      }),
    });

    const content = await readTemplate(
      "automobile:device-session/session-123/screenshot",
    );

    expect(content.mimeType).toBe("application/json");
    expect(JSON.parse(content.text!).error).toContain("No active device session found");
  });
});
