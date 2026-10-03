import { preserveToolRegistry } from "./withTemporaryTool";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeDisplayInventoryProvider } from "../fakes/FakeDisplayInventoryProvider";

export function installHermeticServerFixture(): () => void {
  const restoreTools = preserveToolRegistry();
  const previousDeviceManager = PlatformDeviceManagerFactory.getInstance();
  PlatformDeviceManagerFactory.setInstance(new FakeDeviceManager());
  const restorePipeline = ToolRegistry.setPipelineOverridesForTesting({
    displayInventory: new FakeDisplayInventoryProvider(),
  });

  return () => {
    restorePipeline();
    restoreTools();
    PlatformDeviceManagerFactory.setInstance(previousDeviceManager);
  };
}
