import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { BootedDevice, VideoRecordingConfig, VideoRecordingMetadata } from "../../src/models";
import type { ActiveVideoRecording } from "../../src/features/video";
import type { VideoRecordingRecord } from "../../src/db/videoRecordingRepository";
import { ANDROID_PLAN_VIDEO_SEGMENT_ROTATE_MS, ANDROID_SCREENRECORD_MAX_SECONDS } from "../../src/features/video/androidScreenrecord";
import {
  createVideoRecordingToolHandlersForTesting,
  resetRawAndroidSegmentedVideoSessionsForTesting,
} from "../../src/server/videoRecordingTools";
import type { VideoRecordingArgs } from "../../src/server/videoRecordingTools";
import { FakeTimer } from "../fakes/FakeTimer";

const androidDevice: BootedDevice = {
  deviceId: "emulator-5554",
  name: "Pixel API 35",
  platform: "android",
};

const iosDevice: BootedDevice = {
  deviceId: "AAAA1111-BBBB-2222-CCCC-3333DDDD4444",
  name: "iPhone 15",
  platform: "ios",
};

const lowConfig: VideoRecordingConfig = {
  qualityPreset: "low",
  targetBitrateKbps: 1000,
  maxThroughputMbps: 5,
  fps: 15,
  maxArchiveSizeMb: 100,
  format: "mp4",
};

function parseToolPayload(response: { content: Array<{ type: "text"; text: string }> }) {
  return JSON.parse(response.content[0]?.text ?? "{}") as {
    action: string;
    count: number;
    recordings: Array<{
      recordingId: string;
      filePath?: string;
      outputPath?: string;
      deviceId: string;
      platform: string;
      settings?: { maxDurationSeconds?: number };
    }>;
  };
}

function createFakeVideoManager(timer: FakeTimer) {
  const startCalls: Array<{
    device: BootedDevice;
    outputName?: string;
    maxDurationSeconds?: number;
  }> = [];
  const stopCalls: Array<string | undefined> = [];
  const records = new Map<string, VideoRecordingRecord>();
  const stopFailures = new Map<string, Error>();
  let nextRecordingId = 0;

  const start = async (request: {
    device: BootedDevice;
    outputName?: string;
    maxDurationSeconds?: number;
  }): Promise<ActiveVideoRecording> => {
    startCalls.push(request);
    const recordingId = `rec-${++nextRecordingId}`;
    const startedAt = new Date(timer.now()).toISOString();
    const outputPath = `/tmp/${recordingId}.mp4`;
    records.set(recordingId, {
      recordingId,
      deviceId: request.device.deviceId,
      platform: request.device.platform,
      status: "recording",
      outputName: request.outputName,
      fileName: `${recordingId}.mp4`,
      filePath: outputPath,
      format: "mp4",
      sizeBytes: 0,
      durationMs: undefined,
      codec: undefined,
      createdAt: startedAt,
      startedAt,
      endedAt: undefined,
      lastAccessedAt: startedAt,
      config: lowConfig,
    });

    return {
      recordingId,
      outputPath,
      fileName: `${recordingId}.mp4`,
      startedAt,
      config: lowConfig,
      outputName: request.outputName,
    };
  };

  const stop = async (
    recordingId?: string
  ): Promise<{ metadata: VideoRecordingMetadata; evictedRecordingIds: string[] }> => {
    stopCalls.push(recordingId);
    const id = recordingId ?? Array.from(records.values()).find(record => record.status === "recording")?.recordingId;
    const record = id ? records.get(id) : undefined;
    if (!record) {
      throw new Error(`No active recording found for id ${recordingId ?? ""}`);
    }
    const stopFailure = stopFailures.get(record.recordingId);
    if (stopFailure) {
      throw stopFailure;
    }

    const endedAt = new Date(timer.now()).toISOString();
    const durationMs = Math.max(0, Date.parse(endedAt) - Date.parse(record.startedAt));
    const metadata: VideoRecordingMetadata = {
      recordingId: record.recordingId,
      fileName: record.fileName,
      filePath: record.filePath,
      format: record.format,
      sizeBytes: 1,
      durationMs,
      codec: "h264",
      outputName: record.outputName,
      createdAt: record.createdAt,
      startedAt: record.startedAt,
      endedAt,
      lastAccessedAt: endedAt,
      config: record.config,
    };

    records.set(record.recordingId, {
      ...record,
      ...metadata,
      status: "completed",
    });

    return { metadata, evictedRecordingIds: [] };
  };

  const listActive = async (query: { platform?: "android" | "ios" } = {}) =>
    Array.from(records.values()).filter(record =>
      record.status === "recording" &&
      (query.platform === undefined || record.platform === query.platform)
    );

  return { failStop: (recordingId: string, error: Error) => stopFailures.set(recordingId, error), listActive, start, startCalls, stop, stopCalls };
}

async function waitForCondition(
  predicate: () => boolean,
  message: string
): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (predicate()) {
      return;
    }
    await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error(message);
}

