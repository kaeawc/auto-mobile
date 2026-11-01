import { isolateToolRegistry } from "../helpers/withTemporaryTool";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { BootedDevice, PlanStep, VideoRecordingMetadata } from "../../src/models";
import { DefaultAfterToolCallHandler, ToolRegistry } from "../../src/server/toolRegistry";
import { registerPlanTools } from "../../src/server/planTools";
import { createVideoStopResponse } from "../../src/server/videoRecordingTools";
import { stopResultEntry } from "../../src/server/videoRecordingStopById";
import {
  resetStoppedDeviceGestureRecordings,
  startDeviceGestureRecording,
  stopDeviceGestureRecording,
} from "../../src/daemon/deviceGestureRecordingManager";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";
import { createStructuredToolResponse } from "../../src/utils/toolUtils";
import { serverConfig } from "../../src/utils/ServerConfig";
import { createVideoRecordingToolsHarness } from "../helpers/videoRecordingToolsHarness";
import { readToolResponse, toolStructured, toolText } from "../helpers/toolResponse";
import { FakeArtifactWriter } from "../fakes/FakeArtifactWriter";
import { FakeTimer } from "../fakes/FakeTimer";

isolateToolRegistry();

const device: BootedDevice = { deviceId: "emulator-5554", name: "Pixel", platform: "android" };
const step: PlanStep = { tool: "tapOn", params: { text: "OK" } };

const links = (response: unknown) =>
  readToolResponse(response).content.filter((part) => part.type === "resource_link");

/** The handler's envelope rebuilt from its own structured payload: proof nothing reshaped it. */
const asHandlerBuiltIt = (response: unknown) =>
  JSON.stringify(createStructuredToolResponse(toolStructured(response)));

/** Parse arguments through the tool's advertised input schema, as the wire does. */
const wireArgs = (name: string, args: Record<string, unknown>) =>
  ToolRegistry.getTool(name)!.schema.parse(args);

/**
 * The `resourceLink` opt-in on exportPlan and on the videoRecording stop result (#13942):
 * default responses stay inline and unchanged; `resourceLink: true` spills the result to a
 * tool-output artifact and adds a resource_link block.
 */
describe("exportPlan resourceLink opt-in (#13942)", () => {
  const timer = new FakeTimer();
  let writer: FakeArtifactWriter;
  let restorePipeline: () => void;
  let previousOutputsDir: string | undefined;

  beforeAll(() => {
    if (!ToolRegistry.getTool("exportPlan")) {
      registerPlanTools();
    }
  });

  beforeEach(async () => {
    previousOutputsDir = serverConfig.getToolOutputsDir();
    serverConfig.setToolOutputsDir(undefined);
    writer = new FakeArtifactWriter();
    restorePipeline = ToolRegistry.setPipelineOverridesForTesting({
      plainToolFinalizer: new DefaultAfterToolCallHandler(() => writer),
    });
    await startDeviceGestureRecording(device, timer, new CountingIdGenerator("rl"), {
      recorderFactory: () => ({
        stepCount: 1,
        start: async () => undefined,
        stop: async () => ({ steps: [step], stepCount: 1 }),
      }),
    });
  });

  afterEach(async () => {
    restorePipeline();
    serverConfig.setToolOutputsDir(previousOutputsDir);
    await stopDeviceGestureRecording(undefined, undefined, timer).catch(() => undefined);
    resetStoppedDeviceGestureRecordings();
  });

  const exportPlan = (args: Record<string, unknown>) =>
    ToolRegistry.getTool("exportPlan")!.handler(wireArgs("exportPlan", args));

  test("by default the plan stays inline and the envelope is unchanged", async () => {
    const response = await exportPlan({ planName: "inline-plan" });

    expect(toolStructured(response)).toMatchObject({ success: true, stepCount: 1 });
    expect(toolText(response)).toContain("name: inline-plan");
    expect(JSON.stringify(response)).toBe(asHandlerBuiltIt(response));
    expect(writer.writes).toHaveLength(0);
    expect(links(response)).toHaveLength(0);
  });

  test("resourceLink: true spills the plan and links it", async () => {
    const response = await exportPlan({ planName: "linked-plan", resourceLink: true });

    expect(writer.writes.map((write) => write.tool)).toEqual(["exportPlan"]);
    expect(toolStructured(response)).toMatchObject({
      success: true,
      artifact: { resourceUri: "automobile:tool-output/exportPlan-1.json" },
    });
    expect(toolText(response)).not.toContain("name: linked-plan");
    expect(links(response)).toEqual([
      expect.objectContaining({ uri: "automobile:tool-output/exportPlan-1.json" }),
    ]);
  });
});

