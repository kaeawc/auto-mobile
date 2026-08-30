import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import { promises as fsPromises } from "node:fs";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeVideoCaptureBackend } from "../fakes/FakeVideoCaptureBackend";
import { FakeHighlightClient } from "../fakes/FakeHighlightClient";
import { FakeVideoRecordingRepository } from "../fakes/FakeVideoRecordingRepository";
import { FakeVideoRecordingConfigRepository } from "../fakes/FakeVideoRecordingConfigRepository";
import {
  DEFAULT_VIDEO_RECORDING_CONFIG,
  VideoRecorderService,
  type ActiveVideoRecording,
} from "../../src/features/video";
import {
  registerVideoRecordingTools,
  resetSegmentedSessions,
  setSegmentedSessionRecordingDependencies,
  setSegmentedSessionTimer,
  setVideoRecordingDeviceDetectorForTesting,
} from "../../src/server/videoRecordingTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import {
  resetVideoRecordingManagerDependencies,
  setVideoRecordingManagerDependencies,
} from "../../src/server/videoRecordingManager";
import { FakeDeviceSessionManager } from "../fakes/FakeDeviceSessionManager";
import { ANDROID_PLAN_VIDEO_SEGMENT_ROTATE_MS } from "../../src/features/video/androidScreenrecord";
import type { BootedDevice, VideoRecordingMetadata } from "../../src/models";

async function drainMicrotasks(turns = 10): Promise<void> {
  for (let turn = 0; turn < turns; turn++) {
    await Promise.resolve();
  }
}