describe("videoRecording raw Android segmentation", () => {
  let fakeTimer: FakeTimer;
  let fakeVideoManager: ReturnType<typeof createFakeVideoManager>;
  let videoRecordingHandler: (
    device: BootedDevice,
    args: VideoRecordingArgs
  ) => Promise<unknown>;

  beforeEach(() => {
    fakeTimer = new FakeTimer();
    fakeVideoManager = createFakeVideoManager(fakeTimer);

    resetRawAndroidSegmentedVideoSessionsForTesting();
    videoRecordingHandler = createVideoRecordingToolHandlersForTesting({
      timer: fakeTimer,
      startVideoRecording: fakeVideoManager.start as never,
      stopVideoRecording: fakeVideoManager.stop,
      listActiveVideoRecordings: fakeVideoManager.listActive,
    }).videoRecordingHandler;
  });

  afterEach(() => {
    resetRawAndroidSegmentedVideoSessionsForTesting();
  });

  test("raw Android recording rotates segments and returns every segment on stop", async () => {
    const startResponse = await videoRecordingHandler(androidDevice, {
      action: "start",
      platform: "android",
      deviceId: androidDevice.deviceId,
      outputName: "qa-case",
      maxDuration: 300,
    });
    const startPayload = parseToolPayload(startResponse);
    const originalRecordingId = startPayload.recordings[0]?.recordingId;

    expect(startPayload.count).toBe(1);
    expect(startPayload.recordings[0]?.settings?.maxDurationSeconds).toBe(300);
    expect(fakeVideoManager.startCalls).toHaveLength(1);
    expect(fakeVideoManager.startCalls[0]?.maxDurationSeconds).toBe(ANDROID_SCREENRECORD_MAX_SECONDS);

    await fakeTimer.advanceTimersByTimeAsync(ANDROID_PLAN_VIDEO_SEGMENT_ROTATE_MS);
    await waitForCondition(
      () => fakeVideoManager.startCalls.length === 2,
      "Timed out waiting for Android raw recording rotation"
    );

    expect(fakeVideoManager.stopCalls).toHaveLength(1);
    expect(fakeVideoManager.startCalls).toHaveLength(2);
    expect(fakeVideoManager.startCalls[1]?.maxDurationSeconds).toBe(ANDROID_SCREENRECORD_MAX_SECONDS);

    const stopResponse = await videoRecordingHandler(androidDevice, {
      action: "stop",
      platform: "android",
      recordingId: originalRecordingId,
    });
    const stopPayload = parseToolPayload(stopResponse);

    expect(stopPayload.count).toBe(2);
    expect(stopPayload.recordings.map(recording => recording.recordingId)).toEqual(["rec-1", "rec-2"]);
    expect(stopPayload.recordings.every(recording => recording.platform === "android")).toBe(true);
    expect(fakeVideoManager.stopCalls).toHaveLength(2);
  });

  test("raw Android recording can stop rotated segments by device without recordingId", async () => {
    await videoRecordingHandler(androidDevice, {
      action: "start",
      platform: "android",
      deviceId: androidDevice.deviceId,
      outputName: "qa-case",
      maxDuration: 300,
    });

    await fakeTimer.advanceTimersByTimeAsync(ANDROID_PLAN_VIDEO_SEGMENT_ROTATE_MS);
    await waitForCondition(
      () => fakeVideoManager.startCalls.length === 2,
      "Timed out waiting for Android raw recording rotation"
    );

    const stopResponse = await videoRecordingHandler(androidDevice, {
      action: "stop",
      platform: "android",
      deviceId: androidDevice.deviceId,
    });
    const stopPayload = parseToolPayload(stopResponse);

    expect(stopPayload.count).toBe(2);
    expect(stopPayload.recordings.map(recording => recording.recordingId)).toEqual(["rec-1", "rec-2"]);
    expect(fakeVideoManager.stopCalls).toEqual(["rec-1", "rec-2"]);
  });

  test("raw Android recording fails stop when the final segment cannot stop", async () => {
    const startResponse = await videoRecordingHandler(androidDevice, {
      action: "start",
      platform: "android",
      deviceId: androidDevice.deviceId,
      outputName: "qa-case",
      maxDuration: 300,
    });
    const startPayload = parseToolPayload(startResponse);

    await fakeTimer.advanceTimersByTimeAsync(ANDROID_PLAN_VIDEO_SEGMENT_ROTATE_MS);
    await waitForCondition(
      () => fakeVideoManager.startCalls.length === 2,
      "Timed out waiting for Android raw recording rotation"
    );

    fakeVideoManager.failStop("rec-2", new Error("final stop failed"));

    await expect(videoRecordingHandler(androidDevice, {
      action: "stop",
      platform: "android",
      recordingId: startPayload.recordings[0]?.recordingId,
    })).rejects.toThrow("Failed to stop video recording");
  });

  test("raw iOS recording remains a single manager-backed recording", async () => {
    const startResponse = await videoRecordingHandler(iosDevice, {
      action: "start",
      platform: "ios",
      deviceId: iosDevice.deviceId,
      outputName: "ios-case",
      maxDuration: 300,
    });
    const startPayload = parseToolPayload(startResponse);

    expect(startPayload.count).toBe(1);
    expect(fakeVideoManager.startCalls).toHaveLength(1);
    expect(fakeVideoManager.startCalls[0]?.maxDurationSeconds).toBe(300);

    const stopResponse = await videoRecordingHandler(iosDevice, {
      action: "stop",
      platform: "ios",
      recordingId: startPayload.recordings[0]?.recordingId,
    });
    const stopPayload = parseToolPayload(stopResponse);

    expect(stopPayload.count).toBe(1);
    expect(stopPayload.recordings[0]?.platform).toBe("ios");
    expect(fakeVideoManager.stopCalls).toHaveLength(1);
  });
});
