import { spyOn } from "bun:test";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import { AndroidCtrlProxyManager } from "../../src/ctrlProxy/CtrlProxyManager";
import { FakeAdbClientFactory } from "../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeDisplayInventoryProvider } from "../fakes/FakeDisplayInventoryProvider";

/** Keep incidental resource discovery and execution-target hydration off the host. */
export function installFakeDeviceToolProviders(): () => void {
  const previousInstance = Reflect.get(PlatformDeviceManagerFactory, "instance");
  const previousInjectedManager = Reflect.get(PlatformDeviceManagerFactory, "injectedManager");
  PlatformDeviceManagerFactory.setInstance(new FakeDeviceManager());
  const restorePipeline = ToolRegistry.setPipelineOverridesForTesting({
    displayInventory: new FakeDisplayInventoryProvider(),
  });
  return () => {
    restorePipeline();
    Reflect.set(PlatformDeviceManagerFactory, "injectedManager", previousInjectedManager);
    Reflect.set(PlatformDeviceManagerFactory, "instance", previousInstance);
  };
}

/** The client constructor creates a manager independently of its injected ADB executor. */
export function installFakeCtrlProxyManagers(): () => void {
  const previousInstances = new Map<string, AndroidCtrlProxyManager>(
    Reflect.get(AndroidCtrlProxyManager, "instances"),
  );
  const previousFactory = Reflect.get(AndroidCtrlProxyManager, "adbFactory");
  const factory = new FakeAdbClientFactory(new FakeAdbExecutor());
  const getInstance = AndroidCtrlProxyManager.getInstance.bind(AndroidCtrlProxyManager);
  const managerSpy = spyOn(AndroidCtrlProxyManager, "getInstance").mockImplementation(
    (device, adbFactoryOrExecutor) => getInstance(device, adbFactoryOrExecutor ?? factory),
  );
  return () => {
    managerSpy.mockRestore();
    Reflect.set(AndroidCtrlProxyManager, "instances", previousInstances);
    Reflect.set(AndroidCtrlProxyManager, "adbFactory", previousFactory);
  };
}
