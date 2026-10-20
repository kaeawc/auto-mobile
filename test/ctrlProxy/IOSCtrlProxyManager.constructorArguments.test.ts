import { afterEach, beforeEach, expect, test } from "bun:test";
import { IOSCtrlProxyManager } from "../../src/ctrlProxy/IOSCtrlProxyManager";
import { IosCtrlProxyBuilder } from "../../src/ctrlProxy/IosCtrlProxyBuilder";
import type { IosCtrlProxyBuilderSurface } from "../../src/ctrlProxy/IosCtrlProxyBuilderSurface";
import { fakeIosCtrlProxyBuilder } from "../helpers/iosCtrlProxyBuilderFake";
import { XcodeSigningManager } from "../../src/utils/ios-cmdline-tools/XcodeSigning";
import { DeviceAppManager } from "../../src/utils/ios-cmdline-tools/DeviceAppManager";
import {
  XcodebuildClient,
  type Xcodebuild,
} from "../../src/utils/ios-cmdline-tools/XcodebuildClient";
import { DefaultHostCommandExecutor } from "../../src/utils/HostCommandExecutor";
import { TcpHostPortAvailabilityChecker } from "../../src/ctrlProxy/ios/IOSHostPortAvailabilityChecker";
import { IosCtrlProxyProcessClient } from "../../src/ctrlProxy/ios/IosCtrlProxyProcessClient";
import { defaultTimer } from "../../src/utils/SystemTimer";
import { PortManager } from "../../src/utils/PortManager";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeProcessExecutor } from "../fakes/FakeProcessExecutor";
import type { BootedDevice } from "../../src/models";

const device: BootedDevice = { platform: "ios", deviceId: "fake-constructor", name: "Fake" };
function resetSingletons(): void {
  IOSCtrlProxyManager.resetInstances();
  PortManager.reset();
  PortManager.setPortAvailabilityCheckerForTesting(null);
}
// Reset before each test too: in the shared-process lane an earlier file can leave ports
// allocated in PortManager, which moves the default service port off 8765.
beforeEach(resetSingletons);
afterEach(resetSingletons);

test("singleton construction applies undefined dependency defaults", () => {
  PortManager.setPortAvailabilityCheckerForTesting({ isPortAvailable: () => true });
  const manager = IOSCtrlProxyManager.getInstance(device, undefined);
  expect(manager.diagnostics.device).toBe(device);
  expect(manager.diagnostics.timer).toBe(defaultTimer);
  expect(manager.diagnostics.builder).toBe(IosCtrlProxyBuilder.getInstance());
  expect(manager.diagnostics.processExecutor).toBeInstanceOf(DefaultHostCommandExecutor);
  expect(manager.diagnostics.signingManager).toBeInstanceOf(XcodeSigningManager);
  expect(manager.diagnostics.deviceAppManager).toBeInstanceOf(DeviceAppManager);
  expect(manager.diagnostics.hostPortAvailabilityChecker).toBeInstanceOf(
    TcpHostPortAvailabilityChecker,
  );
  expect(manager.diagnostics.xcodebuild).toBeInstanceOf(XcodebuildClient);
  expect(manager.diagnostics.processClient).toBeInstanceOf(IosCtrlProxyProcessClient);
  expect(manager.diagnostics.remoteRunner.isEnabled()).toBe(false);
  expect(manager.getServicePort()).toBe(8765);
});

test("test construction preserves injected dependencies and defaults undefined fields", () => {
  PortManager.setPortAvailabilityCheckerForTesting({ isPortAvailable: () => true });
  const timer = new FakeTimer();
  const executor = new FakeProcessExecutor();
  const signing = new XcodeSigningManager();
  const apps = new DeviceAppManager();
  const ports = { isAvailable: async () => true };
  const manager = IOSCtrlProxyManager.createForTestingWithDeps({
    device,
    timer,
    builder: undefined,
    processExecutor: executor,
    signingManager: signing,
    deviceAppManager: apps,
    remoteRunner: undefined,
    hostPortAvailabilityChecker: ports,
    xcodebuild: undefined,
    processClient: undefined,
  });
  expect(manager.diagnostics.timer).toBe(timer);
  expect(manager.diagnostics.processExecutor).toBe(executor);
  expect(manager.diagnostics.signingManager).toBe(signing);
  expect(manager.diagnostics.deviceAppManager).toBe(apps);
  expect(manager.diagnostics.hostPortAvailabilityChecker).toBe(ports);
  expect(manager.diagnostics.builder).toBe(IosCtrlProxyBuilder.getInstance());
  expect(manager.diagnostics.xcodebuild).toBeInstanceOf(XcodebuildClient);
  expect(manager.diagnostics.processClient).toBeInstanceOf(IosCtrlProxyProcessClient);
  expect(manager.diagnostics.remoteRunner.isEnabled()).toBe(false);
  expect(executor.getExecutedCommands()).toEqual([]);
  expect(timer.getPendingTimeoutCount()).toBe(0);
});

