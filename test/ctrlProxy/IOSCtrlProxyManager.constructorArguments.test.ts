import { afterEach, expect, test } from "bun:test";
import { IOSCtrlProxyManager } from "../../src/ctrlProxy/IOSCtrlProxyManager";
import { IosCtrlProxyBuilder } from "../../src/ctrlProxy/IosCtrlProxyBuilder";
import { XcodeSigningManager } from "../../src/utils/ios-cmdline-tools/XcodeSigning";
import { DeviceAppManager } from "../../src/utils/ios-cmdline-tools/DeviceAppManager";
import { XcodebuildClient } from "../../src/utils/ios-cmdline-tools/XcodebuildClient";
import { DefaultHostCommandExecutor } from "../../src/utils/HostCommandExecutor";
import { TcpHostPortAvailabilityChecker } from "../../src/ctrlProxy/ios/IOSHostPortAvailabilityChecker";
import { IosCtrlProxyProcessClient } from "../../src/ctrlProxy/ios/IosCtrlProxyProcessClient";
import { defaultTimer } from "../../src/utils/SystemTimer";
import { PortManager } from "../../src/utils/PortManager";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeProcessExecutor } from "../fakes/FakeProcessExecutor";
import type { BootedDevice } from "../../src/models";

const device: BootedDevice = { platform: "ios", deviceId: "fake-constructor", name: "Fake" };
afterEach(() => {
  IOSCtrlProxyManager.resetInstances();
  PortManager.reset();
  PortManager.setPortAvailabilityCheckerForTesting(null);
});

test("singleton construction applies undefined dependency defaults", () => {
  PortManager.setPortAvailabilityCheckerForTesting({ isPortAvailable: () => true });
  const manager = IOSCtrlProxyManager.getInstance(device, undefined);
  expect(manager["device"]).toBe(device);
  expect(manager["timer"]).toBe(defaultTimer);
  expect(manager["builder"]).toBe(IosCtrlProxyBuilder.getInstance());
  expect(manager["processExecutor"]).toBeInstanceOf(DefaultHostCommandExecutor);
  expect(manager["signingManager"]).toBeInstanceOf(XcodeSigningManager);
  expect(manager["deviceAppManager"]).toBeInstanceOf(DeviceAppManager);
  expect(manager["hostPortAvailabilityChecker"]).toBeInstanceOf(TcpHostPortAvailabilityChecker);
  expect(manager["xcodebuild"]).toBeInstanceOf(XcodebuildClient);
  expect(manager["processClient"]).toBeInstanceOf(IosCtrlProxyProcessClient);
  expect(manager["remoteRunner"].isEnabled()).toBe(false);
  expect(manager.getServicePort()).toBe(8765);
});

test("test construction preserves injected dependencies and defaults undefined fields", () => {
  PortManager.setPortAvailabilityCheckerForTesting({ isPortAvailable: () => true });
  const timer = new FakeTimer();
  const executor = new FakeProcessExecutor();
  const signing = new XcodeSigningManager();
  const apps = new DeviceAppManager();
  const ports = { isAvailable: async () => true };
  const manager = IOSCtrlProxyManager.createForTestingWithDeps(
    device,
    timer,
    undefined,
    executor,
    signing,
    apps,
    undefined,
    ports,
    undefined,
    undefined,
  );
  expect(manager["timer"]).toBe(timer);
  expect(manager["processExecutor"]).toBe(executor);
  expect(manager["signingManager"]).toBe(signing);
  expect(manager["deviceAppManager"]).toBe(apps);
  expect(manager["hostPortAvailabilityChecker"]).toBe(ports);
  expect(manager["builder"]).toBe(IosCtrlProxyBuilder.getInstance());
  expect(manager["xcodebuild"]).toBeInstanceOf(XcodebuildClient);
  expect(manager["processClient"]).toBeInstanceOf(IosCtrlProxyProcessClient);
  expect(manager["remoteRunner"].isEnabled()).toBe(false);
  expect(executor.getExecutedCommands()).toEqual([]);
  expect(timer.getPendingTimeoutCount()).toBe(0);
});
