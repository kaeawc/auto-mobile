import { describe, expect, test } from "bun:test";
import {
  parseSimulatorDisplays,
  simulatorDeviceDisplays,
  selectLiveSimulatorDisplay,
} from "../../../src/utils/ios-cmdline-tools/SimulatorDisplays";
import { loadDuoEnumerate } from "../../fixtures/loadDuoEnumerate";

const duoEnumerate = loadDuoEnumerate();
const singleEnumerate = duoEnumerate.replace(
  /    \(3\) LCD-1:\n[\s\S]*?(?=    \(5\) Resizable:)/,
  "",
);

describe("simctl display discovery", () => {
  test("keeps only the two Integrated screens from the captured Duo output", () => {
    const displays = parseSimulatorDisplays(duoEnumerate);
    expect(displays).toEqual([
      { id: "1", name: "primary", width: 1398, height: 2034, uiScale: 3 },
      { id: "3", name: "primary-1", width: 2007, height: 2853, uiScale: 3 },
    ]);
    expect(selectLiveSimulatorDisplay(displays, 1398, 2034)?.name).toBe("primary");
    expect(selectLiveSimulatorDisplay(displays, 2034, 1398)?.name).toBe("primary");
    expect(selectLiveSimulatorDisplay(displays, 2007, 2853)?.name).toBe("primary-1");
    expect(
      simulatorDeviceDisplays(displays, "com.apple.CoreSimulator.SimDeviceType.iPhone-Duo"),
    ).toEqual({
      panels: [
        { key: "primary", role: "cover", sizePx: { width: 1398, height: 2034 }, scale: 3 },
        { key: "primary-1", role: "inner", sizePx: { width: 2007, height: 2853 }, scale: 3 },
      ],
      postures: ["unknown"],
    });
    expect(simulatorDeviceDisplays(displays)?.panels.map((panel) => panel.role)).toEqual([
      "unknown",
      "unknown",
    ]);
  });

  test("parses one Integrated screen when the LCD-1 block is removed", () => {
    expect(singleEnumerate).not.toBe(duoEnumerate);
    const displays = parseSimulatorDisplays(singleEnumerate);
    expect(displays).toEqual([{ id: "1", name: "primary", width: 1398, height: 2034, uiScale: 3 }]);
    expect(selectLiveSimulatorDisplay(displays, 2007, 2853)).toBeNull();
    expect(simulatorDeviceDisplays(displays)).toBeUndefined();
  });

  test("rejects an unknown or ambiguous live size", () => {
    const displays = parseSimulatorDisplays(duoEnumerate);
    expect(selectLiveSimulatorDisplay(displays, 1, 1)).toBeNull();
    expect(selectLiveSimulatorDisplay([...displays, displays[0]], 1398, 2034)).toBeNull();
  });
});
