import { expect, test } from "bun:test";
import { DefaultFeatureFlagApplier } from "../../../src/features/featureFlags/FeatureFlagApplier";
import { serverConfig } from "../../../src/utils/ServerConfig";

test("AXBridge runtime flag follows the existing applier path", () => {
  const original = serverConfig.isIosAxBridgeEnabled();
  try {
    const applier = new DefaultFeatureFlagApplier();
    applier.apply("ios-axbridge", true);
    expect(serverConfig.isIosAxBridgeEnabled()).toBe(true);
    applier.apply("ios-axbridge", false);
    expect(serverConfig.isIosAxBridgeEnabled()).toBe(false);
  } finally {
    serverConfig.setIosAxBridgeEnabled(original);
  }
});