// An identity-only sentinel: every builder member throws if the constructor uses it.
function builderStub(): IosCtrlProxyBuilderSurface {
  return fakeIosCtrlProxyBuilder({});
}

test("test construction preserves every injected dependency", () => {
  PortManager.setPortAvailabilityCheckerForTesting({ isPortAvailable: () => true });
  const timer = new FakeTimer();
  const executor = new FakeProcessExecutor();
  const builder = builderStub();
  const signing: XcodeSigningManager = Object.create(null);
  const apps: DeviceAppManager = Object.create(null);
  const unexpectedOperation = () => {
    throw new Error("Constructor must not perform operations");
  };
  const remoteRunner: NonNullable<
    Parameters<typeof IOSCtrlProxyManager.createForTestingWithDeps>[0]["remoteRunner"]
  > = {
    isEnabled: () => false,
    isRunningInDocker: () => false,
    isAvailable: unexpectedOperation,
    getHost: unexpectedOperation,
    runIdeviceId: unexpectedOperation,
    runIdeviceInstaller: unexpectedOperation,
    runSimctl: unexpectedOperation,
    startIproxy: unexpectedOperation,
    stopIproxy: unexpectedOperation,
    getIproxyStatus: unexpectedOperation,
    start: unexpectedOperation,
    stop: unexpectedOperation,
    status: unexpectedOperation,
  };
  const ports = { isAvailable: unexpectedOperation };
  const xcodebuild: Xcodebuild = {
    executeCommand: unexpectedOperation,
    isAvailable: unexpectedOperation,
    startStreaming: unexpectedOperation,
  };
  const processClient = new IosCtrlProxyProcessClient(executor, timer);
  const manager = IOSCtrlProxyManager.createForTestingWithDeps({
    device,
    timer,
    builder,
    processExecutor: executor,
    signingManager: signing,
    deviceAppManager: apps,
    remoteRunner,
    hostPortAvailabilityChecker: ports,
    xcodebuild,
    processClient,
  });
  expect(manager.diagnostics.device).toBe(device);
  expect(manager.diagnostics.timer).toBe(timer);
  expect(manager.diagnostics.builder).toBe(builder);
  expect(manager.diagnostics.processExecutor).toBe(executor);
  expect(manager.diagnostics.signingManager).toBe(signing);
  expect(manager.diagnostics.deviceAppManager).toBe(apps);
  expect(manager.diagnostics.remoteRunner).toBe(remoteRunner);
  expect(manager.diagnostics.hostPortAvailabilityChecker).toBe(ports);
  expect(manager.diagnostics.xcodebuild).toBe(xcodebuild);
  expect(manager.diagnostics.processClient).toBe(processClient);
  expect(executor.getExecutedCommands()).toEqual([]);
  expect(executor.getSpawnedProcesses()).toEqual([]);
  expect(timer.getPendingTimeoutCount()).toBe(0);
});

test("createForTesting preserves the injected builder", () => {
  PortManager.setPortAvailabilityCheckerForTesting({ isPortAvailable: () => true });
  const timer = new FakeTimer();
  const builder = builderStub();
  const manager = IOSCtrlProxyManager.createForTesting(device, timer, builder);
  expect(manager.diagnostics.device).toBe(device);
  expect(manager.diagnostics.timer).toBe(timer);
  expect(manager.diagnostics.builder).toBe(builder);
  expect(timer.getPendingTimeoutCount()).toBe(0);
});
