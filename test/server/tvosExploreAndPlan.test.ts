import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Explore } from "../../src/features/navigation/Explore";
import type { BootedDevice, PlanExecutionResult, VideoRecordingMetadata } from "../../src/models";
import {
  APPLE_PLATFORM_SUPPORTED_TOOLS,
  assertToolSupportsDevicePlatform,
} from "../../src/server/applePlatformToolSupport";
import { exploreResultSchema } from "../../src/server/navigationToolOutputSchemas";
import { registerNavigationTools } from "../../src/server/navigationTools";
import {
  PlanExecutionOrchestrator,
  type VideoRecorder,
} from "../../src/server/planExecutionOrchestrator";
import * as planUtils from "../../src/server/planExecutorFactory";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { FakeNavigationGraphManager } from "../fakes/FakeNavigationGraphManager";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeTvosExploreApp } from "../fakes/FakeTvosExploreApp";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";
import { toolJson } from "../helpers/toolResponse";

isolateToolRegistry();

const tvRecording: VideoRecordingMetadata = {
  recordingId: "tv-rec",
  filePath: "/fake/tv.mp4",
  fileName: "tv.mp4",
  format: "mp4",
  sizeBytes: 1,
  createdAt: "1970-01-01T00:00:00.000Z",
  startedAt: "1970-01-01T00:00:00.000Z",
  lastAccessedAt: "1970-01-01T00:00:00.000Z",
  durationMs: 1_000,
  config: {
    qualityPreset: "medium",
    targetBitrateKbps: 1000,
    maxThroughputMbps: 1,
    fps: 30,
    maxArchiveSizeMb: 100,
    format: "mp4",
  },
};

const appleTv: BootedDevice = { platform: "tvos", deviceId: "TV-UDID", name: "Apple TV 4K" };

describe("tvOS allowlist for explore and executePlan", () => {
  test("explore, executePlan and focusNavigate accept an Apple TV", () => {
    // A replayed focusNavigate step runs the tvOS focus walk (#16722).
    for (const tool of ["explore", "executePlan", "focusNavigate"]) {
      expect(APPLE_PLATFORM_SUPPORTED_TOOLS.tvos.has(tool)).toBe(true);
      expect(() => assertToolSupportsDevicePlatform(tool, appleTv)).not.toThrow();
    }
  });
});

describe("explore on an Apple TV", () => {
  let app: FakeTvosExploreApp;
  let graph: FakeNavigationGraphManager;
  let touchExplore: ReturnType<typeof spyOn<typeof Explore.prototype, "execute">>;

  beforeEach(() => {
    app = new FakeTvosExploreApp(
      {
        home: [{ id: "movies", text: "Movies", col: 0, row: 0, opens: "movies" }],
        movies: [{ id: "play", text: "Play", col: 0, row: 0 }],
      },
      "home",
    );
    graph = new FakeNavigationGraphManager();
    touchExplore = spyOn(Explore.prototype, "execute").mockRejectedValue(
      new Error("touch explore must not run on tvOS"),
    );
    ToolRegistry.clearTools();
    registerNavigationTools({
      navigationManagerFactory: () => graph,
      tvosExploreDeviceFactory: () => app,
    });
  });
  afterEach(() => {
    touchExplore.mockRestore();
    ToolRegistry.clearTools();
  });

  const handler = () => ToolRegistry.getRegisteredTool("explore")!.deviceAwareHandler!;

  test("crawls by focus and returns a result the explore output schema accepts", async () => {
    const result = toolJson(await handler()(appleTv, { maxInteractions: 10 }));
    // FakeNavigationGraphManager exports nodes without timestamps; the crawl's own fields are checked.
    expect(exploreResultSchema.omit({ navigationGraph: true }).safeParse(result).success).toBe(
      true,
    );
    expect(result).toMatchObject({
      success: true,
      message: "Exploration completed: 3 interactions, 2 new screens discovered, 100% coverage",
      explorationPath: ["tvos-fp-home", "tvos-fp-movies", "tvos-fp-home"],
    });
    expect(app.presses).toEqual([
      "select",
      "select",
      "right",
      "down",
      "left",
      "up",
      "menu",
      "right",
      "down",
      "left",
      "up",
    ]);
    expect(touchExplore).not.toHaveBeenCalled();
  });

  test("refuses explore options a focus crawl cannot honour before pressing anything", async () => {
    await expect(handler()(appleTv, { dryRun: true })).rejects.toThrow(
      "tvOS explore supports only maxInteractions, timeoutMs and packageName; unsupported: dryRun.",
    );
    expect(app.presses).toEqual([]);
  });
});

