import { afterEach, describe, expect, test } from "bun:test";
import { DefaultFeatureFlagApplier } from "../../../src/features/featureFlags/FeatureFlagApplier";
import { serverConfig } from "../../../src/utils/ServerConfig";

describe("accessibility flag configuration", () => {
  const applier = new DefaultFeatureFlagApplier();
  const original = serverConfig.getAccessibilityAuditConfig();

  afterEach(() => serverConfig.setAccessibilityAuditConfig(original));

  test.each([
    [5, 5],
    [9, 9],
    [13, 13],
    [0, 9],
    ["5", 9],
    [null, 9],
    [undefined, 9],
  ])("preserves contrast fields and validates sampling points %j", (samplingPoints, expected) => {
    applier.apply("accessibility-audit", true, {
      contrast: {
        samplingPoints,
        useMultiPointSampling: false,
        detectGradients: false,
        compositeOverlays: true,
        detectTextShadows: true,
      },
    });
    expect(serverConfig.getAccessibilityAuditConfig()?.contrast).toEqual({
      samplingPoints: expected,
      useMultiPointSampling: false,
      detectGradients: false,
      compositeOverlays: true,
      detectTextShadows: true,
    });
  });

  test.each([undefined, null, false, 1, "contrast", {}])(
    "uses defaults for absent or invalid contrast %j",
    (contrast) => {
      applier.apply("accessibility-audit", true, { contrast });
      expect(serverConfig.getAccessibilityAuditConfig()?.contrast).toEqual({
        samplingPoints: 9,
        useMultiPointSampling: true,
        detectGradients: true,
        compositeOverlays: false,
        detectTextShadows: false,
      });
    },
  );
});
