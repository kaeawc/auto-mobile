import { describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DeviceState } from "../../../src/features/utility/DeviceState";
import type { BootedDevice } from "../../../src/models";
import { getDeviceStateResultSchema } from "../../../src/server/toolOutputSchemas";
import { deviceStateMessage } from "../../../src/server/deviceStateMessage";
import { createExecResult } from "../../../src/utils/execResult";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { logger } from "../../../src/utils/logger";
import { parseDevicectlDisplayInfo } from "../../../src/utils/ios-cmdline-tools/DevicectlDisplayInfo";
import { FakeDevicectlDisplayInfoSource } from "../../fakes/FakeDevicectlDisplayInfoSource";
import { FakeTimer } from "../../fakes/FakeTimer";
import { InMemoryIosRequestedHingeAngleStore } from "../../../src/features/device/DuoHingeLayout";

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
      current: {
        posture: "opened",
        postureSource: "device_state",
        activePanel: { key: INNER, role: "inner" },
      },
    });
    getDeviceStateResultSchema.parse({ message: deviceStateMessage(result), ...result });
  });

  test("an Android fold reports its committed posture as device_state, not inferred (#17637)", async () => {
    const result = await readDisplays(fold, foldAdb("closed"));
    const parsed = getDeviceStateResultSchema.parse({
      message: deviceStateMessage(result),
      ...result,
    });
    expect(parsed.displays?.current?.postureSource).toBe("device_state");
  });

  test("a closed fold reports the closed posture on the cover panel", async () => {
    const result = await readDisplays(fold, foldAdb("closed"));
    expect(result.displays?.current).toEqual({
      posture: "closed",
      postureSource: "device_state",
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
      postureSource: "device_state",
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
    expect(result.displays?.current).toEqual({
      posture: "rear_display",
      postureSource: "device_state",
    });
  });

  test("a failed device_state read reports an unknown posture with no postureSource", async () => {
    const adb = foldAdb("open");
    adb.setCommandError("shell cmd device_state", new Error("adb: device_state read failed"));
    const result = await readDisplays(fold, adb);
    expect(result.success).toBe(true);
    expect(result.displays?.current).toEqual({
      posture: "unknown",
      activePanel: { key: INNER, role: "inner" },
    });
    const parsed = getDeviceStateResultSchema.parse({
      message: deviceStateMessage(result),
      ...result,
    });
    expect(parsed.displays?.current).not.toHaveProperty("postureSource");
  });

  test("single-panel Android and iOS inventories issue no posture reads", async () => {
    const singlePanel: BootedDevice = {
      ...fold,
      displays: { panels: [fold.displays!.panels[0]], postures: ["unknown"] },
    };
    const androidAdb = new FakeAdbExecutor();
    const single = await readDisplays(singlePanel, androidAdb);
    expect(single.displays).toEqual(singlePanel.displays!);
    expect(androidAdb.getExecutedCommands()).toEqual([]);

    const singleIos: BootedDevice = { ...singlePanel, platform: "ios", deviceId: "iphone" };
    const source = new FakeDevicectlDisplayInfoSource();
    const iosAdb = new FakeAdbExecutor();
    const result = await new DeviceState(singleIos, {
      iosDisplayInfoSource: source,
      adbFactory: new FakeAdbClientFactory(iosAdb),
      timer: new FakeTimer(),
      simctl: null,
    }).getState(["networkCondition"]);
    expect(result.displays?.current).toBeUndefined();
    expect(source.requests).toEqual([]);
    expect(iosAdb.getExecutedCommands().some((c) => c.includes("device_state"))).toBe(false);
  });
});

const duo: BootedDevice = {
  name: "iPhone Duo",
  platform: "ios",
  deviceId: "duo-simulator",
  displays: {
    panels: [
      { key: "primary", role: "cover", sizePx: { width: 1398, height: 2034 }, scale: 3 },
      { key: "primary-1", role: "inner", sizePx: { width: 2007, height: 2853 }, scale: 3 },
    ],
    postures: ["closed", "half_opened", "opened"],
  },
};

