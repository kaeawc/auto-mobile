import { readToolResponse } from "../helpers/toolResponse";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { registerObserveTools } from "../../src/server/observeTools";
import {
  registerDirectSessionDevice,
  unregisterDirectSession,
} from "../../src/utils/directSessionDeviceRegistry";
import { FakeDeviceReadiness } from "../fakes/FakeDeviceReadiness";
import { FakeDisplayInventoryProvider } from "../fakes/FakeDisplayInventoryProvider";
import { isolateEmptyToolRegistry } from "../helpers/withTemporaryTool";
isolateEmptyToolRegistry();
import { expect, test } from "bun:test";
import { observeWatch, type WatchScreenshotSource } from "../../src/server/observeWatch";
import { visionosRunners } from "../../src/features/visionos/VisionosRunnerRegistry";
import {
  FakeVisionosRunnerClient,
  visionosProbeHierarchy,
} from "../fakes/FakeVisionosRunnerClient";
import probe from "../fixtures/visionos-xcuitest/probe-capture.json";
import { FakeTimer } from "../fakes/FakeTimer";
import { CountingIdGenerator } from "../../src/utils/CountingIdGenerator";
import { FakeScreenshotFileWriter } from "../fakes/FakeScreenshotFileWriter";
import { FakeScreenshotPathProtection } from "../fakes/FakeScreenshotPathProtection";
import { getStructuredPayload } from "../../src/utils/toolUtils";
import type { ObserveResult } from "../../src/models";
import { observeToolResultSchema } from "../../src/server/toolOutputSchemas";

const device = { platform: "visionos", deviceId: "vision-observe", name: "Vision Pro" } as const;
class FakeVisionScreenshots implements WatchScreenshotSource {
  calls: Array<{ deviceId: string; display?: string }> = [];
  async capture(target: typeof device, display?: string) {
    this.calls.push({ deviceId: target.deviceId, display });
    const png = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
    png.writeUInt32BE(13, 8);
    png.write("IHDR", 12, "ascii");
    png.writeUInt32BE(3840, 16);
    png.writeUInt32BE(2160, 20);
    return png;
  }
}

test("visionOS observe returns captured hierarchy, focused field and a retained simctl-source screenshot", async () => {
  const client = new FakeVisionosRunnerClient(visionosProbeHierarchy(probe.snapshotAfterImmersive));
  const unregister = visionosRunners.register(device.deviceId, client);
  const timer = new FakeTimer();
  const screenshots = new FakeVisionScreenshots();
  const fileWriter = new FakeScreenshotFileWriter();
  try {
    const response = await observeWatch(device, { project: "full" }, undefined, {
      screenshots,
      fileWriter,
      timer,
      pathProtection: new FakeScreenshotPathProtection(timer),
      idGenerator: new CountingIdGenerator("vision-observe"),
      cacheDir: () => "/cache/screenshots",
    });
    const result = getStructuredPayload<ObserveResult>(readToolResponse(response))!;
    expect(result.focusedElement).toMatchObject({ "resource-id": "field", focused: true });
    expect(result.viewHierarchy?.packageName).toBe("dev.automobile.probe.app");
    expect(result.screenshotImageSize).toEqual({ width: 3840, height: 2160 });
    expect(fileWriter.written).toEqual([result.screenshotPath!]);
    expect(screenshots.calls).toEqual([{ deviceId: device.deviceId, display: undefined }]);
    expect(client.commands).toEqual([{ type: "request_hierarchy" }]);
    expect(timer.getSleepHistory()).toEqual([]);
    expect(observeToolResultSchema.safeParse(result).success).toBe(true);
  } finally {
    unregister();
  }
});

test("visionOS observe refuses unsupported options before hierarchy or capture", async () => {
  const client = new FakeVisionosRunnerClient();
  const unregister = visionosRunners.register(device.deviceId, client);
  const screenshots = new FakeVisionScreenshots();
  try {
    await expect(observeWatch(device, { raw: true }, undefined, { screenshots })).rejects.toThrow(
      "visionOS runner",
    );
    expect(client.commands).toEqual([]);
    expect(screenshots.calls).toEqual([]);
  } finally {
    unregister();
  }
});

test("the registered observe tool routes a visionOS session into the Apple window pipeline", async () => {
  const session = "vision-observe-session";
  const client = new FakeVisionosRunnerClient(visionosProbeHierarchy(probe.snapshotAfterImmersive));
  const unregister = visionosRunners.register(device.deviceId, client);
  const screenshots = new FakeVisionScreenshots();
  const timer = new FakeTimer();
  const readiness = new FakeDeviceReadiness();
  readiness.setConnectedDevices([device]);
  const previous = ToolRegistry.getCollaboratorsForTesting();
  ToolRegistry.setCollaboratorsForTesting({
    deviceReadiness: readiness,
    toolCallRepository: { async recordToolCall() {} },
  });
  const restore = ToolRegistry.setPipelineOverridesForTesting({
    displayInventory: new FakeDisplayInventoryProvider(),
  });
  registerDirectSessionDevice(session, device);
  registerObserveTools({
    timer,
    createScreen: () => {
      throw new Error("Android/iOS observe path ran");
    },
    watch: {
      screenshots,
      timer,
      fileWriter: new FakeScreenshotFileWriter(),
      pathProtection: new FakeScreenshotPathProtection(timer),
      cacheDir: () => "/cache/screenshots",
    },
  });
  try {
    const response = await ToolRegistry.getTool("observe")!.handler({
      sessionUuid: session,
      project: "full",
    });
    const result = getStructuredPayload<ObserveResult>(readToolResponse(response))!;
    expect(result.focusedElement).toMatchObject({ "resource-id": "field", focused: true });
    expect(screenshots.calls).toHaveLength(1);
  } finally {
    unregister();
    unregisterDirectSession(session);
    restore();
    ToolRegistry.setCollaboratorsForTesting(previous);
  }
});

