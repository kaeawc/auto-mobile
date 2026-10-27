import { expect, mock, test } from "bun:test";
import {
  notifyResourcesUpdated,
  registerResourceUpdateNotifier,
} from "../../src/daemon/resourceUpdateNotifier";
import { defaultRecordingSessionCleanupDeps } from "../../src/daemon/recordingSessionCleanup";
import {
  registerSegmentedRecordingCleanup,
  segmentedRecordingCleanup,
  type SegmentedRecordingCleanup,
} from "../../src/daemon/segmentedRecordingCleanup";

test("recording resource updates await delivery and restore the previous notifier", async () => {
  await notifyResourcesUpdated(["automobile:video/latest"]);
  const previous = mock(async (_uris: string[]) => {});
  const restorePrevious = registerResourceUpdateNotifier(previous);
  const delivery = Promise.withResolvers<void>();
  const next = mock((_uris: string[]) => delivery.promise);
  const restoreNext = registerResourceUpdateNotifier(next);
  try {
    const uris = ["automobile:video/latest", "automobile:video/archive"];
    let delivered = false;
    const pending = notifyResourcesUpdated(uris).then(() => {
      delivered = true;
    });
    expect(next).toHaveBeenCalledWith(uris);
    expect(delivered).toBe(false);
    delivery.resolve();
    await pending;
    expect(delivered).toBe(true);
    restoreNext();
    await notifyResourcesUpdated(uris);
    expect(previous).toHaveBeenCalledWith(uris);
  } finally {
    restoreNext();
    restorePrevious();
  }
});

test("recording resource updates preserve delivery failures", async () => {
  const failure = new Error("delivery failed");
  const restore = registerResourceUpdateNotifier(async () => {
    throw failure;
  });
  try {
    await expect(notifyResourcesUpdated(["automobile:video/latest"])).rejects.toBe(failure);
  } finally {
    restore();
  }
});

test("prebuilt session cleanup dependencies resolve segmented operations after registration", async () => {
  const captureIds = () => ["segment-2"];
  const fake = {
    adoptOwnerlessSegmentedVideoRecordings: mock((_deviceId: string, _sessionUuid: string) => {}),
    hasSegmentedVideoRecordingsForOwner: mock(() => true),
    segmentedVideoRecordingHandlesForOwner: mock(() => ["segment-1"]),
    captureSegmentedRecordingIdsForOwner: mock(() => captureIds),
    stopSegmentedVideoRecordingsForOwner: mock(async () => {}),
    finalizeSegmentedVideoRecordingsForOwnerOnReplacedDevice: mock(async () => {}),
  } satisfies SegmentedRecordingCleanup;
  const restore = registerSegmentedRecordingCleanup(fake);
  try {
    defaultRecordingSessionCleanupDeps.hasRecordingsToStop("owner", "device");
    expect(fake.hasSegmentedVideoRecordingsForOwner).toHaveBeenCalledWith("owner", "device");
    expect(
      defaultRecordingSessionCleanupDeps.activeRecordingIdsForOwner("owner", "device"),
    ).toContain("segment-1");
    expect(
      defaultRecordingSessionCleanupDeps.captureSegmentedRecordingIdsForOwner?.("owner", "device"),
    ).toBe(captureIds);
    await defaultRecordingSessionCleanupDeps.stopSegmentedRecordings("owner", "device");
    expect(fake.stopSegmentedVideoRecordingsForOwner).toHaveBeenCalledWith("owner", "device");
    segmentedRecordingCleanup.adoptOwnerlessSegmentedVideoRecordings("device", "owner");
    expect(fake.adoptOwnerlessSegmentedVideoRecordings).toHaveBeenCalledWith("device", "owner");
    await segmentedRecordingCleanup.finalizeSegmentedVideoRecordingsForOwnerOnReplacedDevice(
      "owner",
      "device",
    );
    expect(fake.finalizeSegmentedVideoRecordingsForOwnerOnReplacedDevice).toHaveBeenCalledWith(
      "owner",
      "device",
    );
  } finally {
    restore();
  }
  expect(segmentedRecordingCleanup.hasSegmentedVideoRecordingsForOwner("owner", "device")).toBe(
    false,
  );
});