async function waitFor(condition: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (condition()) {
      return;
    }
    await drainMicrotasks();
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

interface ToolResponse {
  content?: Array<{ text?: string }>;
}

function parse(response: ToolResponse): Record<string, unknown> {
  return JSON.parse(response.content?.[0]?.text ?? "{}");
}

// Directory the fake segment paths live under. Set to the per-test archiveRoot in
// beforeEach so a real, cross-platform, auto-cleaned dir exists when the tool writes the
// segments.json manifest there (a hardcoded "/tmp" is not writable on the Windows CI leg).
let fakeSegmentDir = os.tmpdir();

function makeSegmentRecording(id: string, outputName: string | undefined): ActiveVideoRecording {
  return {
    recordingId: id,
    outputPath: path.join(fakeSegmentDir, `${id}.mp4`),
    fileName: `${id}.mp4`,
    startedAt: new Date(0).toISOString(),
    outputName,
    config: DEFAULT_VIDEO_RECORDING_CONFIG,
  };
}

function makeSegmentMetadata(id: string): VideoRecordingMetadata {
  return {
    recordingId: id,
    fileName: `${id}.mp4`,
    filePath: path.join(fakeSegmentDir, `${id}.mp4`),
    format: "mp4",
    sizeBytes: 1,
    codec: "h264",
    createdAt: new Date(0).toISOString(),
    startedAt: new Date(0).toISOString(),
    lastAccessedAt: new Date(0).toISOString(),
    config: DEFAULT_VIDEO_RECORDING_CONFIG,
  };
}

const androidDevice: BootedDevice = {
  deviceId: "test-device",
  platform: "android",
  name: "Test Device",
};

const iosDevice: BootedDevice = {
  deviceId: "ios-device",
  platform: "ios",
  name: "Test iPhone",
};

describe("videoRecording tool segmentation branch", () => {
  let fakeTimer: FakeTimer;
  let segmentTimer: FakeTimer;
  let fakeBackend: FakeVideoCaptureBackend;
  let fakeRepository: FakeVideoRecordingRepository;
  let fakeDeviceSessionManager: FakeDeviceSessionManager;
  let archiveRoot: string;
  let segmentStarts: string[];
  let segmentStops: string[];

  beforeAll(async () => {
    if (!ToolRegistry.getTool("videoRecording")) {
      registerVideoRecordingTools();
    }
    archiveRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), "auto-mobile-video-tool-"));
  });

  beforeEach(async () => {
    fakeTimer = new FakeTimer();
    segmentTimer = new FakeTimer();
    fakeBackend = new FakeVideoCaptureBackend();
    fakeBackend.setNowProvider(() => new Date(fakeTimer.now()));
    fakeRepository = new FakeVideoRecordingRepository();
    // A bare (by-device) stop resolves target devices via detectConnectedPlatforms(), which on
    // the real DeviceSessionManager spawns `adb`/`xcrun simctl` subprocesses. On a loaded macOS
    // CI runner `simctl list` can stall past the test timeout (#3943), so inject a fake detector
    // that resolves the connected device synchronously with no subprocess.
    fakeDeviceSessionManager = new FakeDeviceSessionManager();
    fakeDeviceSessionManager.setConnectedDevices([androidDevice]);
    setVideoRecordingDeviceDetectorForTesting(fakeDeviceSessionManager);
    segmentStarts = [];
    segmentStops = [];
    await fsPromises.rm(archiveRoot, { recursive: true, force: true });
    await fsPromises.mkdir(archiveRoot, { recursive: true });
    fakeSegmentDir = archiveRoot;

    const service = new VideoRecorderService({
      backend: fakeBackend,
      archiveRoot,
      now: () => new Date(fakeTimer.now()),
    });

    await setVideoRecordingManagerDependencies({
      videoRecorderService: service,
      recordingRepository: fakeRepository,
      configRepository: new FakeVideoRecordingConfigRepository(),
      highlightClient: new FakeHighlightClient(),
      timer: fakeTimer,
      now: () => new Date(fakeTimer.now()),
    });

    // Segmented sessions created by the tool use this controllable timer.
    setSegmentedSessionTimer(segmentTimer);
  });

  afterEach(() => {
    resetVideoRecordingManagerDependencies();
    resetSegmentedSessions();
    setVideoRecordingDeviceDetectorForTesting(undefined);
  });

  afterAll(async () => {
    await fsPromises.rm(archiveRoot, { recursive: true, force: true });
  });

  const handler = () => ToolRegistry.getTool("videoRecording")!.deviceAwareHandler!;

  test("request abort rolls back every device that already started during fanout", async () => {
    const secondDevice: BootedDevice = {
      deviceId: "test-device-2",
      platform: "android",
      name: "Test Device 2",
    };
    fakeDeviceSessionManager.setConnectedDevices([androidDevice, secondDevice]);
    const controller = new AbortController();
    let markSecondStart: (() => void) | undefined;
    const secondStart = new Promise<void>((resolve) => {
      markSecondStart = resolve;
    });
    fakeBackend.start = async (config) => {
      fakeBackend.startCalls.push(config);
      if (fakeBackend.startCalls.length === 2) {
        markSecondStart?.();
        await new Promise<void>((resolve) => {
          config.abortSignal?.addEventListener("abort", resolve, { once: true });
        });
        throw new Error("fanout start aborted");
      }
      const handle = {
        recordingId: config.recordingId,
        outputPath: config.outputPath,
        startedAt: config.startedAt,
      };
      fakeBackend.startResults.push(handle);
      return handle;
    };

    const starting = handler()(
      androidDevice,
      { action: "start", platform: "android" },
      undefined,
      controller.signal,
    );
    await secondStart;
    controller.abort();

    await expect(starting).rejects.toThrow();
    expect(fakeBackend.startCalls).toHaveLength(2);
    expect(fakeBackend.forceStopCalls).toEqual([fakeBackend.startResults[0]]);
    expect(await fakeRepository.listRecordings()).toEqual([]);
  });

  test("retains auto-finalized segments until an all-device start commits", async () => {
    const secondDevice: BootedDevice = {
      deviceId: "test-device-2",
      platform: "android",
      name: "Test Device 2",
    };
    fakeDeviceSessionManager.setConnectedDevices([androidDevice, secondDevice]);
    const controller = new AbortController();
    const rolledBack: string[] = [];
    let secondStartSignal: AbortSignal | undefined;
    let markSecondStart: (() => void) | undefined;
    const secondStart = new Promise<void>((resolve) => {
      markSecondStart = resolve;
    });
    setSegmentedSessionRecordingDependencies({
      startVideoRecording: async (request) => {
        if (request.device.deviceId === secondDevice.deviceId) {
          secondStartSignal = request.abortSignal;
          markSecondStart?.();
          await new Promise<void>((resolve) => {
            request.abortSignal?.addEventListener("abort", resolve, { once: true });
          });
          request.abortSignal?.throwIfAborted();
        }
        const recordingId = `${request.device.deviceId}-${request.outputName}`;
        return makeSegmentRecording(recordingId, request.outputName);
      },
      stopVideoRecording: async (recordingId) => ({
        metadata: makeSegmentMetadata(recordingId ?? "missing"),
        evictedRecordingIds: [],
      }),
      rollbackVideoRecordingStart: async (recordingId) => {
        rolledBack.push(recordingId);
      },
    });

    const starting = handler()(
      androidDevice,
      { action: "start", platform: "android", maxDuration: 181, outputName: "fanout" },
      undefined,
      controller.signal,
    );
    await secondStart;
    segmentTimer.advanceTime(181_000);
    await drainMicrotasks();

    controller.abort(new Error("fanout cancelled"));
    await expect(starting).rejects.toThrow("fanout cancelled");

    expect(secondStartSignal?.aborted).toBe(true);
    expect(rolledBack.some((recordingId) => recordingId.startsWith(androidDevice.deviceId))).toBe(
      true,
    );
  });

  test("request abort cancels all-device discovery before backend startup", async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    let markDiscoveryStarted: (() => void) | undefined;
    const discoveryStarted = new Promise<void>((resolve) => {
      markDiscoveryStarted = resolve;
    });
    setVideoRecordingDeviceDetectorForTesting({
      detectConnectedPlatforms: async (signal) => {
        receivedSignal = signal;
        markDiscoveryStarted?.();
        await new Promise<void>((resolve) => {
          signal?.addEventListener("abort", resolve, { once: true });
        });
        signal?.throwIfAborted();
        return [];
      },
    });

    const starting = handler()(
      androidDevice,
      { action: "start", platform: "android" },
      undefined,
      controller.signal,
    );
    await discoveryStarted;
    controller.abort(new Error("discovery cancelled"));

    await expect(starting).rejects.toThrow("discovery cancelled");
    expect(receivedSignal).toBe(controller.signal);
    expect(fakeBackend.startCalls).toEqual([]);
  });

  test("android recording <= 180s stays single (not segmented)", async () => {
    const res = parse(
      await handler()(androidDevice, {
        action: "start",
        platform: "android",
        deviceId: androidDevice.deviceId,
        maxDuration: 60,
        outputName: "short",
      }),
    );

    expect(res.count).toBe(1);
    const recordings = res.recordings as Array<Record<string, unknown>>;
    expect(recordings[0].segmented).toBeUndefined();

    // Clean up the single recording.
    await handler()(androidDevice, {
      action: "stop",
      platform: "android",
      recordingId: recordings[0].recordingId as string,
    });
  });

  test("non-android recording past the android cap stays single (not segmented)", async () => {
    // 200s exceeds ANDROID_SCREENRECORD_MAX_SECONDS (would segment on android)
    // but stays within the manager's single-recording cap for iOS.
    const res = parse(
      await handler()(iosDevice, {
        action: "start",
        platform: "ios",
        deviceId: iosDevice.deviceId,
        maxDuration: 200,
        outputName: "long-ios",
      }),
    );

    expect(res.count).toBe(1);
    const recordings = res.recordings as Array<Record<string, unknown>>;
    expect(recordings[0].segmented).toBeUndefined();

    await handler()(iosDevice, {
      action: "stop",
      platform: "ios",
      recordingId: recordings[0].recordingId as string,
    });
  });

  test("iOS recording past the 300s cap starts as one continuous (non-segmented) recording (#3906)", async () => {
    // 500s > the old 300s manager cap. iOS `simctl recordVideo` has no time limit, so this
    // is a single continuous recording (never segmented), not a rejection or a segment set.
    const res = parse(
      await handler()(iosDevice, {
        action: "start",
        platform: "ios",
        deviceId: iosDevice.deviceId,
        maxDuration: 500,
        outputName: "long-ios",
      }),
    );

    expect(res.count).toBe(1);
    const recordings = res.recordings as Array<Record<string, unknown>>;
    expect(recordings[0].segmented).toBeUndefined();
    expect((recordings[0].settings as Record<string, unknown>).maxDurationSeconds).toBe(500);

    await handler()(iosDevice, {
      action: "stop",
      platform: "ios",
      recordingId: recordings[0].recordingId as string,
    });
  });

  test("android recording > 180s: stop returns ordered segments + a segments.json manifest (#3905)", async () => {
    const startRes = parse(
      await handler()(androidDevice, {
        action: "start",
        platform: "android",
        deviceId: androidDevice.deviceId,
        maxDuration: 400,
        outputName: "vid",
      }),
    );

    expect(startRes.count).toBe(1);
    const started = (startRes.recordings as Array<Record<string, unknown>>)[0];
    expect(started.segmented).toBe(true);
    expect(started.outputName).toBe("vid");
    // start echoes the session handle as sessionId so it matches stop output.
    expect(started.sessionId).toBe(started.recordingId);

    const handle = started.recordingId as string;
    const stopRes = parse(
      await handler()(androidDevice, {
        action: "stop",
        platform: "android",
        recordingId: handle,
      }),
    );

    expect(stopRes.segmented).toBe(true);
    const segments = stopRes.recordings as Array<Record<string, unknown>>;
    // No timer rotation occurred, so exactly the first segment is returned.
    expect(segments.length).toBe(1);
    expect(segments[0].recordingId).toBe(handle);
    expect(typeof segments[0].filePath).toBe("string");
    // Grouping metadata: capture order + shared sessionId on every segment.
    expect(segments[0].segmentIndex).toBe(0);
    expect(segments[0].sessionId).toBe(handle);

    // Manifest lives in the first segment's directory (so per-recording eviction cleans it up).
    const manifestPath = stopRes.manifestPath as string;
    expect(path.basename(manifestPath)).toBe("segments.json");
    expect(path.dirname(manifestPath)).toBe(path.dirname(segments[0].filePath as string));

    // On-disk manifest content matches the response, in order.
    const manifest = JSON.parse(await fsPromises.readFile(manifestPath, "utf8"));
    expect(manifest.sessionId).toBe(handle);
    expect(manifest.segmentCount).toBe(segments.length);
    expect(manifest.segments).toEqual(
      segments.map((segment, index) => ({
        index,
        recordingId: segment.recordingId,
        filePath: segment.filePath,
      })),
    );
  });

  test("cancellation reaches initial segmented startup and discards a raced successful start", async () => {
    const controller = new AbortController();
    let resolveStart!: (recording: ActiveVideoRecording) => void;
    const startMayComplete = new Promise<ActiveVideoRecording>((resolve) => {
      resolveStart = resolve;
    });
    let receivedSignal: AbortSignal | undefined;
    setSegmentedSessionRecordingDependencies({
      startVideoRecording: async (request) => {
        receivedSignal = request.abortSignal;
        return await startMayComplete;
      },
      stopVideoRecording: async (recordingId) => {
        const id = recordingId ?? "segment-0";
        segmentStops.push(id);
        throw new Error(`graceful stop failed for ${id}`);
      },
      rollbackVideoRecordingStart: async (recordingId) => {
        segmentStops.push(recordingId);
      },
    });

    const starting = handler()(
      androidDevice,
      {
        action: "start",
        platform: "android",
        deviceId: androidDevice.deviceId,
        maxDuration: 300,
        outputName: "cancelled",
      },
      undefined,
      controller.signal,
    );
    await waitFor(() => receivedSignal !== undefined, "segmented start to receive abort signal");

    controller.abort(new Error("request cancelled"));
    resolveStart(makeSegmentRecording("cancelled", "cancelled"));

    await expect(starting).rejects.toThrow("request cancelled");
    expect(receivedSignal).toBe(controller.signal);
    expect(segmentStops).toEqual(["cancelled"]);
    expect(segmentTimer.getPendingTimeoutCount()).toBe(0);
  });

  test("bare (by-device) stop finalizes the segmented session and leaves no rotation timer", async () => {
    setSegmentedSessionRecordingDependencies({
      startVideoRecording: async (request) => {
        const outputName = request.outputName;
        const recordingId = outputName ?? `segment-${segmentStarts.length}`;
        segmentStarts.push(recordingId);
        return makeSegmentRecording(recordingId, outputName);
      },
      stopVideoRecording: async (recordingId) => {
        const id = recordingId ?? `segment-${segmentStops.length}`;
        segmentStops.push(id);
        return {
          metadata: makeSegmentMetadata(id),
          evictedRecordingIds: [],
        };
      },
    });

    // Mirrors the qa-agent's real usage: start with maxDuration=300 (> 180 so
    // it segments), then stop WITHOUT a recordingId.
    const startRes = parse(
      await handler()(androidDevice, {
        action: "start",
        platform: "android",
        deviceId: androidDevice.deviceId,
        maxDuration: 300,
        outputName: "vid",
      }),
    );
    const started = (startRes.recordings as Array<Record<string, unknown>>)[0];
    expect(started.segmented).toBe(true);
    // Two timers are armed on the session's (injected) timer: the rotation timer, and
    // the session-level maxDurationSeconds auto-stop (review: PR #3847 - maxDuration=300
    // must actually bound total duration, not just gate whether segmentation kicks in).
    expect(segmentTimer.getPendingTimeoutCount()).toBe(2);

    // From this point, the segmented session owns its lifecycle. A late async
    // rotation or bare stop must not rebuild the real manager/database singleton.
    resetVideoRecordingManagerDependencies();

    // Rotate once so the bare stop must return more than one segment, in order.
    segmentTimer.advanceTime(ANDROID_PLAN_VIDEO_SEGMENT_ROTATE_MS);
    await waitFor(
      () => segmentStarts.length === 2 && segmentStops.length === 1,
      "segment 2 to start after rotation",
    );

    const stopRes = parse(
      await handler()(androidDevice, {
        action: "stop",
        platform: "android",
        // NO recordingId — bare, by-device stop.
      }),
    );

    // Regression guard for #3943: the bare stop must resolve its target device through the
    // injected DeviceSessionManager singleton, never the real one (whose detectConnectedPlatforms
    // spawns an `xcrun simctl` subprocess that stalls the test on macOS CI).
    expect(fakeDeviceSessionManager.getDetectConnectedPlatformsCallCount()).toBeGreaterThanOrEqual(
      1,
    );

    expect(stopRes.segmented).toBe(true);
    const segments = stopRes.recordings as Array<Record<string, unknown>>;
    expect(segments.length).toBe(2);
    expect(segments.every((segment) => segment.segmented === true)).toBe(true);
    expect(typeof segments[0].filePath).toBe("string");
    expect(typeof segments[1].filePath).toBe("string");
    // Segments carry their capture order and a shared sessionId (the first segment's id),
    // and a bare stop surfaces the manifest path(s) it wrote (#3905).
    expect(segments.map((segment) => segment.segmentIndex)).toEqual([0, 1]);
    const sessionId = segments[0].sessionId;
    expect(sessionId).toBe(segments[0].recordingId);
    expect(segments.every((segment) => segment.sessionId === sessionId)).toBe(true);
    expect((stopRes.manifestPaths as string[]).length).toBe(1);

    // Invariant: the rotation timer must not survive a bare stop.
    expect(segmentTimer.getPendingTimeoutCount()).toBe(0);

    // Advancing well past the rotation interval starts no new segment/recording.
    const segmentStartsBefore = segmentStarts.length;
    segmentTimer.advanceTime(ANDROID_PLAN_VIDEO_SEGMENT_ROTATE_MS * 3);
    await drainMicrotasks();
    expect(segmentStarts).toHaveLength(segmentStartsBefore);
  });

  test("maxDuration auto-stop removes the session so a later bare stop reports only fresh segments", async () => {
    setSegmentedSessionRecordingDependencies({
      startVideoRecording: async (request) => {
        const outputName = request.outputName;
        const recordingId = outputName ?? `segment-${segmentStarts.length}`;
        segmentStarts.push(recordingId);
        return makeSegmentRecording(recordingId, outputName);
      },
      stopVideoRecording: async (recordingId) => {
        const id = recordingId ?? `segment-${segmentStops.length}`;
        segmentStops.push(id);
        return {
          metadata: makeSegmentMetadata(id),
          evictedRecordingIds: [],
        };
      },
    });

    // Fire-and-forget usage: start a segmented recording with a maxDuration bound and
    // never call stop. The session-level auto-stop must fire AND clean itself out of the
    // registry — otherwise the dead entry leaks and its stale segments resurface later.
    await handler()(androidDevice, {
      action: "start",
      platform: "android",
      deviceId: androidDevice.deviceId,
      maxDuration: 181,
      outputName: "first",
    });
    expect(segmentTimer.getPendingTimeoutCount()).toBe(2);

    // The segmented session now owns its lifecycle; don't let a late finalize rebuild the
    // real manager/database singleton.
    resetVideoRecordingManagerDependencies();

    // Advance past the maxDuration bound (rotation at 170s, then auto-stop at 181s).
    segmentTimer.advanceTime(181_000);
    await waitFor(
      () => segmentStops.length === 2,
      "auto-stop to finalize both segments of the first session",
    );
    await drainMicrotasks();

    // Auto-stop cleared the session's timers and removed it from the registry.
    expect(segmentTimer.getPendingTimeoutCount()).toBe(0);

    // A new recording starts on the SAME device (the QA runner's next test case).
    await handler()(androidDevice, {
      action: "start",
      platform: "android",
      deviceId: androidDevice.deviceId,
      maxDuration: 300,
      outputName: "second",
    });

    // Bare (by-device) stop: with the leak fixed, forDevice() sees only the new session,
    // so the response lists only the fresh segment — never the auto-stopped first session's.
    const stopRes = parse(
      await handler()(androidDevice, {
        action: "stop",
        platform: "android",
        // NO recordingId — bare, by-device stop.
      }),
    );

    // Regression guard for #3943 (this bare stop hits the same device-resolution path):
    // it must go through the injected DeviceSessionManager, never the real subprocess one.
    expect(fakeDeviceSessionManager.getDetectConnectedPlatformsCallCount()).toBeGreaterThanOrEqual(
      1,
    );

    const segments = stopRes.recordings as Array<Record<string, unknown>>;
    expect(segments.length).toBe(1);
    expect(segments[0].recordingId).toBe("second");
    expect(segments.some((segment) => String(segment.filePath).includes("first"))).toBe(false);
  });

  test("by-handle stop still works after wiring the bare-stop path", async () => {
    const startRes = parse(
      await handler()(androidDevice, {
        action: "start",
        platform: "android",
        deviceId: androidDevice.deviceId,
        maxDuration: 300,
        outputName: "vid",
      }),
    );
    const handle = (startRes.recordings as Array<Record<string, unknown>>)[0].recordingId as string;

    const stopRes = parse(
      await handler()(androidDevice, {
        action: "stop",
        platform: "android",
        recordingId: handle,
      }),
    );

    expect(stopRes.segmented).toBe(true);
    expect((stopRes.recordings as unknown[]).length).toBe(1);
    expect(segmentTimer.getPendingTimeoutCount()).toBe(0);
  });
});
