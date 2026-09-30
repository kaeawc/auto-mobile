import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseAndroidDeviceDisplays,
  parseAndroidPostures,
  readAndroidDeviceDisplays,
} from "../../../src/utils/android-cmdline-tools/AndroidDisplayInventory";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { createExecResult } from "../../../src/utils/execResult";

const fixture = (name: string): string =>
  readFileSync(join(import.meta.dir, "../../fixtures/android-display", name), "utf8");

describe("Android physical display inventory", () => {
  test("joins foldable physical IDs to dimensions and supported postures", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse(
      "dumpsys SurfaceFlinger --display-id",
      createExecResult(fixture("fold-surfaceflinger.txt"), ""),
    );
    adb.setCommandResponse(
      "cmd display get-displays",
      createExecResult(fixture("fold-displays.txt"), ""),
    );
    adb.setCommandResponse(
      "cmd device_state print-states",
      createExecResult(fixture("fold-states.txt"), ""),
    );

    expect(await readAndroidDeviceDisplays(adb)).toEqual({
      panels: [
        { key: "4619827259835644672", role: "inner", sizePx: { width: 2076, height: 2152 } },
        { key: "4619827259835644673", role: "cover", sizePx: { width: 1080, height: 2364 } },
      ],
      postures: ["closed", "half_opened", "opened", "rear_display"],
    });
    expect(adb.getExecutedCommands()).toEqual([
      "shell dumpsys SurfaceFlinger --display-id",
      "shell cmd display get-displays",
      "shell cmd device_state print-states",
    ]);
  });

  test("omits a single-display phone", () => {
    expect(
      parseAndroidDeviceDisplays(
        fixture("phone-surfaceflinger.txt"),
        fixture("phone-displays.txt"),
        fixture("phone-states.txt"),
      ),
    ).toBeUndefined();
  });

  test("maps vendor state names and retains unknown states", () => {
    expect(
      parseAndroidPostures(
        "Supported states: [\nDeviceState{identifier=0, name='TENT'}\nDeviceState{identifier=1, name='MYSTERY'}\n]",
      ),
    ).toEqual(["tent", "unknown"]);
  });

  test("ignores logical and virtual displays without physical IDs", () => {
    expect(
      parseAndroidDeviceDisplays(
        fixture("phone-surfaceflinger.txt"),
        fixture("phone-displays.txt") +
          '\n  Display id 2: DisplayInfo{"External", real 1920 x 1080, type VIRTUAL, uniqueId "virtual:1234"}',
        fixture("phone-states.txt"),
      ),
    ).toBeUndefined();
  });

  test("labels a physical external display without treating it as a cover", () => {
    const physical =
      fixture("phone-surfaceflinger.txt") +
      'Display 4619827259835644679 (HWC display 1): port=1 pnpId=DEL displayName="External"\n';
    const infos =
      fixture("phone-displays.txt") +
      '  Display id 2: DisplayInfo{"External", real 1920 x 1080, type EXTERNAL, uniqueId "local:4619827259835644679"}\n';
    expect(parseAndroidDeviceDisplays(physical, infos, "Supported states: []")?.panels).toEqual([
      { key: "4619827259835644672", role: "unknown", sizePx: { width: 1080, height: 2400 } },
      { key: "4619827259835644679", role: "external", sizePx: { width: 1920, height: 1080 } },
    ]);
  });
});
