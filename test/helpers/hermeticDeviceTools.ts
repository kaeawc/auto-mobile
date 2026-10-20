import { ToolRegistry } from "../../src/server/toolRegistry";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
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
