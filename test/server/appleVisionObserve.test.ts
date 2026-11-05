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
