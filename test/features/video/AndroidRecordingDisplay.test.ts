import { afterEach, expect, test } from "bun:test";
import type { BootedDevice } from "../../../src/models";
import { resolveAndroidRecordingDisplay } from "../../../src/features/video/AndroidRecordingDisplay";
import { displayTransitions } from "../../../src/features/observe/DisplayTransition";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";
import { FakeTimer } from "../../fakes/FakeTimer";

const device: BootedDevice = {
  platform: "android",
  deviceId: "recording-display-stamp",
  name: "Foldable",
  displays: {
    panels: [
      { key: "11", role: "cover", sizePx: { width: 100, height: 200 } },
      { key: "22", role: "inner", sizePx: { width: 200, height: 300 } },
    ],
    postures: ["closed", "opened"],
  },
};

afterEach(() => displayTransitions.reset(device.deviceId));

test("recording follows the latest observation stamp and accepts an explicit role", async () => {
  const adb = new FakeAdbClient();
  adb.setCommandResult(
    "shell cmd display get-displays",
    'Display id 0: DisplayInfo{uniqueId "local:11" type INTERNAL, real 100 x 200}\n' +
      'Display id 3: DisplayInfo{uniqueId "local:22" type INTERNAL, real 200 x 300}',
  );
  displayTransitions.record(device.deviceId, {
    display: { key: "22", role: "inner", posture: "opened", generation: 1 },
    screenSize: { width: 200, height: 300 },
  });
  const timer = new FakeTimer();

  expect(await resolveAndroidRecordingDisplay(device, adb, undefined, undefined, timer)).toEqual({
    panel: { key: "22", role: "inner" },
    physicalId: "22",
    activePanel: { key: "22", role: "inner" },
  });
  expect(await resolveAndroidRecordingDisplay(device, adb, "cover", undefined, timer)).toEqual({
    panel: { key: "11", role: "cover" },
    physicalId: "11",
    activePanel: { key: "22", role: "inner" },
  });
});

test("one-panel inventory reports its identity without changing screenrecord arguments", async () => {
  const onePanel = {
    ...device,
    displays: { panels: [device.displays!.panels[0]], postures: [] },
  };
  const adb = new FakeAdbClient();
  expect(await resolveAndroidRecordingDisplay(onePanel, adb, "cover")).toEqual({
    panel: { key: "11", role: "cover" },
    activePanel: { key: "11", role: "cover" },
  });
  expect(adb.getAllCommands()).toEqual([]);
});

test("known old Android records by default without a display flag and warns", async () => {
  const adb = new FakeAdbClient();
  expect(await resolveAndroidRecordingDisplay({ ...device, apiLevel: 33 }, adb)).toEqual({
    panel: { key: "11", role: "cover" },
    activePanel: { key: "11", role: "cover" },
    warning: "Android API below 34: recording the default display without a pinned panel.",
  });
  await expect(
    resolveAndroidRecordingDisplay({ ...device, apiLevel: 33 }, adb, "inner"),
  ).rejects.toThrow("API 34 or newer");
  expect(adb.getAllCommands()).toEqual([]);
});
