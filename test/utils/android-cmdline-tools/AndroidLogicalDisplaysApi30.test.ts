import { afterEach, describe, expect, test } from "bun:test";
import {
  AndroidDisplayListUnavailableError,
  readAndroidLogicalDisplays,
} from "../../../src/utils/android-cmdline-tools/AndroidLogicalDisplays";
import { parseDumpsysLogicalDisplays } from "../../../src/utils/android-cmdline-tools/AndroidDisplayParsers";
import { ObservedAndroidDisplayCache } from "../../../src/features/observe/ObservationDisplay";
import { AndroidDisplayReadError } from "../../../src/features/observe/AndroidDisplayReadError";
import { ActionableError } from "../../../src/models/ActionableError";
import type { BootedDevice, DisplayPanel } from "../../../src/models";
import { createExecResult } from "../../../src/utils/execResult";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../fakes/FakeTimer";

// Verbatim from the API 30 google_apis emulator capture in #17742 (exit 255; stdout is 30 bytes).
const API30_GET_DISPLAYS_STDOUT = "Unknown command: get-displays\n";
const API30_GET_DISPLAYS_ERROR =
  "Command failed: <local-path> -s emulator-5726 shell cmd display get-displays\n" +
  "exit code: 255\n" +
  "raw error: (last 4000 chars) Command failed: <local-path> -s emulator-5726 shell cmd display get-displays\n" +
  "stdout: (last 300 chars; 30 bytes)\n" +
  "Unknown command: get-displays";

// The Logical Displays section in the Android 11 LogicalDisplay.dumpLocked layout: it has no
// mIsEnabled line. Trimmed to the lines the parser reads; overlay set by
// `settings put global overlay_display_devices "1280x720/240"`.
const API30_DUMPSYS_DISPLAY = [
  "DISPLAY MANAGER (dumpsys display)",
  "  mSafeMode=false",
  "",
  "Logical Displays: size=2",
  "  Display 0:",
  "    mDisplayId=0",
  "    mLayerStack=0",
  "    mHasContent=true",
  '    mBaseDisplayInfo=DisplayInfo{"Built-in Screen, displayId 0", uniqueId "local:4619827259835644672", app 1080 x 1920, real 1080 x 1920, largest app 1080 x 1920, smallest app 1080 x 1920, type INTERNAL, address {port=0}, state ON}',
  '    mOverrideDisplayInfo=DisplayInfo{"Built-in Screen, displayId 0", uniqueId "local:4619827259835644672", app 1080 x 1794, real 1080 x 1920, type INTERNAL, state ON}',
  "  Display 1:",
  "    mDisplayId=1",
  "    mLayerStack=1",
  "    mHasContent=false",
  '    mBaseDisplayInfo=DisplayInfo{"Overlay #1, displayId 1", uniqueId "overlay:1", app 1280 x 720, real 1280 x 720, largest app 1280 x 720, smallest app 1280 x 720, type OVERLAY, state ON}',
  '    mOverrideDisplayInfo=DisplayInfo{"Overlay #1, displayId 1", uniqueId "overlay:1", app 1280 x 720, real 1280 x 720, type OVERLAY, state ON}',
  "",
  "DisplayModeDirector",
  "  mSupportedModesByDisplay:",
].join("\n");

const overlayPanel: DisplayPanel = {
  key: "overlay:1",
  role: "overlay",
  sizePx: { width: 1280, height: 720 },
};
const api30Device: BootedDevice = {
  deviceId: "emulator-5726",
  name: "api30",
  platform: "android",
  apiLevel: 30,
  displays: {
    panels: [
      { key: "4619827259835644672", role: "inner", sizePx: { width: 1080, height: 1920 } },
      overlayPanel,
    ],
    postures: [],
  },
};

function api30Adb(): FakeAdbExecutor {
  const adb = new FakeAdbExecutor();
  adb.setCommandError("cmd display get-displays", new Error(API30_GET_DISPLAYS_ERROR));
  adb.setCommandResponse("dumpsys display", createExecResult(API30_DUMPSYS_DISPLAY, ""));
  return adb;
}

