import { describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { promises as fsPromises } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { registerVideoRecordingTools } from "../../src/server/videoRecordingTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { resetVideoRecordingManagerDependencies } from "../../src/server/videoRecordingManager";
import { serverConfig } from "../../src/utils/ServerConfig";
import { defaultTimer } from "../../src/utils/SystemTimer";

const execFileAsync = promisify(execFile);
const RUN_INTEGRATION = process.env.AUTOMOBILE_IOS_VIDEO_RECORDING_INTEGRATION === "1";
const describeIntegration = RUN_INTEGRATION ? describe : describe.skip;
// Give a cold CI simulator enough time to render frames after the script's
// screenshot readiness check, rather than stopping immediately after startup.
const DEFAULT_WAIT_MS = 10000;
const DEFAULT_TEST_TIMEOUT_MS = 420000;

interface ToolTextResponse {
  content?: Array<{ type?: string; text?: string }>;
}

interface RecordingToolResult {
  action: "start" | "stop";
  count: number;
  recordings: Array<{
    recordingId: string;
    outputPath?: string;
    filePath?: string;
    sizeBytes?: number;
    metadata?: {
      filePath?: string;
      sizeBytes?: number;
    };
  }>;
  failures?: Array<Record<string, unknown>>;
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  duration?: string;
}

function parseToolResult(response: ToolTextResponse): RecordingToolResult {
  const text = response.content?.find((item) => item.type === "text")?.text;
  if (!text) {
    throw new Error(`Tool response did not contain text JSON: ${JSON.stringify(response)}`);
  }
  return JSON.parse(text) as RecordingToolResult;
}

function getWaitMs(): number {
  const parsed = Number(process.env.AUTOMOBILE_IOS_VIDEO_RECORDING_WAIT_MS);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_WAIT_MS;
  }
  return Math.max(1000, Math.round(parsed));
}

function getTestTimeoutMs(): number {
  const parsed = Number(process.env.AUTOMOBILE_IOS_VIDEO_RECORDING_TEST_TIMEOUT_MS);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_TEST_TIMEOUT_MS;
  }
  return Math.max(60000, Math.round(parsed));
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}

async function assertCommandAvailable(command: string, args: string[]): Promise<void> {
  try {
    await execFileAsync(command, args);
  } catch (error) {
    throw new Error(`${command} is required for this integration test: ${formatError(error)}`);
  }
}

async function assertPlayableMp4(filePath: string): Promise<FfprobeStream> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=codec_type,codec_name,width,height,duration",
    "-of",
    "json",
    filePath,
  ]);
  const parsed = JSON.parse(stdout) as { streams?: FfprobeStream[] };
  const stream = parsed.streams?.find((candidate) => candidate.codec_type === "video");
  if (!stream) {
    throw new Error(`ffprobe did not find a video stream in ${filePath}: ${stdout}`);
  }
  return stream;
}

describeIntegration("iOS videoRecording start-stop integration", () => {
  test(
    "finalizes a non-empty playable MP4 from a real simulator recording",
    async () => {
      await assertCommandAvailable("xcrun", ["simctl", "help"]);
      await assertCommandAvailable("ffmpeg", ["-version"]);
      await assertCommandAvailable("ffprobe", ["-version"]);

      if (!ToolRegistry.getTool("videoRecording")) {
        registerVideoRecordingTools();
      }

      serverConfig.setSkipCtrlProxyDownload(true);
      const tool = ToolRegistry.getTool("videoRecording");
      expect(tool).toBeDefined();

      let recordingId: string | undefined;
      let startPayload: RecordingToolResult | undefined;
      let stopPayload: RecordingToolResult | undefined;
      let outputPath: string | undefined;
      let stopped = false;

      try {
        const deviceId = process.env.AUTOMOBILE_IOS_VIDEO_RECORDING_DEVICE_ID;
        startPayload = parseToolResult(
          (await tool!.handler({
            action: "start",
            platform: "ios",
            ...(deviceId ? { deviceId } : {}),
            outputName: "issue-2628-ios-video-recording",
            qualityPreset: "low",
            fps: 15,
            maxDuration: 30,
          })) as ToolTextResponse,
        );

        expect(startPayload.action).toBe("start");
        expect(startPayload.count).toBe(1);
        expect(startPayload.failures).toBeUndefined();

        const started = startPayload.recordings[0];
        expect(started).toBeDefined();
        recordingId = started.recordingId;
        outputPath = started.outputPath;
        expect(recordingId).toBeString();
        expect(outputPath).toBeString();

        await defaultTimer.sleep(getWaitMs());

        stopPayload = parseToolResult(
          (await tool!.handler({
            action: "stop",
            platform: "ios",
            recordingId,
          })) as ToolTextResponse,
        );
        stopped = true;

        expect(stopPayload.action).toBe("stop");
        expect(stopPayload.count).toBe(1);
        expect(stopPayload.failures).toBeUndefined();

        const stoppedRecording = stopPayload.recordings[0];
        const mp4Path = stoppedRecording.filePath ?? stoppedRecording.metadata?.filePath;
        expect(mp4Path).toBeString();

        const stats = await fsPromises.stat(mp4Path!);
        expect(stats.size).toBeGreaterThan(0);
        expect(stoppedRecording.sizeBytes ?? stoppedRecording.metadata?.sizeBytes).toBeGreaterThan(
          0,
        );

        const videoStream = await assertPlayableMp4(mp4Path!);
        expect(videoStream.codec_type).toBe("video");
      } catch (error) {
        let cleanupError: string | undefined;
        if (recordingId && !stopped) {
          try {
            await tool!.handler({
              action: "stop",
              platform: "ios",
              recordingId,
            });
          } catch (stopError) {
            cleanupError = formatError(stopError);
          }
        }

        const rawMovPath =
          recordingId && outputPath
            ? path.join(path.dirname(outputPath), `${recordingId}-raw.mov`)
            : undefined;
        throw new Error(
          [
            "iOS videoRecording start-stop integration failed.",
            `error: ${formatError(error)}`,
            `recordingId: ${recordingId ?? "(none)"}`,
            `rawMovPath: ${rawMovPath ?? "(unknown)"}`,
            `finalMp4Path: ${outputPath ?? "(unknown)"}`,
            `startPayload: ${JSON.stringify(startPayload ?? null, null, 2)}`,
            `stopPayload: ${JSON.stringify(stopPayload ?? null, null, 2)}`,
            cleanupError ? `cleanupStopError: ${cleanupError}` : undefined,
          ]
            .filter((line): line is string => Boolean(line))
            .join("\n"),
        );
      } finally {
        serverConfig.setSkipCtrlProxyDownload(false);
        resetVideoRecordingManagerDependencies();
      }
    },
    getTestTimeoutMs(),
  );
});
