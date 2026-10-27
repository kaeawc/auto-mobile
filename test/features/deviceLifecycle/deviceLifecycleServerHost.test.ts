import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  deviceLifecycleServerHost,
  registerDeviceLifecycleServerHost,
  type DeviceLifecycleServerHost,
} from "../../../src/features/deviceLifecycle/deviceLifecycleServerHost";

class RecordingHost implements DeviceLifecycleServerHost {
  readonly calls: string[] = [];
  async notifyBootedDeviceResourcesUpdated(): Promise<void> {
    this.calls.push("booted");
  }
  async notifyDeviceImageResourcesUpdated(): Promise<void> {
    this.calls.push("images");
  }
  async notifyInstalledAppResourceListChanged(): Promise<void> {
    this.calls.push("appList");
  }
  async syncInstalledAppResourceRegistry(): Promise<boolean> {
    this.calls.push("syncRegistry");
    return true;
  }
  async syncInstalledAppResources(): Promise<void> {
    this.calls.push("syncResources");
  }
  async listActiveVideoRecordings(filter: { deviceId?: string }) {
    this.calls.push(`list:${filter.deviceId}`);
    return [{ recordingId: "rec-1" }];
  }
  async stopVideoRecording(recordingId?: string): Promise<unknown> {
    this.calls.push(`stop:${recordingId}`);
    return undefined;
  }
  async stopSegmentedVideoRecordingsForDevice(
    device: Parameters<DeviceLifecycleServerHost["stopSegmentedVideoRecordingsForDevice"]>[0],
  ): Promise<void> {
    this.calls.push(`segmented:${device.deviceId}`);
  }
}

describe("deviceLifecycleServerHost", () => {
  // Capture at test time: the server registers its host when its modules load, which in a
  // shared test process can happen after this file is collected.
  let previous: DeviceLifecycleServerHost | undefined;
  beforeEach(() => {
    previous = registerDeviceLifecycleServerHost(undefined);
  });
  afterEach(() => {
    registerDeviceLifecycleServerHost(previous);
  });

  it("refuses with an actionable error before a host is registered", async () => {
    await expect(deviceLifecycleServerHost.notifyBootedDeviceResourcesUpdated()).rejects.toThrow(
      "No device lifecycle server host is registered",
    );
  });

  it("delegates to the host registered later, on every call", async () => {
    const host = new RecordingHost();
    registerDeviceLifecycleServerHost(host);
    await deviceLifecycleServerHost.notifyBootedDeviceResourcesUpdated();
    expect(await deviceLifecycleServerHost.syncInstalledAppResourceRegistry()).toBe(true);
    expect(await deviceLifecycleServerHost.listActiveVideoRecordings({ deviceId: "d1" })).toEqual([
      { recordingId: "rec-1" },
    ]);
    await deviceLifecycleServerHost.stopVideoRecording("rec-1");
    expect(host.calls).toEqual(["booted", "syncRegistry", "list:d1", "stop:rec-1"]);
  });
});
