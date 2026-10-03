import { describe, expect, test } from "bun:test";
import {
  createObserveAppDataSource,
  registerObserveAppResource,
  renderObserveAppHtml,
  OBSERVE_APP_RESOURCE_URI,
  type ObserveAppDependencies,
} from "../../src/server/observeAppResource";
import { ResourceRegistry, type ResourceReadContext } from "../../src/server/resourceRegistry";
import {
  readRetainedScreenshot,
  type ScreenshotFileSystem,
} from "../../src/server/retainedScreenshot";
import type { ObserveResult } from "../../src/models/ObserveResult";
import { FakeObserveCacheStore } from "../fakes/FakeObserveCacheStore";
import {
  getObserveCacheStore,
  setObserveCacheStore,
} from "../../src/features/observe/cache/ObserveCacheRegistry";
import {
  getScreenshotStateStore,
  setScreenshotStateStore,
} from "../../src/features/observe/screenshot/ScreenshotStateRegistry";
import {
  registerDirectSessionDevice,
  unregisterDirectSession,
} from "../../src/server/directSessionDeviceRegistry";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeScreenshotStateStore } from "../fakes/FakeScreenshotStateStore";
import {
  loadAndroidHomeObserve,
  loadIosFractionalObserve,
} from "../fixtures/observe/observeFixture";

// Captured hierarchies, with only capture identity varied for this resource's contract.
const observeA = {
  ...loadAndroidHomeObserve().observe,
  deviceId: "device-A",
  observationId: "obs-A",
};
const observeB = { ...loadIosFractionalObserve(), deviceId: "device-B", observationId: "obs-B" };
const png = Buffer.from("89504e470d0a1a0a", "hex");
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
const expiresAt = 600_000;

function makeHarness() {
  const store = new FakeScreenshotStateStore(new FakeTimer());
  store.updateForObservation("device-A", "obs-A", "A.jpg");
  store.updateForObservation("device-B", "obs-B", "B.png"); // B was observed last.
  const observations = new Map<string, ObserveResult>([
    ["device-A", observeA],
    ["device-B", observeB],
  ]);
  const protectedPaths: string[] = [];
  const reads: string[] = [];
  const files = new Map([
    ["A.jpg", jpeg],
    ["B.png", png],
  ]);
  const fileSystem: ScreenshotFileSystem = {
    stat: async () => ({ isFile: () => true }),
    readFile: async (path) => {
      reads.push(path);
      const bytes = files.get(path);
      if (!bytes) {
        throw Object.assign(new Error("gone"), { code: "ENOENT" });
      }
      return bytes;
    },
  };
  const dependencies: ObserveAppDependencies = {
    resolveActiveSession: (sessionUuid) => {
      const device =
        sessionUuid === "session-A" ? observeA : sessionUuid === "session-B" ? observeB : undefined;
      return device
        ? {
            sessionUuid,
            incarnation: 1,
            device: { deviceId: device.deviceId, name: device.deviceId, platform: "android" },
          }
        : undefined;
    },
    getCachedResult: (deviceId) => observations.get(deviceId),
    getScreenshotPath: (deviceId, observationId) =>
      store.getPathForObservation(deviceId, observationId),
    isScreenshotPending: (deviceId, observationId) =>
      store.isObservationPending(deviceId, observationId),
    readScreenshot: (path) =>
      readRetainedScreenshot({
        path,
        fileSystem,
        protection: {
          protect: async (protectedPath) => {
            protectedPaths.push(protectedPath);
            return expiresAt;
          },
        },
      }),
  };
  const read = async (context: ResourceReadContext = {}) => {
    ResourceRegistry.clearResources();
    registerObserveAppResource({ dataSource: createObserveAppDataSource({ dependencies }) });
    return (await ResourceRegistry.getResource(OBSERVE_APP_RESOURCE_URI)!.handler(context)).text!;
  };
  return { store, observations, protectedPaths, reads, files, fileSystem, dependencies, read };
}

const contextA = { sessionUuid: "session-A", ownsSession: (uuid: string) => uuid === "session-A" };

