import { describe, expect, test } from "bun:test";
import type { BootedDevice } from "../../../src/models";
import { DisplayConfig } from "../../../src/features/utility/DisplayConfig";
import { DefaultDeviceSettingsAccess } from "../../../src/features/utility/DeviceSettingDefaults";
import {
  IOS_CONTENT_SIZE_CATEGORIES,
  IosSimulatorDisplayConfig,
  contentSizeFontScale,
  contentSizeForFontScale,
  nearestContentSize,
  type IosContentSizeCategory,
} from "../../../src/features/utility/IosSimulatorDisplayConfig";
import type { SimCtl } from "../../../src/utils/ios-cmdline-tools/SimCtlClient";
import { createExecResult } from "../../../src/utils/execResult";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";

type SimctlRunner = Pick<SimCtl, "executeCommandArgs">;

const simulator: BootedDevice = {
  name: "iPhone 16",
  platform: "ios",
  deviceId: "12345678-1234-1234-1234-123456789ABC",
};

const physical: BootedDevice = { ...simulator, deviceId: "00008130-001234567890ABCD" };

/** A Simulator whose `simctl ui appearance` and `content_size` read back what was written. */
class FakeUiSimctl implements SimctlRunner {
  appearance = "light";
  contentSize = "large";
  /** Accept content_size writes without changing the category. */
  ignoreContentSizeWrites = false;
  readonly calls: string[][] = [];

  executeCommandArgs: SimctlRunner["executeCommandArgs"] = async (args) => {
    this.calls.push(args);
    const [, , verb, value] = args;
    if (verb === "appearance") {
      this.appearance = value ?? this.appearance;
      return createExecResult(`${this.appearance}\n`, "");
    }
    if (verb === "content_size") {
      if (value !== undefined && !this.ignoreContentSizeWrites) {
        // simctl reports this spelling after a fontScale 0.8 write (captured in issue #14736).
        this.contentSize = value === "extra-small" ? "extra-Small" : value;
      }
      return createExecResult(`${this.contentSize}\n`, "");
    }
    throw new Error(`unexpected simctl ${args.join(" ")}`);
  };

  writes(): string[][] {
    return this.calls.filter((args) => args.length > 3);
  }
}

function simulatorConfig(
  simctl: FakeUiSimctl,
  baselines = new Map<string, IosContentSizeCategory>(),
) {
  return new DisplayConfig(simulator, {
    simctl,
    themeBaselines: new Map(),
    accessibilityBaselines: new Map(),
    contentSizeBaselines: baselines,
  });
}

describe("Dynamic Type category mapping (#14087)", () => {
  test("each category's font scale is its body size relative to large (17 pt)", () => {
    expect(IOS_CONTENT_SIZE_CATEGORIES.map(contentSizeFontScale)).toEqual([
      0.82, 0.88, 0.94, 1, 1.12, 1.24, 1.35, 1.65, 1.94, 2.35, 2.76, 3.12,
    ]);
  });

  test("a font scale selects the nearest category, ties going to the larger one", () => {
    expect(nearestContentSize(1)).toBe("large");
    expect(nearestContentSize(1.3)).toBe("extra-extra-extra-large");
    // 1.5 is exactly between extra-extra-extra-large (23 pt) and accessibility-medium (28 pt).
    expect(nearestContentSize(1.5)).toBe("accessibility-medium");
    expect(nearestContentSize(2)).toBe("accessibility-large");
    expect(nearestContentSize(0.1)).toBe("extra-small");
    expect(nearestContentSize(10)).toBe("accessibility-extra-extra-extra-large");
    expect(contentSizeForFontScale("default")).toBe("large");
  });

  test("every category maps back to itself through its own font scale", () => {
    for (const category of IOS_CONTENT_SIZE_CATEGORIES) {
      expect(nearestContentSize(contentSizeFontScale(category))).toBe(category);
    }
  });
});

