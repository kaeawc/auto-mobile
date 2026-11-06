import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DeviceState } from "../../../src/features/utility/DeviceState";
import type { BootedDevice } from "../../../src/models";
import { getDeviceStateResultSchema } from "../../../src/server/toolOutputSchemas";
import { deviceStateMessage } from "../../../src/server/deviceStateMessage";
import { createExecResult } from "../../../src/utils/execResult";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../fakes/FakeTimer";

/** Captured from am-fold-pixel10pf (API 36); see the fixture READMEs. */
const fixture = (path: string): string =>
  readFileSync(join(import.meta.dir, "../../fixtures", path), "utf8");

const INNER = "4619827259835644672";
const COVER = "4619827551948147201";

const fold: BootedDevice = {
  name: "Pixel Fold",
  platform: "android",
  deviceId: "emulator-5602",
  displays: {
    panels: [
      { key: INNER, role: "inner", sizePx: { width: 2076, height: 2152 } },
      { key: COVER, role: "cover", sizePx: { width: 1080, height: 2364 } },
    ],
    postures: ["closed", "half_opened", "opened", "rear_display"],
  },
};

function foldAdb(posture: "open" | "closed"): FakeAdbExecutor {
  const adb = new FakeAdbExecutor();
  adb.setCommandResponse(
    "shell cmd device_state print-states",
    createExecResult(fixture("android-display/fold-pixel10pf-api36/fold-print-states.txt"), ""),
  );
  adb.setCommandResponse(
    "shell cmd device_state state",
    createExecResult(
      fixture(`android-display/fold-pixel10pf-api36/fold-${posture}-device-state.txt`),
      "",
    ),
  );
  adb.setCommandResponse(
    "shell cmd display get-displays",
    createExecResult(fixture(`android-fold-displays/fold-${posture}-get-displays.txt`), ""),
  );
  return adb;
}

function readDisplays(device: BootedDevice, adb: FakeAdbExecutor) {
  return new DeviceState(device, {
    adbFactory: new FakeAdbClientFactory(adb),
    timer: new FakeTimer(),
  }).getState(["biometrics"]);
}

describe("getDeviceState displays.current (#17049)", () => {
  test("an opened fold reports the opened posture on the inner panel", async () => {
    const result = await readDisplays(fold, foldAdb("open"));
    expect(result.displays).toEqual({
      ...fold.displays!,
      current: { posture: "opened", activePanel: { key: INNER, role: "inner" } },
    });
    getDeviceStateResultSchema.parse({ message: deviceStateMessage(result), ...result });
  });

  test("a closed fold reports the closed posture on the cover panel", async () => {
    const result = await readDisplays(fold, foldAdb("closed"));
    expect(result.displays?.current).toEqual({
      posture: "closed",
      activePanel: { key: COVER, role: "cover" },
    });
  });

  test("each read is live, so a posture change shows up in the next call", async () => {
    const adb = foldAdb("open");
    const state = new DeviceState(fold, {
      adbFactory: new FakeAdbClientFactory(adb),
      timer: new FakeTimer(),
    });
    expect((await state.getState(["biometrics"])).displays?.current?.posture).toBe("opened");
    const closed = foldAdb("closed");
    for (const command of [
      "shell cmd device_state state",
      "shell cmd display get-displays",
    ] as const) {
      adb.setCommandResponse(command, await closed.executeCommand(command));
    }
    expect((await state.getState(["biometrics"])).displays?.current).toEqual({
      posture: "closed",
      activePanel: { key: COVER, role: "cover" },
    });
  });

  test("a rear-display override reports the committed state, not the base state", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse(
      "shell cmd device_state print-states",
      createExecResult(fixture("android-display/foldpf-print-states.txt"), ""),
    );
    adb.setCommandResponse(
      "shell cmd device_state state",
      createExecResult(fixture("android-display/foldpf-2-rear-display-override-state.txt"), ""),
    );
    const result = await readDisplays(fold, adb);
    // No captured get-displays for rear-display mode: the panel is omitted, not guessed.
    expect(result.displays?.current).toEqual({ posture: "rear_display" });
  });

  test("a failed device_state read reports an unknown posture without failing the call", async () => {
    const adb = foldAdb("open");
    adb.setCommandError("shell cmd device_state", new Error("adb: device_state read failed"));
    const result = await readDisplays(fold, adb);
    expect(result.success).toBe(true);
    expect(result.displays?.current).toEqual({
      posture: "unknown",
      activePanel: { key: INNER, role: "inner" },
    });
  });

  test("a single-panel inventory and an iPhone Duo issue no posture reads", async () => {
    const singlePanel: BootedDevice = {
      ...fold,
      displays: { panels: [fold.displays!.panels[0]], postures: ["unknown"] },
    };
    const androidAdb = new FakeAdbExecutor();
    const single = await readDisplays(singlePanel, androidAdb);
    expect(single.displays).toEqual(singlePanel.displays!);
    expect(androidAdb.getExecutedCommands()).toEqual([]);

    const duo: BootedDevice = { ...fold, platform: "ios", deviceId: "duo-simulator" };
    const iosAdb = new FakeAdbExecutor();
    const result = await new DeviceState(duo, {
      adbFactory: new FakeAdbClientFactory(iosAdb),
      timer: new FakeTimer(),
      simctl: null,
    }).getState(["networkCondition"]);
    expect(result.displays?.current).toBeUndefined();
    expect(iosAdb.getExecutedCommands().some((c) => c.includes("device_state"))).toBe(false);
  });
});
