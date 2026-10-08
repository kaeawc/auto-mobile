import { describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import type { ObserveResult, SkeletonElement } from "../../src/models/ObserveResult";
import type { VideoRecordingMetadata } from "../../src/models/VideoRecording";
import { readImageHeaderDimensions } from "../../src/utils/screenshot/imageHeaderDimensions";
import {
  assertContainerDurationSpans,
  assertRecordingSpansObservation,
  awaitScreenSizeChange,
  probeContainerDurationMs,
  runCleanupSteps,
  selectErrorToThrow,
} from "./foldableRecordingSpan";

const runLane = process.env.AUTOMOBILE_FOLDABLE_LANE === "1";
const describeLane = runLane ? describe : describe.skip;
const execFileAsync = promisify(execFile);
const entrypoint = fileURLToPath(new URL("../../dist/src/index.js", import.meta.url));
const deviceId = process.env.AUTOMOBILE_FOLDABLE_DEVICE_ID ?? "emulator-5554";
const profile = process.env.AUTOMOBILE_FOLDABLE_PROFILE;
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

interface ToolResponse {
  content?: Array<{ type?: string; text?: string }>;
  isError?: boolean;
}

interface SessionResult {
  runtime?: { session?: { sessionUuid?: string } };
}

interface ActionResult {
  success?: boolean;
  error?: string;
}

interface RecordingResult {
  recordings: Array<{
    recordingId: string;
    outputPath?: string;
    metadata?: VideoRecordingMetadata;
  }>;
}

async function cli(args: string[]): Promise<ToolResponse> {
  try {
    const { stdout } = await execFileAsync(process.execPath, [entrypoint, "--cli", ...args], {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 90_000,
    });
    return JSON.parse(stdout) as ToolResponse;
  } catch (error) {
    if (error instanceof Error && "stdout" in error && typeof error.stdout === "string") {
      return JSON.parse(error.stdout) as ToolResponse;
    }
    throw error;
  }
}

const ffprobeRunner = {
  async run(args: string[]): Promise<string | undefined> {
    try {
      const { stdout } = await execFileAsync("ffprobe", args, {
        maxBuffer: 10 * 1024 * 1024,
        timeout: 30_000,
      });
      return stdout;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        console.warn("ffprobe not found; skipping container duration check");
        return undefined;
      }
      throw error;
    }
  },
};

function payload<T>(response: ToolResponse): T {
  const value = response.content?.find((item) => item.type === "text")?.text;
  if (!value) {
    throw new Error(`AutoMobile tool failed: ${JSON.stringify(response)}`);
  }
  return JSON.parse(value) as T;
}

async function tool<T>(sessionUuid: string, name: string, args: string[] = []): Promise<T> {
  const response = await cli([
    "--session-uuid",
    sessionUuid,
    name,
    "--deviceId",
    deviceId,
    ...args,
  ]);
  if (response.isError && name !== "tapAt") {
    throw new Error(`${name} failed: ${JSON.stringify(response)}`);
  }
  return payload<T>(response);
}

async function observe(sessionUuid: string): Promise<ObserveResult> {
  return tool<ObserveResult>(sessionUuid, "observe", [
    "--platform",
    "android",
    "--screenshot",
    "settled",
  ]);
}

