import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseAndroidDeviceDisplays,
  parseAndroidDeviceStates,
  parseAndroidPostures,
  readAndroidDeviceDisplays,
} from "../../../src/utils/android-cmdline-tools/AndroidDisplayInventory";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { createExecResult } from "../../../src/utils/execResult";

const fixture = (name: string): string =>
  readFileSync(join(import.meta.dir, "../../fixtures/android-display", name), "utf8");

describe("Android physical display inventory", () => {
  test("finds both Pixel Fold panels when only the inner panel has a logical display", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse(
      "dumpsys SurfaceFlinger --display-id",
      createExecResult(fixture("fold-surfaceflinger.txt"), ""),
    );
    adb.setCommandResponse(
      "dumpsys display",
      createExecResult(fixture("fold-open-display-device-info.txt"), ""),
    );
    adb.setCommandResponse(
      "cmd device_state print-states",
      createExecResult(fixture("fold-states.txt"), ""),
    );

    expect(await readAndroidDeviceDisplays(adb)).toEqual({
      panels: [
        { key: "4619827259835644672", role: "inner", sizePx: { width: 2076, height: 2152 } },
        { key: "4619827551948147201", role: "cover", sizePx: { width: 1080, height: 2364 } },
      ],
      postures: ["closed", "half_opened", "opened", "rear_display"],
    });
    expect(adb.getExecutedCommands()).toEqual([
      "shell dumpsys SurfaceFlinger --display-id",
      "shell dumpsys display",
      "shell cmd device_state print-states",
    ]);
  });

  test("omits a single-display phone", () => {
    expect(
      parseAndroidDeviceDisplays(
        fixture("phone-surfaceflinger.txt"),
        fixture("phone-display-device-info.txt"),
        fixture("phone-states.txt"),
      ),
    ).toBeUndefined();
  });

  test("keeps the two-enabled-display rig working", () => {
    expect(
      parseAndroidDeviceDisplays(
        fixture("fold-surfaceflinger.txt"),
        fixture("dual-display-device-info.txt"),
        "Supported states: []",
      )?.panels,
    ).toEqual([
      { key: "4619827259835644672", role: "inner", sizePx: { width: 2256, height: 2504 } },
      { key: "4619827551948147201", role: "cover", sizePx: { width: 1080, height: 2520 } },
    ]);
  });

  test("maps vendor state names and retains unknown states", () => {
    expect(
      parseAndroidPostures(
        "Supported states: [\nDeviceState{identifier=0, name='TENT'}\nDeviceState{identifier=1, name='MYSTERY'}\n]",
      ),
    ).toEqual(["tent", "unknown"]);
  });

  test("parses physical state identifiers and posture names", () => {
    expect(
      parseAndroidDeviceStates(
        "Supported states: [\nDeviceState{identifier=0, name='CLOSED', app_accessible=true}\nDeviceState{identifier=7, name='HALF_OPENED', app_accessible=true}\n]",
      ),
    ).toEqual([
      { identifier: 0, name: "CLOSED", posture: "closed" },
      { identifier: 7, name: "HALF_OPENED", posture: "half_opened" },
    ]);
  });

  test("ignores logical and virtual displays without physical IDs", () => {
    expect(
      parseAndroidDeviceDisplays(
        fixture("phone-surfaceflinger.txt"),
        fixture("phone-display-device-info.txt") +
          '\n    DisplayDeviceInfo{"External", uniqueId="virtual:1234", 1920 x 1080, touch EXTERNAL, type VIRTUAL}',
        fixture("phone-states.txt"),
      ),
    ).toBeUndefined();
  });

  test("labels a physical external display without treating it as a cover", () => {
    const physical =
      fixture("phone-surfaceflinger.txt") +
      'Display 4619827259835644679 (HWC display 1): port=1 pnpId=DEL displayName="External"\n';
    const infos =
      fixture("phone-display-device-info.txt") +
      '    DisplayDeviceInfo{"External", uniqueId="local:4619827259835644679", 1920 x 1080, touch EXTERNAL, type EXTERNAL}\n';
    expect(parseAndroidDeviceDisplays(physical, infos, "Supported states: []")?.panels).toEqual([
      { key: "4619827259835644672", role: "unknown", sizePx: { width: 1080, height: 2400 } },
      { key: "4619827259835644679", role: "external", sizePx: { width: 1920, height: 1080 } },
    ]);
  });

  test("parses API 36 colon separators and punctuation inside display names", () => {
    const physical =
      'Display 4619827259835644672 (HWC display 0): port=0 pnpId=GOO displayName="Inner"\n' +
      'Display 4619827551948147201 (HWC display 1): port=1 pnpId=GOO displayName="Cover"\n';
    const infos = [
      'DisplayDeviceInfo{"Inner, Fold: OLED": uniqueId="local:4619827259835644672", 2076 x 2152, density 420, touch INTERNAL, type INTERNAL, FLAG_DEFAULT_DISPLAY}',
      'DisplayDeviceInfo{"Cover, Outer: OLED", uniqueId="local:4619827551948147201", 1080 x 2364, density 420, touch INTERNAL, type INTERNAL, FLAG_DEFAULT_DISPLAY}',
    ].join("\n");

    expect(parseAndroidDeviceDisplays(physical, infos, "Supported states: []")?.panels).toEqual([
      { key: "4619827259835644672", role: "inner", sizePx: { width: 2076, height: 2152 } },
      { key: "4619827551948147201", role: "cover", sizePx: { width: 1080, height: 2364 } },
    ]);
  });
});