function duoDisplays(panel: "inner" | "cover") {
  const parsed = parseDevicectlDisplayInfo(
    fixture(`ios-devicectl/info-displays-duo-${panel}-active.json`),
  );
  if (parsed.kind !== "ok") {
    throw new Error(parsed.message);
  }
  return parsed.displays;
}

function duoState(source: FakeDevicectlDisplayInfoSource) {
  const adb = new FakeAdbExecutor();
  return {
    adb,
    state: new DeviceState(duo, {
      iosDisplayInfoSource: source,
      // No setPosture ran: the daemon-wide store must not leak another test's angle.
      iosHingeAngleStore: new InMemoryIosRequestedHingeAngleStore(),
      adbFactory: new FakeAdbClientFactory(adb),
      timer: new FakeTimer(),
      simctl: null,
    }),
  };
}

describe("getDeviceState iPhone Duo displays.current", () => {
  for (const [panel, posture, key] of [
    ["inner", "opened", "primary-1"],
    ["cover", "closed", "primary"],
  ] as const) {
    test(`${panel} active reports ${posture} using captured evidence`, async () => {
      const source = new FakeDevicectlDisplayInfoSource();
      source.displays = duoDisplays(panel);
      const { state, adb } = duoState(source);
      const result = await state.getState(["networkCondition"]);
      expect(result.displays).toEqual({
        ...duo.displays!,
        current: {
          posture,
          postureSource: "inferred_from_active_panel",
          activePanel: { key, role: panel },
        },
      });
      expect(source.requests).toHaveLength(1);
      expect(source.requests[0].deviceId).toBe(duo.deviceId);
      expect(adb.getExecutedCommands()).toEqual([]);
      getDeviceStateResultSchema.parse({ message: deviceStateMessage(result), ...result });
    });
  }

  test("each read reflects a new active panel without caching", async () => {
    const source = new FakeDevicectlDisplayInfoSource();
    const { state } = duoState(source);
    source.displays = duoDisplays("inner");
    expect((await state.getState(["networkCondition"])).displays?.current?.posture).toBe("opened");
    source.displays = duoDisplays("cover");
    expect((await state.getState(["networkCondition"])).displays?.current).toEqual({
      posture: "closed",
      postureSource: "inferred_from_active_panel",
      activePanel: { key: "primary", role: "cover" },
    });
    expect(source.requests).toHaveLength(2);
  });

  test("an inner-panel read is reported as inferred, never as a confirmed hinge posture (#17637)", async () => {
    const source = new FakeDevicectlDisplayInfoSource();
    source.displays = duoDisplays("inner");
    const result = await duoState(source).state.getState(["networkCondition"]);
    const current = result.displays?.current;
    expect(current?.postureSource).toBe("inferred_from_active_panel");
    expect(current?.activePanel).toEqual({ key: "primary-1", role: "inner" });
    const parsed = getDeviceStateResultSchema.parse({
      message: deviceStateMessage(result),
      ...result,
    });
    expect(parsed.displays?.current?.postureSource).toBe("inferred_from_active_panel");
  });

  for (const failure of ["read failed", "no active", "unmatched", "ambiguous"] as const) {
    test(`${failure} omits current and warns`, async () => {
      const source = new FakeDevicectlDisplayInfoSource();
      source.displays = duoDisplays("inner");
      if (failure === "read failed") {
        source.error = new Error("devicectl failed");
      }
      if (failure === "no active") {
        source.displays = source.displays.map((d) => ({ ...d, active: false }));
      }
      if (failure === "unmatched") {
        source.displays = source.displays.map((d) => ({
          ...d,
          nativeSize: { width: 10, height: 20 },
        }));
      }
      if (failure === "ambiguous") {
        source.displays = source.displays.map((d) => ({ ...d, active: true }));
      }
      const warn = spyOn(logger, "warn").mockImplementation(() => {});
      try {
        const result = await duoState(source).state.getState(["networkCondition"]);
        expect(result.success).toBe(true);
        expect(result.displays).toEqual(duo.displays!);
        expect(result.displays).not.toHaveProperty("current");
        expect(warn).toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    });
  }
});
