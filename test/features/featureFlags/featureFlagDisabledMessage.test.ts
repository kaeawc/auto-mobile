import { describe, expect, test } from "bun:test";
import {
  featureFlagDisabledMessage,
  IDE_FEATURE_FLAG_SETTINGS_PAGE,
} from "../../../src/features/featureFlags/featureFlagDisabledMessage";

describe("featureFlagDisabledMessage (#16906)", () => {
  test("names the tool, the flag, the exact CLI command and the IDE settings page", () => {
    expect(featureFlagDisabledMessage("device-condition", "deviceCondition")).toBe(
      "deviceCondition is behind the 'device-condition' feature flag, which is disabled. " +
        "Enable it with `auto-mobile --daemon set-feature-flag device-condition true` " +
        "or in the IDE plugin under Settings > AutoMobile > Feature Flags, then retry the call.",
    );
  });

  test("interpolates the key into the command for every flag", () => {
    const message = featureFlagDisabledMessage("debug", "setUIState");
    expect(message).toStartWith("setUIState is behind the 'debug' feature flag");
    expect(message).toContain("`auto-mobile --daemon set-feature-flag debug true`");
    expect(message).toContain(IDE_FEATURE_FLAG_SETTINGS_PAGE);
  });
});
