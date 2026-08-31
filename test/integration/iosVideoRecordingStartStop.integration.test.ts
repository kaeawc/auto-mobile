import { describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { promises as fsPromises } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
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
  nb_read_frames?: string;
}

interface FfprobeResult {
  streams?: FfprobeStream[];
  format?: { duration?: string };
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

async function runVideoRecordingCli(args: string[]): Promise<RecordingToolResult> {
  // The workflow warms CtrlProxy in the daemon process before this test runs.
  // Calling the public CLI keeps start and stop in that same process; importing
  // the tool handler here would create a second cold DeviceSessionManager and
  // reintroduce the runner-readiness timeout this test is meant to exercise.
  const { stdout } = await execFileAsync("auto-mobile", ["--cli", "videoRecording", ...args], {
    maxBuffer: 10 * 1024 * 1024,
  });
  return parseToolResult(JSON.parse(stdout) as ToolTextResponse);
}

async function assertCommandAvailable(command: string, args: string[]): Promise<void> {
  try {
    await execFileAsync(command, args);
  } catch (error) {
    throw new Error(`${command} is required for this integration test: ${formatError(error)}`);
  }
}

async function assertPlayableMp4(
  filePath: string,
): Promise<{ stream: FfprobeStream; duration: number; frames: number }> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v",
    "error",
    "-count_frames",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=codec_type,codec_name,width,height,duration,nb_read_frames:format=duration",
    "-of",
    "json",
    filePath,
  ]);
  const parsed = JSON.parse(stdout) as FfprobeResult;
  const stream = parsed.streams?.find((candidate) => candidate.codec_type === "video");
  if (!stream) {
    throw new Error(`ffprobe did not find a video stream in ${filePath}: ${stdout}`);
  }
  const duration = Number.parseFloat(parsed.format?.duration ?? "NaN");
  const frames = Number.parseInt(stream.nb_read_frames ?? "0", 10);
  if (!Number.isFinite(duration) || duration <= 0 || frames <= 1) {
    throw new Error(
      `ffprobe expected a multi-frame recording with positive duration: ${JSON.stringify(parsed)}`,
    );
  }
  return { stream, duration, frames };
}

describeIntegration("iOS videoRecording start-stop integration", () => {
  test(
    "finalizes a non-empty playable MP4 from a real simulator recording",
    async () => {
      await assertCommandAvailable("xcrun", ["simctl", "help"]);
      await assertCommandAvailable("ffmpeg", ["-version"]);
      await assertCommandAvailable("ffprobe", ["-version"]);

      let recordingId: string | undefined;
      let startPayload: RecordingToolResult | undefined;
      let stopPayload: RecordingToolResult | undefined;
      let outputPath: string | undefined;
      let stopped = false;

      try {
        const deviceId = process.env.AUTOMOBILE_IOS_VIDEO_RECORDING_DEVICE_ID;
        if (!deviceId) {
          throw new Error("AUTOMOBILE_IOS_VIDEO_RECORDING_DEVICE_ID is required");
        }
        startPayload = await runVideoRecordingCli([
          "--action",
          "start",
          "--platform",
          "ios",
          ...(deviceId ? ["--deviceId", deviceId] : []),
          "--outputName",
          "issue-2628-ios-video-recording",
          "--qualityPreset",
          "low",
          "--fps",
          "15",
          "--maxDuration",
          "30",
        ]);

        expect(startPayload.action).toBe("start");
        expect(startPayload.count).toBe(1);
        expect(startPayload.failures).toBeUndefined();

        const started = startPayload.recordings[0];
        expect(started).toBeDefined();
        recordingId = started.recordingId;
        outputPath = started.outputPath;
        expect(recordingId).toBeString();
        expect(outputPath).toBeString();

        const waitMs = getWaitMs();
        const firstWaitMs = Math.floor(waitMs / 2);
        // Simulator recordings may contain one frame when the display remains static. Force a
        // full compositor redraw so the multi-frame assertion measures capture, not UI idleness.
        // Device readiness sets light mode before recording, making this first transition real.
        await execFileAsync("xcrun", ["simctl", "ui", deviceId, "appearance", "dark"]);
        try {
          await defaultTimer.sleep(firstWaitMs);
        } finally {
          await execFileAsync("xcrun", ["simctl", "ui", deviceId, "appearance", "light"]);
        }
        await defaultTimer.sleep(waitMs - firstWaitMs);

        stopPayload = await runVideoRecordingCli([
          "--action",
          "stop",
          "--platform",
          "ios",
          "--recordingId",
          recordingId,
        ]);
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

        const video = await assertPlayableMp4(mp4Path!);
        expect(video.stream.codec_type).toBe("video");
        expect(video.duration).toBeGreaterThan(0);
        expect(video.frames).toBeGreaterThan(1);
      } catch (error) {
        let cleanupError: string | undefined;
        if (recordingId && !stopped) {
          try {
            await runVideoRecordingCli([
              "--action",
              "stop",
              "--platform",
              "ios",
              "--recordingId",
              recordingId,
            ]);
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
      }
    },
    getTestTimeoutMs(),
  );
});