async function expectPanel(
  sessionUuid: string,
  expected: { width: number; height: number } | undefined,
  role: "inner" | "cover" | "rear" | undefined,
  posture?: "opened" | "closed" | "rear_display",
): Promise<ObserveResult> {
  let observation: ObserveResult | undefined;
  for (let attempt = 0; attempt < 10; attempt++) {
    observation = await observe(sessionUuid);
    const sizeMatches =
      !expected ||
      (observation.screenSize.width === expected.width &&
        observation.screenSize.height === expected.height);
    const roleMatches =
      !role ||
      observation.display.role === role ||
      (role === "cover" && observation.display.role === "rear");
    if (sizeMatches && roleMatches) {
      break;
    }
    await Bun.sleep(500);
  }
  if (!observation) {
    throw new Error("No observation returned after posture transition");
  }
  if (expected) {
    expect(observation.screenSize).toMatchObject(expected);
  }
  if (role) {
    expect(role === "cover" ? ["cover", "rear"] : [role]).toContain(observation.display.role);
  }
  if (posture && observation.display.posture !== "unknown") {
    expect(observation.display.posture).toBe(posture);
  }
  expect(observation.display.key).toBeTruthy();
  expect(observation.display.generation).toBeGreaterThanOrEqual(0);
  expect(observation.screenshotFormat).toBe("png");
  expect(observation.screenshotPath).toBeTruthy();
  const bytes = await readFile(observation.screenshotPath!);
  expect(bytes.subarray(0, 8)).toEqual(pngSignature);
  expect(readImageHeaderDimensions(bytes)).toEqual({
    width: observation.screenSize.width,
    height: observation.screenSize.height,
  });
  return observation;
}

async function setPosture(
  sessionUuid: string,
  posture: "opened" | "closed" | "rear_display",
  displayPreset?: "phone" | "unfolded",
): Promise<void> {
  await tool(sessionUuid, "setPosture", [
    "--posture",
    posture,
    ...(displayPreset ? ["--displayPreset", displayPreset] : []),
  ]);
}

async function acquireSession(): Promise<string> {
  if (profile !== "pixel_10_pro_fold" && profile !== "resizable") {
    throw new Error("AUTOMOBILE_FOLDABLE_PROFILE must be pixel_10_pro_fold or resizable");
  }
  const response = await cli(["getAndroid", "--deviceId", deviceId]);
  const sessionUuid = payload<SessionResult>(response).runtime?.session?.sessionUuid;
  if (!sessionUuid) {
    throw new Error(`getAndroid did not return a daemon session UUID: ${JSON.stringify(response)}`);
  }
  return sessionUuid;
}

async function releaseSession(sessionUuid: string): Promise<void> {
  try {
    await setPosture(sessionUuid, "opened", profile === "resizable" ? "unfolded" : undefined);
  } finally {
    await execFileAsync(
      process.execPath,
      [entrypoint, "--cli", "--daemon", "release-session", sessionUuid],
      { timeout: 30_000 },
    );
  }
}

async function tapAt(sessionUuid: string, x: number, y: number): Promise<ActionResult> {
  return tool<ActionResult>(sessionUuid, "tapAt", ["--x", String(x), "--y", String(y)]);
}

function tapPoint(observation: ObserveResult): { x: number; y: number; target: SkeletonElement } {
  const target = observation.skeleton?.find(
    (item) =>
      item.affordances.includes("tap") &&
      item.bounds[2] > item.bounds[0] &&
      item.bounds[3] > item.bounds[1] &&
      item.label,
  );
  if (!target) {
    throw new Error("No labeled tappable element on the active panel");
  }
  const [left, top, right, bottom] = target.bounds;
  return { x: Math.floor((left + right) / 2), y: Math.floor((top + bottom) / 2), target };
}

async function assertStaleTap(sessionUuid: string, previous: ObserveResult): Promise<void> {
  const old = tapPoint(previous);
  const stale = await tapAt(sessionUuid, old.x, old.y);
  expect(stale.success).toBe(false);
  expect(stale.error).toContain("Display changed since these coordinates were chosen");
  expect(stale.error).toContain("Re-observe");
}

async function assertFreshTap(sessionUuid: string, current: ObserveResult): Promise<void> {
  const fresh = tapPoint(current);
  expect(fresh.x).toBeGreaterThanOrEqual(fresh.target.bounds[0]);
  expect(fresh.x).toBeLessThan(fresh.target.bounds[2]);
  expect(fresh.y).toBeGreaterThanOrEqual(fresh.target.bounds[1]);
  expect(fresh.y).toBeLessThan(fresh.target.bounds[3]);
  const result = await tapAt(sessionUuid, fresh.x, fresh.y);
  // Assert the error first so a failed tap reports why (the nightly lane only printed success).
  expect(result.error).toBeUndefined();
  expect(result.success).toBe(true);
}

