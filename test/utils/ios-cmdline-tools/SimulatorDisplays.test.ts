import { describe, expect, test } from "bun:test";
import {
  findCarPlayScreen,
  parseSimulatorDisplays,
  parseSimulatorScreens,
  simulatorDeviceDisplays,
  selectLiveSimulatorDisplay,
} from "../../../src/utils/ios-cmdline-tools/SimulatorDisplays";
import { loadDuoEnumerate } from "../../fixtures/loadDuoEnumerate";

const duoEnumerate = loadDuoEnumerate();
const singleEnumerate = duoEnumerate.replace(
  /    \(3\) LCD-1:\n[\s\S]*?(?=    \(5\) Resizable:)/,
  "",
);

const integratedOnlyEnumerate = duoEnumerate.replace(
  /    \(\d+\) (?:TVOut|Resizable|Wireless):\n[\s\S]*?(?=    \(\d+\) |\n\nPort:)/g,
  "",
);
const duplicateCarPlayEnumerate = duoEnumerate.replace(
  /(    \(4\) Wireless:\n[\s\S]*?)(?=\n\nPort:)/,
  (block: string) =>
    `${block}\n${block.replace("(4) Wireless:", "(6) Wireless:").replace("wireless0", "wireless1")}`,
);

const carPlayScreen = {
  screenType: "CarPlay",
  id: "4",
  name: "wireless0",
  width: 720,
  height: 480,
  uiScale: 1,
};

describe("simctl display discovery", () => {
  test("keeps only the two Integrated screens from the captured Duo output", () => {
    const displays = parseSimulatorDisplays(duoEnumerate);
    expect(displays).toEqual([
      {
        id: "1",
        name: "primary",
        width: 1398,
        height: 2034,
        uiScale: 3,
        uiOrientation: "Portrait",
      },
      {
        id: "3",
        name: "primary-1",
        width: 2007,
        height: 2853,
        uiScale: 3,
        uiOrientation: "Portrait",
      },
    ]);
    expect(selectLiveSimulatorDisplay(displays, 1398, 2034)?.name).toBe("primary");
    expect(selectLiveSimulatorDisplay(displays, 2034, 1398)?.name).toBe("primary");
    expect(selectLiveSimulatorDisplay(displays, 2007, 2853)?.name).toBe("primary-1");
    expect(selectLiveSimulatorDisplay(displays, 2853, 2007)?.name).toBe("primary-1");
    expect(
      simulatorDeviceDisplays(displays, "com.apple.CoreSimulator.SimDeviceType.iPhone-Duo"),
    ).toEqual({
      panels: [
        { key: "primary", role: "cover", sizePx: { width: 1398, height: 2034 }, scale: 3 },
        { key: "primary-1", role: "inner", sizePx: { width: 2007, height: 2853 }, scale: 3 },
      ],
      postures: ["closed", "half_opened", "opened"],
    });
    expect(simulatorDeviceDisplays(displays)?.panels.map((panel) => panel.role)).toEqual([
      "unknown",
      "unknown",
    ]);
  });

  test("parses one Integrated screen when the LCD-1 block is removed", () => {
    expect(singleEnumerate).not.toBe(duoEnumerate);
    const displays = parseSimulatorDisplays(singleEnumerate);
    expect(displays).toEqual([
      {
        id: "1",
        name: "primary",
        width: 1398,
        height: 2034,
        uiScale: 3,
        uiOrientation: "Portrait",
      },
    ]);
    expect(selectLiveSimulatorDisplay(displays, 2007, 2853)).toBeNull();
    expect(simulatorDeviceDisplays(displays)).toBeUndefined();
  });

  test("rejects an unknown or ambiguous live size", () => {
    const displays = parseSimulatorDisplays(duoEnumerate);
    expect(selectLiveSimulatorDisplay(displays, 1, 1)).toBeNull();
    expect(selectLiveSimulatorDisplay([...displays, displays[0]], 1398, 2034)).toBeNull();
  });

  test("keeps the integrated list identical and the other screens as auxiliary", () => {
    const screens = parseSimulatorScreens(duoEnumerate);
    expect(screens.integrated).toEqual(parseSimulatorDisplays(duoEnumerate));
    expect(screens.auxiliary).toEqual([
      { screenType: "TVOut", id: "2", name: "external-0", width: 720, height: 480, uiScale: 1 },
      { screenType: "Scene", id: "5", name: "resizable", width: 7680, height: 4320, uiScale: 3 },
      carPlayScreen,
    ]);
  });

  test("finds the single CarPlay screen with its display key", () => {
    expect(findCarPlayScreen(parseSimulatorScreens(duoEnumerate).auxiliary)).toEqual(carPlayScreen);
  });

  test("reports no CarPlay screen for integrated-only output", () => {
    const screens = parseSimulatorScreens(integratedOnlyEnumerate);
    expect(integratedOnlyEnumerate).not.toContain("Screen Type: CarPlay");
    expect(screens.integrated).toEqual(parseSimulatorDisplays(duoEnumerate));
    expect(screens.auxiliary).toEqual([]);
    expect(findCarPlayScreen(screens.auxiliary)).toBeNull();
  });

  test("refuses to pick between two CarPlay screens", () => {
    const screens = parseSimulatorScreens(duplicateCarPlayEnumerate);
    expect(screens.auxiliary.map((screen) => screen.name)).toEqual([
      "external-0",
      "resizable",
      "wireless0",
      "wireless1",
    ]);
    expect(findCarPlayScreen(screens.auxiliary)).toBeNull();
  });

  test("refuses a CarPlay screen that has no display key", () => {
    expect(findCarPlayScreen([{ ...carPlayScreen, name: null }])).toBeNull();
  });
});
