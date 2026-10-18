import { describe, expect, test } from "bun:test";
import type { BootedDevice, ObserveResult } from "../../../../src/models";
import { platformObservationTraits } from "../../../../src/features/observe/collectors/PlatformObservationTraits";

type Panel = NonNullable<BootedDevice["displays"]>["panels"][number];

function device(platform: BootedDevice["platform"], panelCount?: number): BootedDevice {
  const panels = Array.from({ length: panelCount ?? 0 }, (_, i) => ({ key: `p${i}` }) as Panel);
  return {
    name: "d",
    deviceId: "d1",
    platform,
    ...(panelCount === undefined ? {} : { displays: { panels } as BootedDevice["displays"] }),
  };
}

describe("platformObservationTraits", () => {
  test("android reports physical pixels and display orientation", () => {
    const d = device("android", 2);
    const traits = platformObservationTraits(d.platform, () => d);
    expect(traits.screenSizeUnits()).toBe("physical-pixels");
    expect(traits.settledScreenshotOrientation()).toBe("display");
    expect(traits.isIosMultiPanel()).toBe(false);
  });

  test("ios reports points and native orientation", () => {
    const d = device("ios");
    const traits = platformObservationTraits(d.platform, () => d);
    expect(traits.screenSizeUnits()).toBe("points");
    expect(traits.settledScreenshotOrientation()).toBe("native");
  });

  test("ios multi-panel needs more than one panel and reads the device lazily", () => {
    let current = device("ios", 1);
    const traits = platformObservationTraits("ios", () => current);
    expect(traits.isIosMultiPanel()).toBe(false);
    current = device("ios", 2);
    expect(traits.isIosMultiPanel()).toBe(true);
  });
});

describe("grantsObservationRead", () => {
  const stale = { viewHierarchy: { fresh: false } } as ObserveResult;
  const fresh = { viewHierarchy: { fresh: true } } as ObserveResult;

  test("android grants only a fresh hierarchy", () => {
    const d = device("android");
    const traits = platformObservationTraits(d.platform, () => d);
    expect(traits.grantsObservationRead(fresh)).toBe(true);
    expect(traits.grantsObservationRead(stale)).toBe(false);
    expect(traits.grantsObservationRead({} as ObserveResult)).toBe(false);
  });

  test("an unrecognised platform always grants", () => {
    const d = device("windows" as BootedDevice["platform"]);
    expect(platformObservationTraits(d.platform, () => d).grantsObservationRead(stale)).toBe(true);
  });
});