describeLane("foldable posture round trips through the daemon", () => {
  test("open → closed → open; open → rear display → open on Pixel Fold", async () => {
    const sessionUuid = await acquireSession();
    const isFold = profile === "pixel_10_pro_fold";
    const inner = isFold ? { width: 2076, height: 2152 } : undefined;
    const cover = isFold ? { width: 1080, height: 2364 } : undefined;
    try {
      await setPosture(sessionUuid, "opened", isFold ? undefined : "unfolded");
      const opened = await expectPanel(sessionUuid, inner, isFold ? "inner" : undefined, "opened");
      await setPosture(sessionUuid, "closed", isFold ? undefined : "phone");
      await assertStaleTap(sessionUuid, opened);
      const closed = await expectPanel(sessionUuid, cover, isFold ? "cover" : undefined, "closed");
      if (!isFold) {
        expect(closed.screenSize).not.toEqual(opened.screenSize);
      }
      expect(closed.deviceLock?.locked).toBe(true);
      const wake = await tool<ActionResult>(sessionUuid, "wakeAndUnlock");
      expect(wake.success).toBe(true);
      const unlocked = await expectPanel(
        sessionUuid,
        cover,
        isFold ? "cover" : undefined,
        "closed",
      );
      expect(unlocked.deviceLock?.locked).toBe(false);
      await assertFreshTap(sessionUuid, unlocked);

      await setPosture(sessionUuid, "opened", isFold ? undefined : "unfolded");
      await assertStaleTap(sessionUuid, unlocked);
      const reopened = await expectPanel(
        sessionUuid,
        inner,
        isFold ? "inner" : undefined,
        "opened",
      );
      await assertFreshTap(sessionUuid, reopened);

      if (isFold) {
        await setPosture(sessionUuid, "rear_display");
        await assertStaleTap(sessionUuid, reopened);
        const rear = await expectPanel(sessionUuid, cover, "cover", "rear_display");
        await assertFreshTap(sessionUuid, rear);
        await setPosture(sessionUuid, "opened");
        await assertStaleTap(sessionUuid, rear);
        const reset = await expectPanel(sessionUuid, inner, "inner", "opened");
        await assertFreshTap(sessionUuid, reset);
      }
    } finally {
      await releaseSession(sessionUuid);
    }
  }, 600_000);

  test("recording stays on the opened panel across fold and unfold", async () => {
    const sessionUuid = await acquireSession();
    const isFold = profile === "pixel_10_pro_fold";
    const outputDirectory = join("scratch/foldable-lane/recordings", profile!);
    let recordingStarted = false;
    let recording: RecordingResult["recordings"][number] | undefined;
    let stopped: RecordingResult | undefined;
    let opened: ObserveResult | undefined;
    let closed: ObserveResult | undefined;
    let reopened: ObserveResult | undefined;
    let primary: { error: unknown } | undefined;
    try {
      await setPosture(sessionUuid, "opened", isFold ? undefined : "unfolded");
      opened = await expectPanel(sessionUuid, undefined, isFold ? "inner" : undefined, "opened");
      const started = await tool<RecordingResult>(sessionUuid, "videoRecording", [
        "--action",
        "start",
        "--platform",
        "android",
        "--display",
        isFold ? "inner" : "active",
        "--maxDuration",
        "180",
        "--outputName",
        "foldable-panel",
      ]);
      recordingStarted = true;
      recording = started.recordings[0];
      expect(started.recordings).toHaveLength(1);
      expect(recording?.recordingId).toBeTruthy();
      // Let the encoder receive frames before the first panel goes inactive.
      await Bun.sleep(1000);
      await setPosture(sessionUuid, "closed", isFold ? undefined : "phone");
      if (isFold) {
        closed = await expectPanel(sessionUuid, undefined, isFold ? "cover" : undefined, "closed");
      } else {
        const changed = await awaitScreenSizeChange({
          observe: () => observe(sessionUuid),
          baseline: opened.screenSize,
          attempts: 10,
          delayMs: 500,
          sleep: (ms) => Bun.sleep(ms),
        });
        expect(changed.screenSize).not.toEqual(opened.screenSize);
        closed = await expectPanel(sessionUuid, changed.screenSize, undefined, "closed");
      }
      await setPosture(sessionUuid, "opened", isFold ? undefined : "unfolded");
      reopened = await expectPanel(
        sessionUuid,
        opened.screenSize,
        isFold ? "inner" : undefined,
        "opened",
      );
    } catch (error) {
      primary = { error };
    } finally {
      const failures = await runCleanupSteps(
        [
          {
            name: "stop recording and write stop result",
            run: async () => {
              if (!recordingStarted) {
                return;
              }
              stopped = await tool<RecordingResult>(sessionUuid, "videoRecording", [
                "--action",
                "stop",
                ...(recording?.recordingId ? ["--recordingId", recording.recordingId] : []),
              ]);
              await mkdir(outputDirectory, { recursive: true });
              await writeFile(
                join(outputDirectory, "stop-result.json"),
                JSON.stringify(stopped, null, 2),
              );
            },
          },
          {
            name: "copy recording directory",
            run: async () => {
              if (recording?.outputPath) {
                await mkdir(outputDirectory, { recursive: true });
                await cp(
                  dirname(recording.outputPath),
                  join(outputDirectory, recording.recordingId),
                  {
                    recursive: true,
                  },
                );
              }
            },
          },
          { name: "release session", run: () => releaseSession(sessionUuid) },
        ],
        (message) => console.warn(message),
      );
      const errorToThrow = selectErrorToThrow(primary, failures);
      if (errorToThrow !== undefined) {
        throw errorToThrow;
      }
    }

    expect(stopped?.recordings).toHaveLength(1);
    const metadata = stopped?.recordings[0]?.metadata;
    if (!metadata || !reopened) {
      throw new Error("Missing finalized recording metadata or post-unfold observation");
    }
    expect(reopened.screenshotSettled).toBe(true);
    expect(reopened.screenshotSource).toBe("fresh");
    // screenshotCapturedAt is the settled screenshot's host-file mtime (or host
    // Timer.now), comparable to recording startedAt on the same stable host clock.
    // Android freshness.actualTimestamp and updatedAt can use the device clock.
    assertRecordingSpansObservation(metadata, Date.parse(reopened.screenshotCapturedAt ?? ""));
    const containerPath = stopped.recordings[0].outputPath ?? metadata.filePath;
    const containerDurationMs = await probeContainerDurationMs(ffprobeRunner, containerPath);
    if (containerDurationMs !== undefined) {
      assertContainerDurationSpans(
        containerDurationMs,
        Date.parse(metadata.startedAt),
        Date.parse(reopened.screenshotCapturedAt ?? ""),
      );
    }
    // config.resolution is a requested size, not measured output dimensions;
    // the stop result cannot assert the absence of a letterboxed union canvas.
    // Resizable's single-display AVD leaves device.displays undefined, so no panel metadata is emitted.
    if (isFold) {
      expect(metadata?.recordedPanel?.key).toBeTruthy();
      expect(metadata?.recordedPanel).toMatchObject({
        key: opened!.display.key,
        role: opened!.display.role,
      });
      expect(metadata?.recordedPanel?.role).toBe("inner");
      const transitions = metadata?.transitions ?? [];
      const toCover = transitions.findIndex(
        ({ from, to }) => from.key === opened!.display.key && to.key === closed!.display.key,
      );
      expect(toCover).toBeGreaterThanOrEqual(0);
      const toInner = transitions.findIndex(
        ({ from, to }, index) =>
          index > toCover && from.key === closed!.display.key && to.key === opened!.display.key,
      );
      expect(toInner).toBeGreaterThan(toCover);
      expect(transitions[toCover].to.role).toBe(closed!.display.role);
      expect(transitions[toInner].to.role).toBe("inner");
    }
  }, 600_000);
});
