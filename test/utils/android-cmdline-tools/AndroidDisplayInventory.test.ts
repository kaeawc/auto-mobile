import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseAndroidDeviceDisplays,
  parseAndroidDeviceDisplayOutcome,
  parseAndroidDeviceStates,
  parseAndroidPostures,
  readAndroidDeviceDisplays,
  readAndroidDeviceDisplaysChecked,
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

  test("reports rejected display commands as degraded while preserving the wrapper", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse(
      "dumpsys SurfaceFlinger --display-id",
      createExecResult(fixture("fold-surfaceflinger.txt"), ""),
    );
    adb.setCommandResponse(
      "dumpsys display",
      createExecResult(fixture("fold-open-display-device-info.txt"), ""),
    );
    adb.setCommandError("dumpsys SurfaceFlinger --display-id", new Error("unavailable"));
    const checked = await readAndroidDeviceDisplaysChecked(adb);
    expect(checked.degraded).toBe(true);
    expect(checked.outcome).toEqual({
      kind: "unreadable",
      reason: "shell dumpsys SurfaceFlinger --display-id failed: unavailable",
    });
    expect((await readAndroidDeviceDisplays(adb))?.panels).toEqual(checked.displays?.panels);
  });

  test("an unsupported posture command does not degrade a successful panel read", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse(
      "dumpsys SurfaceFlinger --display-id",
      createExecResult(fixture("fold-surfaceflinger.txt"), ""),
    );
    adb.setCommandResponse(
      "dumpsys display",
      createExecResult(fixture("fold-open-display-device-info.txt"), ""),
    );
    adb.setCommandError("cmd device_state print-states", new Error("unsupported"));
    const checked = await readAndroidDeviceDisplaysChecked(adb);
    expect(checked.degraded).toBe(false);
    expect(checked.displays?.panels).toHaveLength(2);
  });

  test("omits a single-display phone", () => {
    expect(
      parseAndroidDeviceDisplayOutcome(
        fixture("phone-surfaceflinger.txt"),
        fixture("phone-display-device-info.txt"),
        fixture("phone-states.txt"),
      ),
    ).toEqual({ kind: "single" });
    expect(
      parseAndroidDeviceDisplays(
        fixture("phone-surfaceflinger.txt"),
        fixture("phone-display-device-info.txt"),
        fixture("phone-states.txt"),
      ),
    ).toBeUndefined();
  });

  test("marks empty executor output unreadable", async () => {
    const checked = await readAndroidDeviceDisplaysChecked(new FakeAdbExecutor());
    expect(checked.outcome).toEqual({
      kind: "unreadable",
      reason: "no matched physical display records",
    });
    expect(checked.degraded).toBe(false);
  });

  test("classifies the real fold capture as multi", () => {
    expect(
      parseAndroidDeviceDisplayOutcome(
        fixture("fold-surfaceflinger.txt"),
        fixture("fold-open-display-device-info.txt"),
        fixture("fold-states.txt"),
      ),
    ).toEqual({ kind: "multi" });
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
  // Overlay displays (`settings put global overlay_display_devices 1080x1920/320`) have no
  // SurfaceFlinger physical id; their display-service record carries `type OVERLAY` (#13138).
  const overlayRecord =
    '    DisplayDeviceInfo{"Overlay #1": uniqueId="overlay:1", 1080 x 1920, modeId 2, density 320, 320.0 x 320.0 dpi, touch NONE, rotation 0, type OVERLAY, state ON, FLAG_PRESENTATION}\n';

  test("adds an overlay display to a phone inventory under the overlay role", () => {
    const infos = fixture("phone-display-device-info.txt") + overlayRecord;
    expect(
      parseAndroidDeviceDisplayOutcome(
        fixture("phone-surfaceflinger.txt"),
        infos,
        fixture("phone-states.txt"),
      ),
    ).toEqual({ kind: "multi" });
    expect(
      parseAndroidDeviceDisplays(
        fixture("phone-surfaceflinger.txt"),
        infos,
        fixture("phone-states.txt"),
      )?.panels,
    ).toEqual([
      { key: "4619827259835644672", role: "unknown", sizePx: { width: 1080, height: 2400 } },
      { key: "overlay:1", role: "overlay", sizePx: { width: 1080, height: 1920 } },
    ]);
  });

  test("lists overlays after physical panels without changing fold roles", () => {
    expect(
      parseAndroidDeviceDisplays(
        fixture("fold-surfaceflinger.txt"),
        overlayRecord + fixture("dual-display-device-info.txt"),
        "Supported states: []",
      )?.panels,
    ).toEqual([
      { key: "4619827259835644672", role: "inner", sizePx: { width: 2256, height: 2504 } },
      { key: "4619827551948147201", role: "cover", sizePx: { width: 1080, height: 2520 } },
      { key: "overlay:1", role: "overlay", sizePx: { width: 1080, height: 1920 } },
    ]);
  });

  test("an overlay without a readable physical panel cannot establish an inventory", () => {
    expect(
      parseAndroidDeviceDisplayOutcome("", overlayRecord + overlayRecord, "Supported states: []"),
    ).toEqual({ kind: "unreadable", reason: "no matched physical display records" });
    expect(
      parseAndroidDeviceDisplays("", overlayRecord + overlayRecord, "Supported states: []"),
    ).toBeUndefined();
  });

  test("ignores an overlay: uniqueId whose record is not typed OVERLAY", () => {
    expect(
      parseAndroidDeviceDisplays(
        fixture("phone-surfaceflinger.txt"),
        fixture("phone-display-device-info.txt") +
          overlayRecord.replace("type OVERLAY", "type VIRTUAL"),
        fixture("phone-states.txt"),
      ),
    ).toBeUndefined();
  });
  // App-created virtual displays (`DisplayManager.createVirtualDisplay`) carry `type VIRTUAL`
  // and a `virtual:<package>,<uid>,<name>,<index>` uniqueId (#16462).
  const virtualRecord = (uniqueId: string) =>
    `    DisplayDeviceInfo{"Presentation": uniqueId="${uniqueId}", 1280 x 720, modeId 1, density 213, touch NONE, rotation 0, type VIRTUAL, owner com.example.app (uid 10123), state ON, FLAG_PRESENTATION}\n`;
  const appVirtual = virtualRecord("virtual:com.example.app,10123,Presentation,0");

  test("adds an app-created virtual display under the virtual role, after overlays", () => {
    const infos = fixture("phone-display-device-info.txt") + appVirtual + overlayRecord;
    expect(
      parseAndroidDeviceDisplayOutcome(fixture("phone-surfaceflinger.txt"), infos, ""),
    ).toEqual({ kind: "multi" });
    expect(
      parseAndroidDeviceDisplays(
        fixture("phone-surfaceflinger.txt"),
        infos,
        fixture("phone-states.txt"),
      )?.panels,
    ).toEqual([
      { key: "4619827259835644672", role: "unknown", sizePx: { width: 1080, height: 2400 } },
      { key: "overlay:1", role: "overlay", sizePx: { width: 1080, height: 1920 } },
      {
        key: "virtual:com.example.app:Presentation",
        role: "virtual",
        sizePx: { width: 1280, height: 720 },
      },
    ]);
  });

  test("leaves AutoMobile's own virtual displays out so recording does not change inventory", () => {
    for (const uniqueId of [
      "virtual:com.android.shell,2000,automobile-mirror,0",
      "virtual:dev.jasonpearson.automobile.ctrlproxy,10200,mirror,0",
    ]) {
      const infos = fixture("phone-display-device-info.txt") + virtualRecord(uniqueId);
      expect(
        parseAndroidDeviceDisplayOutcome(fixture("phone-surfaceflinger.txt"), infos, ""),
      ).toEqual({ kind: "single" });
      expect(
        parseAndroidDeviceDisplays(fixture("phone-surfaceflinger.txt"), infos, ""),
      ).toBeUndefined();
    }
  });

  test("keeps a virtual key stable across uid and index changes", () => {
    const panelsFor = (uniqueId: string) =>
      parseAndroidDeviceDisplays(
        fixture("phone-surfaceflinger.txt"),
        fixture("phone-display-device-info.txt") + virtualRecord(uniqueId),
        "",
      )?.panels.at(-1)?.key;
    expect(panelsFor("virtual:com.example.app,10123,Presentation,0")).toBe(
      panelsFor("virtual:com.example.app,10456,Presentation,3"),
    );
  });

  test("leaves out a virtual key two live displays share", () => {
    const infos =
      fixture("phone-display-device-info.txt") +
      appVirtual +
      virtualRecord("virtual:com.example.app,10123,Presentation,1");
    expect(
      parseAndroidDeviceDisplayOutcome(fixture("phone-surfaceflinger.txt"), infos, ""),
    ).toEqual({ kind: "single" });
  });

  test("a virtual display without a readable physical panel cannot establish an inventory", () => {
    expect(parseAndroidDeviceDisplays("", appVirtual + overlayRecord, "")).toBeUndefined();
  });
});
