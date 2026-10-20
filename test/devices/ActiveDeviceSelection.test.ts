import { describe, expect, test } from "bun:test";
import { ActiveDeviceSelection } from "../../src/devices/ActiveDeviceSelection";
import { DeviceReadiness } from "../../src/daemon/readiness/DeviceReadiness";
import { FakeDeviceClientProvider } from "../fakes/FakeDeviceClientProvider";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import type { BootedDevice } from "../../src/models";

const device = (deviceId: string): BootedDevice => ({
  deviceId,
  name: deviceId,
  platform: "android",
});

describe("ActiveDeviceSelection", () => {
  test("clearPinFor drops the pin only for the pinned device", () => {
    const selection = new ActiveDeviceSelection();
    selection.explicitDevicePin = device("a");
    selection.clearPinFor("b");
    expect(selection.explicitDevicePin?.deviceId).toBe("a");
    selection.clearPinFor("a");
    expect(selection.explicitDevicePin).toBeUndefined();
  });

  test("two DeviceReadiness instances do not share a current device or pin", () => {
    const first = DeviceReadiness.createInstance(
      new FakeDeviceClientProvider(new FakeAdbExecutor(), new FakeDeviceUtils()),
    );
    const second = DeviceReadiness.createInstance(
      new FakeDeviceClientProvider(new FakeAdbExecutor(), new FakeDeviceUtils()),
    );
    first.setCurrentDevice(device("emulator-5554"), "android");
    first.setExplicitDevicePin(device("emulator-5554"));
    expect(second.getCurrentDevice()).toBeUndefined();
    expect(second.getExplicitDevicePin()).toBeUndefined();
    expect(first.getCurrentDevice()?.deviceId).toBe("emulator-5554");
    first.clearExplicitDevicePin("emulator-5554");
    expect(first.getExplicitDevicePin()).toBeUndefined();
  });
});