describe("videoRecording stop resourceLink opt-in (#13942)", () => {
  const videoRecording = createVideoRecordingToolsHarness();
  let writer: FakeArtifactWriter;
  let previousOutputsDir: string | undefined;

  const metadata: VideoRecordingMetadata = {
    recordingId: "rec-1",
    fileName: "rec-1.mp4",
    filePath: "/tmp/auto-mobile/videos/rec-1.mp4",
    format: "mp4",
    sizeBytes: 2048,
    durationMs: 5000,
    codec: "h264",
    createdAt: "2026-01-01T00:00:00.000Z",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:00:05.000Z",
    lastAccessedAt: "2026-01-01T00:00:05.000Z",
    config: {
      qualityPreset: "medium",
      targetBitrateKbps: 4000,
      maxThroughputMbps: 10,
      fps: 30,
      maxArchiveSizeMb: 100,
      format: "mp4",
    },
  };

  const manifestPath = "/tmp/auto-mobile/videos/rec-1/manifest.json";
  const stopResponse = () =>
    createVideoStopResponse({
      results: [stopResultEntry(metadata, device)],
      failures: [],
      evictedRecordingIds: [],
      manifestPaths: [manifestPath],
      highlights: [],
      stoppedAnySegmented: false,
      skipped: [],
    });

  const stop = async (args: Record<string, unknown>) => {
    const response = stopResponse();
    const result = await new DefaultAfterToolCallHandler(() => writer).handle({
      name: "videoRecording",
      outputSchema: ToolRegistry.getToolOutputSchema("videoRecording"),
      args: wireArgs("videoRecording", { action: "stop", recordingId: "rec-1", ...args }),
      device: undefined,
      internalCall: false,
      response,
      sessionUuid: undefined,
      shouldResolveDevice: false,
      timer: new FakeTimer(),
      toolStartMs: 0,
    });
    return result.finalizedResponse as unknown;
  };

  beforeAll(() => videoRecording.register());

  beforeEach(() => {
    previousOutputsDir = serverConfig.getToolOutputsDir();
    serverConfig.setToolOutputsDir(undefined);
    writer = new FakeArtifactWriter();
  });

  afterEach(() => {
    serverConfig.setToolOutputsDir(previousOutputsDir);
  });

  test("by default the stop result stays inline and unchanged", async () => {
    const response = await stop({});

    expect(JSON.stringify(response)).toBe(JSON.stringify(stopResponse()));
    expect(toolText(response)).toContain(manifestPath);
    expect(writer.writes).toHaveLength(0);
    expect(links(response)).toHaveLength(0);
  });

  test("resourceLink: true spills the stop result and links it", async () => {
    const response = await stop({ resourceLink: true });

    expect(writer.writes.map((write) => write.tool)).toEqual(["videoRecording"]);
    // The output schema's required headline fields stay inline (each bounded); the rest moves.
    expect(toolStructured(response)).toMatchObject({
      action: "stop",
      count: 1,
      recordings: [expect.objectContaining({ recordingId: "rec-1" })],
      artifact: { resourceUri: "automobile:tool-output/videoRecording-1.json" },
    });
    expect(toolText(response)).not.toContain(manifestPath);
    expect(links(response)).toEqual([
      expect.objectContaining({ uri: "automobile:tool-output/videoRecording-1.json" }),
    ]);
  });
});
