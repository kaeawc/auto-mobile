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
} from "../../src/server/videoRecordingTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import {
  resetVideoRecordingManagerDependencies,
  setVideoRecordingManagerDependencies,
} from "../../src/server/videoRecordingManager";
import { ANDROID_PLAN_VIDEO_SEGMENT_ROTATE_MS } from "../../src/features/video/androidScreenrecord";
import { defaultTimer } from "../../src/utils/SystemTimer";
import type { BootedDevice, VideoRecordingMetadata } from "../../src/models";

/** Drain all pending microtasks (setImmediate runs after the microtask queue). */
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

/** Poll an async condition, yielding to the full event loop between checks. */
async function waitFor(condition: () => Promise<boolean>, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await condition()) {
      return;
    }
    // Drain microtasks (flush) AND a macrotask turn so real fs/resource-registry
    // awaits in the rotation chain settle even under concurrent file execution.
    await flush();
    await defaultTimer.sleep(0);
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

interface ToolResponse {
  content?: Array<{ text?: string }>;
}

function parse(response: ToolResponse): Record<string, unknown> {
  return JSON.parse(response.content?.[0]?.text ?? "{}");
}

function makeSegmentRecording(id: string, outputName: string | undefined): ActiveVideoRecording {
  return {
    recordingId: id,
    outputPath: `/tmp/${id}.mp4`,
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
    filePath: `/tmp/${id}.mp4`,
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
    segmentStarts = [];
    segmentStops = [];
    await fsPromises.rm(archiveRoot, { recursive: true, force: true });
    await fsPromises.mkdir(archiveRoot, { recursive: true });

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
  });

  afterAll(async () => {
    await fsPromises.rm(archiveRoot, { recursive: true, force: true });
  });

  const handler = () => ToolRegistry.getTool("videoRecording")!.deviceAwareHandler!;

  test("android recording <= 180s stays single (not segmented)", async () => {
    const res = parse(
      await handler()(androidDevice, {
        action: "start",
        platform: "android",
        deviceId: androidDevice.deviceId,
        maxDuration: 60,
        outputName: "short",
      })
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
      })
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

  test("android recording > 180s starts a segmented session and stop returns segments", async () => {
    const startRes = parse(
      await handler()(androidDevice, {
        action: "start",
        platform: "android",
        deviceId: androidDevice.deviceId,
        maxDuration: 400,
        outputName: "vid",
      })
    );

    expect(startRes.count).toBe(1);
    const started = (startRes.recordings as Array<Record<string, unknown>>)[0];
    expect(started.segmented).toBe(true);
    expect(started.outputName).toBe("vid");

    const handle = started.recordingId as string;
    const stopRes = parse(
      await handler()(androidDevice, {
        action: "stop",
        platform: "android",
        recordingId: handle,
      })
    );

    expect(stopRes.segmented).toBe(true);
    const stoppedSegments = stopRes.recordings as Array<Record<string, unknown>>;
    // No timer rotation occurred, so exactly the first segment is returned.
    expect(stoppedSegments.length).toBe(1);
    expect(stoppedSegments[0].recordingId).toBe(handle);
    expect(typeof stoppedSegments[0].filePath).toBe("string");
  });

  test("bare (by-device) stop finalizes the segmented session and leaves no rotation timer", async () => {
    setSegmentedSessionRecordingDependencies({
      startVideoRecording: async request => {
        const outputName = request.outputName;
        const recordingId = outputName ?? `segment-${segmentStarts.length}`;
        segmentStarts.push(recordingId);
        return makeSegmentRecording(recordingId, outputName);
      },
      stopVideoRecording: async recordingId => {
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
      })
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
      async () =>
        segmentStarts.length === 2 &&
        segmentStops.length === 1,
      "segment 2 to start after rotation"
    );

    const stopRes = parse(
      await handler()(androidDevice, {
        action: "stop",
        platform: "android",
        // NO recordingId — bare, by-device stop.
      })
    );

    expect(stopRes.segmented).toBe(true);
    const segments = stopRes.recordings as Array<Record<string, unknown>>;
    expect(segments.length).toBe(2);
    expect(segments.every(segment => segment.segmented === true)).toBe(true);
    expect(typeof segments[0].filePath).toBe("string");
    expect(typeof segments[1].filePath).toBe("string");

    // Invariant: the rotation timer must not survive a bare stop.
    expect(segmentTimer.getPendingTimeoutCount()).toBe(0);

    // Advancing well past the rotation interval starts no new segment/recording.
    const segmentStartsBefore = segmentStarts.length;
    segmentTimer.advanceTime(ANDROID_PLAN_VIDEO_SEGMENT_ROTATE_MS * 3);
    await flush();
    expect(segmentStarts).toHaveLength(segmentStartsBefore);
  });

  test("maxDuration auto-stop removes the session so a later bare stop reports only fresh segments", async () => {
    setSegmentedSessionRecordingDependencies({
      startVideoRecording: async request => {
        const outputName = request.outputName;
        const recordingId = outputName ?? `segment-${segmentStarts.length}`;
        segmentStarts.push(recordingId);
        return makeSegmentRecording(recordingId, outputName);
      },
      stopVideoRecording: async recordingId => {
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
      async () => segmentStops.length === 2,
      "auto-stop to finalize both segments of the first session"
    );
    await flush();

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
      })
    );

    const segments = stopRes.recordings as Array<Record<string, unknown>>;
    expect(segments.length).toBe(1);
    expect(segments[0].recordingId).toBe("second");
    expect(
      segments.some(segment => String(segment.filePath).includes("first"))
    ).toBe(false);
  });

  test("by-handle stop still works after wiring the bare-stop path", async () => {
    const startRes = parse(
      await handler()(androidDevice, {
        action: "start",
        platform: "android",
        deviceId: androidDevice.deviceId,
        maxDuration: 300,
        outputName: "vid",
      })
    );
    const handle = (startRes.recordings as Array<Record<string, unknown>>)[0].recordingId as string;

    const stopRes = parse(
      await handler()(androidDevice, {
        action: "stop",
        platform: "android",
        recordingId: handle,
      })
    );

    expect(stopRes.segmented).toBe(true);
    expect((stopRes.recordings as unknown[]).length).toBe(1);
    expect(segmentTimer.getPendingTimeoutCount()).toBe(0);
  });
});
