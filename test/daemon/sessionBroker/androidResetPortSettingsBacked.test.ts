import { describe, expect, test } from "bun:test";
import { AndroidDeviceMutationResetPort } from "../../../src/daemon/sessionBroker/androidDeviceMutationResetPort";
import type { DeviceMutationResetContext } from "../../../src/daemon/sessionBroker/mutations/reset";
import type { MutationValue } from "../../../src/daemon/sessionBroker/mutations/types";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";

const setting = (key: string, priorValue: MutationValue) => ({
  kind: "device-setting",
  key,
  priorValue,
  toolName: "displayConfig",
});

function rig() {
  const adb = new FakeAdbExecutor();
  const port = new AndroidDeviceMutationResetPort(adb);
  const context: DeviceMutationResetContext = {
    scope: { deviceId: "emulator-5554", incarnation: "resource", sessionUuid: "session" },
    signal: new AbortController().signal,
    assertOwned: async () => {},
  };
  return { adb, port, context };
}

describe("AndroidDeviceMutationResetPort settings-backed display rows", () => {
  test.each([
    [
      "fontScale override",
      setting("fontScale", { state: "present", value: 1.3 }),
      ["shell settings --user 0 put system font_scale '1.3'"],
    ],
    [
      "fontScale with no override",
      setting("fontScale", { state: "present", value: "default" }),
      ["shell settings --user 0 delete system font_scale"],
    ],
    [
      "timeFormat",
      setting("timeFormat", { state: "present", value: "12" }),
      ["shell settings --user 0 put system time_12_24 '12'"],
    ],
    [
      "unset timeFormat",
      setting("timeFormat", { state: "absent" }),
      ["shell settings --user 0 delete system time_12_24"],
    ],
    [
      "textDirection",
      setting("textDirection", { state: "present", value: "1,null" }),
      [
        "shell settings --user 0 put global debug.force_rtl '1'",
        "shell settings --user 0 delete global force_rtl",
      ],
    ],
    [
      "increaseContrast",
      setting("increaseContrast", { state: "present", value: "0" }),
      ["shell settings --user 0 put secure high_text_contrast_enabled '0'"],
    ],
    [
      "unset boldText",
      setting("boldText", { state: "absent" }),
      ["shell settings --user 0 delete secure font_weight_adjustment"],
    ],
    [
      "reduceMotion",
      setting("reduceMotion", { state: "present", value: "1,null,0.5" }),
      [
        "shell settings --user 0 put global window_animation_scale '1'",
        "shell settings --user 0 delete global transition_animation_scale",
        "shell settings --user 0 put global animator_duration_scale '0.5'",
      ],
    ],
    [
      "colorCorrection",
      setting("colorCorrection", { state: "present", value: "0,12" }),
      [
        "shell settings --user 0 put secure accessibility_display_daltonizer_enabled '0'",
        "shell settings --user 0 put secure accessibility_display_daltonizer '12'",
      ],
    ],
    [
      "magnificationScale",
      setting("magnificationScale", { state: "present", value: "2.5" }),
      ["shell settings --user 0 put secure accessibility_display_magnification_scale '2.5'"],
    ],
  ])("restores %s through its raw settings rows", async (_label, mutation, commands) => {
    const { adb, port, context } = rig();
    expect(port.canRevert(mutation)).toBe(true);
    await port.revert(mutation, context);
    expect(adb.getExecutedCommands()).toEqual(commands);
  });

  test.each([
    ["unobservable", setting("fontScale", { state: "unobservable" })],
    ["non-numeric fontScale", setting("fontScale", { state: "present", value: "big" })],
    ["zero fontScale", setting("fontScale", { state: "present", value: 0 })],
    ["unknown timeFormat", setting("timeFormat", { state: "present", value: "13" })],
    ["shell text in a flag", setting("colorInversion", { state: "present", value: "1; reboot" })],
    ["wrong part count", setting("reduceMotion", { state: "present", value: "1,1" })],
    ["non-string accessibility prior", setting("extraDim", { state: "present", value: 1 })],
    ["Android locale", setting("locale", { state: "present", value: "en-US" })],
    ["calendarSystem", setting("calendarSystem", { state: "present", value: "gregorian" })],
    [
      "a raw calendarSystem row",
      setting("calendarSystem", { state: "present", value: { calendar_type: "gregorian" } }),
    ],
    ["unobservable textDirection", setting("textDirection", { state: "unobservable" })],
    ["one textDirection row", setting("textDirection", { state: "present", value: "1" })],
    ["boolean textDirection", setting("textDirection", { state: "present", value: true })],
  ])("cannot restore %s", (_label, mutation) => {
    expect(rig().port.canRevert(mutation)).toBe(false);
  });
});
