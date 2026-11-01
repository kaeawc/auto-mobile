import { afterEach, beforeEach, expect, test } from "bun:test";
import type { BootedDevice } from "../../../src/models";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android/AndroidCtrlProxyClient";
import { IOSCtrlProxyClient } from "../../../src/features/observe/ios/IOSCtrlProxyClient";
import { ViewHierarchy } from "../../../src/features/observe/ViewHierarchy";
import { RealObserveScreen } from "../../../src/features/observe/ObserveScreen";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import { TapAnyElement } from "../../../src/features/action/TapAnyElement";
import { TapAtCoordinate } from "../../../src/features/action/TapAtCoordinate";
import { SwipeAtCoordinate } from "../../../src/features/action/SwipeAtCoordinate";
import { DragAndDrop } from "../../../src/features/action/DragAndDrop";
import { SwipeOn } from "../../../src/features/action/swipeon/SwipeOn";
import { LaunchApp } from "../../../src/features/action/LaunchApp";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeSimctl } from "../../fakes/FakeSimctl";

const device: BootedDevice = {
  deviceId: "8935BFAD-F01F-40FF-95E0-83FD0FF63DEB",
  platform: "ios",
  name: "iPhone",
};
const adb = new FakeAdbExecutor();
const timer = new FakeTimer();
const factory = new FakeAdbClientFactory(adb);
const constructors: [string, () => object][] = [
  ["ViewHierarchy", () => new ViewHierarchy(device, factory, null, { timer })],
  ["TapOnElement", () => new TapOnElement(device, adb, { timer })],
  ["TapAnyElement", () => new TapAnyElement(device, adb, { timer })],
  ["TapAtCoordinate", () => new TapAtCoordinate(device, adb, { timer })],
  ["SwipeAtCoordinate", () => new SwipeAtCoordinate(device, adb, { timer })],
  ["DragAndDrop", () => new DragAndDrop(device, adb, timer)],
  ["SwipeOn", () => new SwipeOn(device, adb, { timer })],
  ["LaunchApp", () => new LaunchApp(device, { adb, simctl: new FakeSimctl(), timer })],
  ["RealObserveScreen", () => new RealObserveScreen(device, factory, undefined, { timer })],
];
const clearRegistries = (): void => {
  AndroidCtrlProxyClient.clearInstanceRegistryForTesting();
  IOSCtrlProxyClient.clearInstanceRegistryForTesting();
};
beforeEach(clearRegistries);
afterEach(clearRegistries);
test.each(constructors)(
  "%s does not register a cross-platform Android client",
  (_name, construct) => {
    expect(construct()).toBeDefined();
    expect(AndroidCtrlProxyClient.getExistingInstance(device.deviceId)).toBeNull();
    expect(adb.getExecutedCommands()).toEqual([]);
  },
);