describe("displayConfig font scale on the iOS Simulator (#14087)", () => {
  test("reads simctl's mixed-case extra-Small category as extra-small", async () => {
    const simctl = new FakeUiSimctl();
    simctl.contentSize = "extra-Small";

    const result = await simulatorConfig(simctl).getConfig();

    expect(result.success).toBe(true);
    expect(result.current).toMatchObject({ contentSize: "extra-small", fontScale: 0.82 });
    expect(result.supported.fontScale).toBe(true);
  });

  test("fontScale 0.8 reads back extra-Small and can then return to default", async () => {
    const simctl = new FakeUiSimctl();
    const config = simulatorConfig(simctl);

    const change = await config.setConfig({ fontScale: 0.8 });

    expect(change.success).toBe(true);
    expect(change.applied).toMatchObject({ contentSize: "extra-small", fontScale: 0.82 });
    expect(simctl.contentSize).toBe("extra-Small");

    const restored = await config.setConfig({ fontScale: "default" });

    expect(restored.success).toBe(true);
    expect(restored.previous?.contentSize).toBe("extra-small");
    expect(restored.applied).toMatchObject({ contentSize: "large", fontScale: 1 });
    expect(simctl.contentSize).toBe("large");
    expect(simctl.writes()).toEqual([
      ["ui", simulator.deviceId, "content_size", "extra-small"],
      ["ui", simulator.deviceId, "content_size", "large"],
    ]);
  });

  test("a read reports the content size category and its derived font scale", async () => {
    const simctl = new FakeUiSimctl();
    simctl.contentSize = "extra-large";

    const result = await simulatorConfig(simctl).getConfig();

    expect(result.success).toBe(true);
    expect(result.supported.fontScale).toBe(true);
    expect(result.current).toMatchObject({
      theme: "light",
      contentSize: "extra-large",
      fontScale: 1.12,
    });
  });

  test("fontScale applies the nearest larger category and returns a restorable previous", async () => {
    const simctl = new FakeUiSimctl();

    const result = await simulatorConfig(simctl).setConfig({ fontScale: 1.5 });

    expect(result.success).toBe(true);
    expect(simctl.contentSize).toBe("accessibility-medium");
    expect(result.previous).toEqual({ theme: "light", contentSize: "large" });
    expect(result.applied).toMatchObject({ contentSize: "accessibility-medium", fontScale: 1.65 });
    expect(simctl.writes()).toEqual([
      ["ui", simulator.deviceId, "content_size", "accessibility-medium"],
    ]);
  });

  test("contentSize applies exactly that category", async () => {
    const simctl = new FakeUiSimctl();

    const result = await simulatorConfig(simctl).setConfig({
      contentSize: "accessibility-extra-extra-extra-large",
    });

    expect(result.success).toBe(true);
    expect(result.applied?.contentSize).toBe("accessibility-extra-extra-extra-large");
  });

  test("reset restores the category captured before the first change", async () => {
    const simctl = new FakeUiSimctl();
    simctl.contentSize = "small";
    const baselines = new Map<string, IosContentSizeCategory>();

    await simulatorConfig(simctl, baselines).setConfig({ fontScale: 2 });
    await simulatorConfig(simctl, baselines).setConfig({ contentSize: "extra-large" });
    const result = await simulatorConfig(simctl, baselines).setConfig({ reset: true });

    expect(result.success).toBe(true);
    expect(simctl.contentSize).toBe("small");
    expect(simctl.appearance).toBe("light");
    expect(result.message).toContain("small");
    expect(baselines.size).toBe(0);
  });

  test("reset without a recorded category leaves the text size alone", async () => {
    const simctl = new FakeUiSimctl();
    simctl.contentSize = "extra-large";

    const result = await simulatorConfig(simctl).setConfig({ reset: true });

    expect(result.success).toBe(true);
    expect(simctl.writes()).toEqual([["ui", simulator.deviceId, "appearance", "light"]]);
  });

  test("a category the Simulator did not adopt fails and keeps the baseline for a retry", async () => {
    const simctl = new FakeUiSimctl();
    const baselines = new Map<string, IosContentSizeCategory>();
    await simulatorConfig(simctl, baselines).setConfig({ fontScale: 2 });
    simctl.ignoreContentSizeWrites = true;

    const result = await simulatorConfig(simctl, baselines).setConfig({ reset: true });

    expect(result.success).toBe(false);
    expect(result.error).toContain("content size remained accessibility-large");
    expect(baselines.get(simulator.deviceId)).toBe("large");
  });

  test("fontScale with contentSize is contradictory and touches nothing", async () => {
    const simctl = new FakeUiSimctl();

    const result = await simulatorConfig(simctl).setConfig({
      fontScale: 1.2,
      contentSize: "large",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("send one of them");
    expect(simctl.calls).toEqual([]);
  });

  test("physical iOS keeps the documented refusal", async () => {
    const simctl = new FakeUiSimctl();
    const config = new DisplayConfig(physical, { simctl, themeBaselines: new Map() });

    const result = await config.setConfig({ fontScale: 1.5 });

    expect(result.success).toBe(false);
    expect(result.supported.fontScale).toBe(false);
    expect(result.error).toContain("fontScale is not supported on iOS");
    expect(simctl.calls).toEqual([]);
  });

  test("contentSize is refused on Android before any adb command", async () => {
    const adbFactory = new FakeAdbClientFactory();
    const config = new DisplayConfig(
      { name: "Pixel", platform: "android", deviceId: "emulator-5554" },
      { adbFactory, themeBaselines: new Map() },
    );

    const result = await config.setConfig({ contentSize: "large" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("iOS Simulator");
    expect(adbFactory.getFakeClient().getCommandCalls()).toEqual([]);
  });
});

describe("IosSimulatorDisplayConfig restorable values", () => {
  test("reports theme and category but never the derived font scale", async () => {
    const simctl = new FakeUiSimctl();
    simctl.contentSize = "medium";

    const values = await new IosSimulatorDisplayConfig(
      simulator,
      simctl,
      new Map(),
    ).readRestorable();

    expect(values).toEqual({ theme: "light", contentSize: "medium" });
  });
});

describe("acquisition-time reset of the Simulator text size (#11145)", () => {
  test("DefaultDeviceSettingsAccess restores a recorded category without recording a baseline", async () => {
    const simctl = new FakeUiSimctl();
    simctl.contentSize = "accessibility-large";
    const access = new DefaultDeviceSettingsAccess(new FakeAdbClientFactory(), () => simctl);

    expect(await access.read(simulator, ["contentSize", "fontScale"])).toEqual({
      contentSize: "accessibility-large",
    });
    const written = await access.write(simulator, { contentSize: "large" });

    expect(written).toEqual(["contentSize"]);
    expect(simctl.contentSize).toBe("large");
  });
});
