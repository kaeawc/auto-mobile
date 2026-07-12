import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import { promises as fsPromises } from "node:fs";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeVideoCaptureBackend } from "../fakes/FakeVideoCaptureBackend";
import { FakeHighlightClient } from "../fakes/FakeHighlightClient";
import { FakeVideoRecordingRepository } from "../fakes/FakeVideoRecordingRepository";
import { FakeVideoRecordingConfigRepository } from "../fakes/FakeVideoRecordingConfigRepository";
import { VideoRecorderService } from "../../src/features/video";
import {
  registerVideoRecordingTools,
  resetSegmentedSessions,
  setSegmentedSessionTimer,
} from "../../src/server/videoRecordingTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import {
  resetVideoRecordingManagerDependencies,
  setVideoRecordingManagerDependencies,
} from "../../src/server/videoRecordingManager";
import { ANDROID_PLAN_VIDEO_SEGMENT_ROTATE_MS } from "../../src/features/video/androidScreenrecord";
import { defaultTimer } from "../../src/utils/SystemTimer";
import type { BootedDevice } from "../../src/models";

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
    // The rotation timer is armed on the session's (injected) timer.
    expect(segmentTimer.getPendingTimeoutCount()).toBe(1);

    // Rotate once so the bare stop must return more than one segment, in order.
    segmentTimer.advanceTime(ANDROID_PLAN_VIDEO_SEGMENT_ROTATE_MS);
    await waitFor(
      async () =>
        (await fakeRepository.listRecordings()).length === 2 &&
        (await fakeRepository.listRecordings({ status: "recording" })).length === 1,
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
    const activeBefore = (await fakeRepository.listRecordings({ status: "recording" })).length;
    segmentTimer.advanceTime(ANDROID_PLAN_VIDEO_SEGMENT_ROTATE_MS * 3);
    await flush();
    const activeAfter = (await fakeRepository.listRecordings({ status: "recording" })).length;
    expect(activeBefore).toBe(0);
    expect(activeAfter).toBe(0);
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
