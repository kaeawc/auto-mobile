import { afterEach, describe, expect, test } from "bun:test";
import {
  registerDeviceLifecycleServerHost,
  type DeviceLifecycleServerHost,
} from "../../../../src/features/deviceLifecycle/deviceLifecycleServerHost";
import { stopVideoRecordingsBeforeShutdown } from "../../../../src/features/deviceLifecycle/teardown/shutdownPreparation";
import type { BootedDevice } from "../../../../src/models";
import { createPerformanceTracker } from "../../../../src/utils/PerformanceTracker";
import { FakeTimer } from "../../../fakes/FakeTimer";

let previous: DeviceLifecycleServerHost | undefined;

afterEach(() => {
  registerDeviceLifecycleServerHost(previous);
});

function arrange(device: BootedDevice) {
  const listed: Array<{ deviceId?: string; platform?: string }> = [];
  const stopped: Array<string | undefined> = [];
  previous = registerDeviceLifecycleServerHost({
    notifyBootedDeviceResourcesUpdated: async () => {},
    notifyDeviceImageResourcesUpdated: async () => {},
    notifyInstalledAppResourceListChanged: async () => {},
    syncInstalledAppResourceRegistry: async () => false,
    syncInstalledAppResources: async () => {},
    listActiveVideoRecordings: async (filter) => {
      listed.push(filter);
      return [{ recordingId: "rec-1" }];
    },
    stopVideoRecording: async (recordingId) => {
      stopped.push(recordingId);
    },
    stopSegmentedVideoRecordingsForDevice: async () => {},
  });
  const timer = new FakeTimer();
  const run = () =>
    stopVideoRecordingsBeforeShutdown(
      {
        device,
        timer,
        deadlineMs: timer.now() + 1000,
        timeoutMs: 1000,
        requestAbortSignal: undefined,
      },
      createPerformanceTracker(false, timer),
    );
  return { listed, stopped, run };
}

describe("stopVideoRecordingsBeforeShutdown (#16725)", () => {
  test("stops an Apple TV recording in order before the simulator shuts down", async () => {
    const { listed, stopped, run } = arrange({
      name: "Apple TV 4K",
      platform: "tvos",
      deviceId: "tv-udid",
    });
    await run();
    expect(listed).toEqual([{ deviceId: "tv-udid", platform: "tvos" }]);
    expect(stopped).toEqual(["rec-1"]);
  });

  test("a Vision Pro has no recordings to look up", async () => {
    const { listed, stopped, run } = arrange({
      name: "Apple Vision Pro",
      platform: "visionos",
      deviceId: "vision-udid",
    });
    await run();
    expect(listed).toEqual([]);
    expect(stopped).toEqual([]);
  });
});