describe("readAndroidLogicalDisplays without get-displays (API 30)", () => {
  test("an Unknown command failure falls back to the whole dumpsys logical list", async () => {
    const adb = api30Adb();
    const infos = await readAndroidLogicalDisplays(adb, [overlayPanel]);
    expect(infos.map((info) => [info.logicalId, info.uniqueId])).toEqual([
      ["0", "local:4619827259835644672"],
      ["1", "overlay:1"],
    ]);
    expect(adb.getExecutedCommands()).toEqual([
      "shell cmd display get-displays",
      "shell dumpsys display",
    ]);
  });

  test("an Unknown command reply on stdout also selects the fallback", async () => {
    const adb = api30Adb();
    adb.setCommandResponse(
      "cmd display get-displays",
      createExecResult(API30_GET_DISPLAYS_STDOUT, ""),
    );
    const infos = await readAndroidLogicalDisplays(adb, []);
    expect(infos.map((info) => info.logicalId)).toEqual(["0", "1"]);
  });

  test("an unreadable fallback is a typed non-retryable refusal", async () => {
    const adb = api30Adb();
    adb.setCommandError("dumpsys display", new Error("display service unavailable"));
    const read = readAndroidLogicalDisplays(adb, [overlayPanel]);
    await expect(read).rejects.toBeInstanceOf(AndroidDisplayListUnavailableError);
    await expect(read).rejects.toBeInstanceOf(ActionableError);
    await expect(read).rejects.toThrow("display service unavailable");
  });

  test("a dump without logical display 0 is not trusted as an inventory", async () => {
    const adb = api30Adb();
    adb.setCommandResponse("dumpsys display", createExecResult("DISPLAY MANAGER\n", ""));
    await expect(readAndroidLogicalDisplays(adb, [])).rejects.toThrow(
      "reported no recognizable logical display 0",
    );
  });

  test("other get-displays failures keep failing without a dumpsys read", async () => {
    const adb = api30Adb();
    adb.setCommandError("cmd display get-displays", new Error("display source timeout"));
    await expect(readAndroidLogicalDisplays(adb, [overlayPanel])).rejects.toThrow(
      "display source timeout",
    );
    expect(adb.getExecutedCommands()).toEqual(["shell cmd display get-displays"]);
  });

  test("abort during the fallback read is never converted into a refusal", async () => {
    const adb = api30Adb();
    const controller = new AbortController();
    adb.abortAfterCommand("dumpsys display", controller);
    const read = readAndroidLogicalDisplays(adb, [], controller.signal);
    await expect(read).rejects.toThrow();
    await expect(read).rejects.not.toBeInstanceOf(AndroidDisplayListUnavailableError);
  });
});

describe("parseDumpsysLogicalDisplays on API 30", () => {
  test("a record without mIsEnabled is enabled", () => {
    expect(
      parseDumpsysLogicalDisplays(API30_DUMPSYS_DISPLAY).map((info) => info.logicalId),
    ).toEqual(["0", "1"]);
  });
});

describe("ObservedAndroidDisplayCache on API 30", () => {
  afterEach(() => ObservedAndroidDisplayCache.release(api30Device.deviceId));

  test("resolves the overlay panel through the dumpsys fallback", async () => {
    const cache = new ObservedAndroidDisplayCache(new FakeTimer());
    expect(await cache.logicalIdForPanel(api30Device, api30Adb(), "overlay:1")).toBe(1);
  });

  test("no inventory source gives an actionable error without Retry the request", async () => {
    const adb = api30Adb();
    adb.setCommandError("dumpsys display", new Error("display service unavailable"));
    const cache = new ObservedAndroidDisplayCache(new FakeTimer());
    const read = cache.logicalIdForPanel(api30Device, adb, "overlay:1");
    await expect(read).rejects.toBeInstanceOf(AndroidDisplayReadError);
    await expect(read).rejects.toThrow("omit display to use the default display");
    await expect(read).rejects.not.toThrow("Retry the request");
  });
});