describe("session-bound observe App captures", () => {
  test("production source resolves the reading session through the per-device cache", async () => {
    const timer = new FakeTimer();
    const cache = new FakeObserveCacheStore(timer);
    const previousCache = getObserveCacheStore();
    const previousScreenshots = getScreenshotStateStore();
    await cache.put("device-A", observeA);
    timer.advanceTime(1);
    await cache.put("device-B", observeB);
    setObserveCacheStore(cache);
    setScreenshotStateStore(new FakeScreenshotStateStore(timer));
    registerDirectSessionDevice("app-production-A", {
      deviceId: "device-A",
      name: "A",
      platform: "android",
    });
    registerDirectSessionDevice("app-production-B", {
      deviceId: "device-B",
      name: "B",
      platform: "ios",
    });
    try {
      ResourceRegistry.clearResources();
      registerObserveAppResource();
      const read = ResourceRegistry.getResource(OBSERVE_APP_RESOURCE_URI)!.handler;
      const a = (await read({ sessionUuid: "app-production-A" })).text!;
      const b = (await read({ sessionUuid: "app-production-B" })).text!;
      const empty = (await read()).text!;
      expect(a).toContain('viewBox="0 0 1080 2400"');
      expect(a).not.toContain("Reminders");
      expect(b).toContain('viewBox="0 0 393 852"');
      expect(b).toContain("Reminders");
      expect(empty).toContain("No session-bound observation is available");
      expect(empty).not.toContain('class="am-box"');
      expect(empty).not.toContain("device-A");
      expect(empty).not.toContain("device-B");
    } finally {
      setObserveCacheStore(previousCache);
      setScreenshotStateStore(previousScreenshots);
      unregisterDirectSession("app-production-A");
      unregisterDirectSession("app-production-B");
      ResourceRegistry.clearResources();
    }
  });

  test("embeds exact capture bytes, protects that path before reading, and exposes its lease", async () => {
    const harness = makeHarness();
    harness.fileSystem.readFile = async (path) => {
      expect(harness.protectedPaths).toEqual([path]);
      return jpeg; // Byte MIME wins even if a capture path ends in .png.
    };
    harness.store.updateForObservation("device-A", "obs-A", "A.png");
    const html = await harness.read(contextA);
    expect(html).toContain(`data:image/jpeg;base64,${jpeg.toString("base64")}`);
    expect(html).toContain('data-screenshot="present"');
    expect(html).toContain('data-device-id="device-A"');
    expect(html).toContain('data-observation-id="obs-A"');
    expect(html).toContain('data-expires-at="600000"');
    expect(html).toContain('viewBox="0 0 1080 2400"');
  });

  test("two sessions see only their device's hierarchy and screenshot even when B observed last", async () => {
    const { read, reads } = makeHarness();
    const a = await read(contextA);
    const b = await read({ sessionUuid: "session-B", ownsSession: (uuid) => uuid === "session-B" });
    expect(a).toContain('viewBox="0 0 1080 2400"');
    expect(a).toContain(jpeg.toString("base64"));
    expect(a).not.toContain("device-B");
    expect(a).not.toContain("obs-B");
    expect(a).not.toContain(png.toString("base64"));
    expect(a).not.toContain("Reminders");
    expect(b).toContain('viewBox="0 0 393 852"');
    expect(b).toContain("Reminders");
    expect(b).toContain(png.toString("base64"));
    expect(b).not.toContain("device-A");
    expect(b).not.toContain("obs-A");
    expect(b).not.toContain(jpeg.toString("base64"));
    expect(reads).toEqual(["A.jpg", "B.png"]);
  });

  test.each([
    ["sessionless", {}],
    ["inactive", { sessionUuid: "released" }],
    [
      "unauthorized",
      { sessionUuid: "session-B", ownsSession: (uuid: string) => uuid === "session-A" },
    ],
  ] satisfies [string, ResourceReadContext][])(
    "%s read is empty with no device data",
    async (_name, context) => {
      const { read, reads } = makeHarness();
      const html = await read(context);
      expect(html).toContain('data-observe-app="empty"');
      expect(html).toContain("No session-bound observation is available");
      expect(html).not.toContain("<image");
      expect(html).not.toContain('class="am-box"');
      expect(html).not.toContain("device-A");
      expect(html).not.toContain("device-B");
      expect(reads).toEqual([]);
    },
  );

  test.each([
    "gone",
    "unreadable",
    "pending",
    "not captured",
    "superseded before read",
    "superseded during read",
  ])("%s screenshot is visibly omitted and never replaced by another capture", async (scenario) => {
    const harness = makeHarness();
    // A different capture is available for the same device; it must never be selected.
    harness.store.updateForObservation("device-A", "other-observation", "B.png");
    if (scenario === "gone") {
      harness.files.delete("A.jpg");
    }
    if (scenario === "unreadable") {
      harness.fileSystem.readFile = async () => {
        throw Object.assign(new Error("unreadable"), { code: "EACCES" });
      };
    }
    if (scenario === "pending") {
      harness.store.beginObservation("device-A", "obs-A");
    }
    if (scenario === "not captured") {
      harness.store.clear("device-A");
      harness.store.updateForObservation("device-A", "other-observation", "B.png");
    }
    if (scenario === "superseded before read") {
      let lookups = 0;
      harness.dependencies.getCachedResult = (id) =>
        ++lookups === 1 ? observeA : { ...observeA, observationId: "other-observation" };
    }
    if (scenario === "superseded during read") {
      harness.fileSystem.readFile = async () => {
        harness.observations.set("device-A", { ...observeA, observationId: "other-observation" });
        return jpeg;
      };
    }
    const html = await harness.read(contextA);
    expect(html).not.toContain("<image");
    expect(html).toContain('data-screenshot="omitted"');
    expect(html).toContain('<p class="am-note">Screenshot for this capture');
    expect(html).not.toContain("data-expires-at");
    expect(html).not.toContain(png.toString("base64"));
    expect(html).toContain('data-observation-id="obs-A"');
    expect(html).toContain('viewBox="0 0 1080 2400"');
    expect(harness.reads).not.toContain("B.png");
  });

  test("a session released while reading the image cannot leak the earlier hierarchy", async () => {
    const harness = makeHarness();
    harness.fileSystem.readFile = async () => {
      harness.dependencies.resolveActiveSession = () => undefined;
      return jpeg;
    };
    const html = await harness.read(contextA);
    expect(html).toContain("No session-bound observation is available");
    expect(html).not.toContain("device-A");
    expect(html).not.toContain("<image");
  });

  test("escapes capture identity and omission text and rejects active or external image sources", () => {
    const observe = { ...observeA, deviceId: 'A"<script>', observationId: 'obs&"' };
    const html = renderObserveAppHtml({
      observe,
      screenshot: { omittedReason: '<script src="https://example.com">' },
    });
    expect(html).toContain('data-device-id="A&quot;&lt;script&gt;"');
    expect(html).toContain('data-observation-id="obs&amp;&quot;"');
    expect(html).toContain("&lt;script src=&quot;");
    expect(html).not.toContain("<script");
    for (const dataUri of [
      "https://example.com/image.png",
      "data:image/svg+xml;base64,QUJD",
      "data:text/html;base64,QUJD",
    ]) {
      expect(renderObserveAppHtml({ observe, screenshot: { dataUri, expiresAt } })).not.toContain(
        "<image",
      );
    }
  });
});
