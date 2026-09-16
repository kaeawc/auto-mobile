import { expect, test } from "bun:test";
import { registerAppTools } from "../../src/server/appTools";
import { ToolRegistry } from "../../src/server/toolRegistry";

test("installApp requires only a booted device, not CtrlProxy automation", () => {
  const registry = ToolRegistry as any;
  const originalRegister = registry.registerDeviceAware;
  let installReadiness: string | undefined;

  registry.registerDeviceAware = (...args: any[]) => {
    if (args[0] === "installApp") {
      installReadiness = args[4]?.deviceReadiness;
    }
  };

  try {
    registerAppTools();
  } finally {
    registry.registerDeviceAware = originalRegister;
  }

  expect(installReadiness).toBe("booted");
});