function visionDependencies(
  screenshots: FakeVisionScreenshots,
  visionosRunner: (deviceId: string, signal?: AbortSignal) => Promise<FakeVisionosRunnerClient>,
) {
  const timer = new FakeTimer();
  const fileWriter = new FakeScreenshotFileWriter();
  return {
    fileWriter,
    dependencies: {
      screenshots,
      fileWriter,
      timer,
      visionosRunner,
      pathProtection: new FakeScreenshotPathProtection(timer),
      idGenerator: new CountingIdGenerator("vision-fallback"),
      cacheDir: () => "/cache/screenshots",
    },
  };
}

test("visionOS observe uses an available runner's hierarchy", async () => {
  const client = new FakeVisionosRunnerClient(visionosProbeHierarchy(probe.snapshotAfterImmersive));
  const screenshots = new FakeVisionScreenshots();
  const started: string[] = [];
  const { dependencies } = visionDependencies(screenshots, async (deviceId) => {
    started.push(deviceId);
    return client;
  });
  const response = await observeWatch(device, {}, undefined, dependencies);
  const result = getStructuredPayload<ObserveResult & { hierarchyUnavailable?: unknown }>(
    readToolResponse(response),
  )!;
  expect(started).toEqual([device.deviceId]);
  expect(result.hierarchyUnavailable).toBeUndefined();
  expect(result.focusedElement).toMatchObject({ "resource-id": "field", focused: true });
  expect(client.commands).toEqual([{ type: "request_hierarchy" }]);
});

test.each([
  [
    "cannot be started",
    async (): Promise<FakeVisionosRunnerClient> => {
      throw new Error("visionOS window-app runner unavailable: no xctestrun");
    },
    "no xctestrun",
  ],
  [
    "cannot be reached",
    async (): Promise<FakeVisionosRunnerClient> => {
      const client = new FakeVisionosRunnerClient();
      client.failure = new Error("runner socket closed");
      return client;
    },
    "runner socket closed",
  ],
])(
  "visionOS observe falls back to a screenshot when the runner %s",
  async (_case, startRunner, reason) => {
    const screenshots = new FakeVisionScreenshots();
    const { dependencies, fileWriter } = visionDependencies(screenshots, startRunner);
    const response = await observeWatch(device, {}, undefined, dependencies);
    const result = getStructuredPayload<{
      screenshotPath: string;
      viewHierarchy?: unknown;
      hierarchyUnavailable: { platform: string; message: string };
    }>(readToolResponse(response))!;
    expect(result.viewHierarchy).toBeUndefined();
    expect(result.hierarchyUnavailable.platform).toBe("visionos");
    expect(result.hierarchyUnavailable.message).toContain("The view hierarchy needs the runner.");
    expect(result.hierarchyUnavailable.message).toContain(reason);
    expect(fileWriter.written).toEqual([result.screenshotPath]);
    expect(screenshots.calls).toEqual([{ deviceId: device.deviceId, display: undefined }]);
    expect(observeToolResultSchema.safeParse(result).success).toBe(true);
  },
);

test("visionOS observe refuses project without a runner instead of dropping the hierarchy", async () => {
  const screenshots = new FakeVisionScreenshots();
  const { dependencies } = visionDependencies(screenshots, async () => {
    throw new Error("no runner");
  });
  await expect(observeWatch(device, { project: "full" }, undefined, dependencies)).rejects.toThrow(
    "returns only a screenshot",
  );
  expect(screenshots.calls).toEqual([]);
});

test("visionOS observe propagates cancellation during runner startup without capturing", async () => {
  const controller = new AbortController();
  const screenshots = new FakeVisionScreenshots();
  let startupBegan!: () => void;
  const began = new Promise<void>((resolve) => (startupBegan = resolve));
  const { dependencies } = visionDependencies(
    screenshots,
    (_deviceId, signal) =>
      new Promise<FakeVisionosRunnerClient>((_resolve, reject) => {
        // Startup only ends through the signal observeWatch forwards.
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        startupBegan();
      }),
  );
  const observed = observeWatch(device, {}, controller.signal, dependencies);
  await began;
  controller.abort(new Error("cancelled"));
  await expect(observed).rejects.toThrow("cancelled");
  expect(screenshots.calls).toEqual([]);
});

test("a read of a held visionOS device never starts a runner, but reuses a connected one", async () => {
  const screenshots = new FakeVisionScreenshots();
  const { dependencies } = visionDependencies(screenshots, async () => {
    throw new Error("runner startup must not run");
  });
  // Drop the injected startup so the held-device default selects connect-only.
  const heldDependencies = {
    ...dependencies,
    visionosRunner: undefined,
    heldDeviceRead: () => true,
  };

  const response = await observeWatch(device, {}, undefined, heldDependencies);
  const result = getStructuredPayload<{ hierarchyUnavailable?: { platform: string } }>(
    readToolResponse(response),
  )!;
  expect(result.hierarchyUnavailable?.platform).toBe("visionos");
  expect(screenshots.calls).toHaveLength(1);

  const client = new FakeVisionosRunnerClient(visionosProbeHierarchy(probe.snapshotAfterImmersive));
  const unregister = visionosRunners.register(device.deviceId, client);
  try {
    const connected = getStructuredPayload<ObserveResult>(
      readToolResponse(await observeWatch(device, {}, undefined, heldDependencies)),
    )!;
    expect(connected.focusedElement).toMatchObject({ "resource-id": "field", focused: true });
  } finally {
    unregister();
  }
});