describe("executePlan on an Apple TV", () => {
  const success: PlanExecutionResult = { success: true, executedSteps: 2, totalSteps: 2 };
  let execute: ReturnType<typeof spyOn<typeof planUtils, "executePlan">>;
  beforeEach(() => {
    execute = spyOn(planUtils, "executePlan").mockResolvedValue(success);
  });
  afterEach(() => execute.mockRestore());

  function run(device: BootedDevice, videoRecorder: VideoRecorder) {
    return new PlanExecutionOrchestrator(
      {
        device,
        request: {
          platform: device.platform,
          planContent:
            "name: tv\nsteps:\n  - tool: pressButton\n    params: { button: down }\n  - tool: tapOn\n    params: { action: tap, selector: { text: Play } }\n",
          startStep: 0,
          deviceAllocationTimeoutMs: 5000,
        },
      },
      {
        timer: new FakeTimer(),
        videoRecorder,
        createSchemaValidator: () => ({
          loadSchema: async () => undefined,
          validateYaml: () => ({ valid: true }),
        }),
      },
    ).execute();
  }

  test("replays the plan on the Apple TV and records it like an iOS plan", async () => {
    const videoRecorder: VideoRecorder = {
      startVideoRecording: mock(async () => ({
        recordingId: "tv-rec",
        outputPath: tvRecording.filePath,
        fileName: tvRecording.fileName,
        startedAt: tvRecording.startedAt,
        config: tvRecording.config,
      })),
      stopVideoRecording: mock(async () => ({ metadata: tvRecording, evictedRecordingIds: [] })),
    };
    const result = await run(appleTv, videoRecorder);
    expect(result).toMatchObject({
      success: true,
      executedSteps: 2,
      platform: "tvos",
      deviceId: "TV-UDID",
      videoFilePaths: [tvRecording.filePath],
      videoRecordingIds: ["tv-rec"],
    });
    expect(videoRecorder.startVideoRecording).toHaveBeenCalledTimes(1);
    const started = (videoRecorder.startVideoRecording as ReturnType<typeof mock>).mock
      .calls[0]![0] as { device: BootedDevice; audio?: unknown };
    expect(started.device).toEqual(appleTv);
    // Apple TV recordings refuse audio, so the plan must never ask for it.
    expect(started.audio).toBeUndefined();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]![2]).toBe("tvos");
    expect(execute.mock.calls[0]![3]).toBe("TV-UDID");
  });

  test("a recording that cannot start leaves a warning and the plan still runs", async () => {
    const videoRecorder: VideoRecorder = {
      startVideoRecording: mock(async () => {
        throw new Error("simctl recordVideo failed");
      }),
      stopVideoRecording: mock(async () => {
        throw new Error("never started");
      }),
    };
    const result = await run(appleTv, videoRecorder);
    expect(result.success).toBe(true);
    expect(result.videoWarnings).toEqual([
      "Failed to start automatic video recording: simctl recordVideo failed",
    ]);
    expect(videoRecorder.stopVideoRecording).not.toHaveBeenCalled();
  });

  test("still refuses a plan on an Apple Watch", () => {
    const videoRecorder: VideoRecorder = {
      startVideoRecording: mock(async () => {
        throw new Error("unused");
      }),
      stopVideoRecording: mock(async () => {
        throw new Error("unused");
      }),
    };
    expect(() =>
      run({ platform: "watchos", deviceId: "WATCH", name: "Apple Watch" }, videoRecorder),
    ).toThrow("executePlan");
  });
});
