import { describe, expect, test } from "bun:test";
import { IosDeviceMutationResetPort } from "../../../src/daemon/sessionBroker/mutations/iosResetPort";
import type { DeviceMutationResetContext } from "../../../src/daemon/sessionBroker/mutations/reset";
import type { MutationValue } from "../../../src/daemon/sessionBroker/mutations/types";
import { FakeTimer } from "../../fakes/FakeTimer";

function harness(globals = '<plist version="1.0"><dict/></plist>') {
  const commands: string[][] = [];
  const ui: Record<string, string> = {
    appearance: "light",
    content_size: "large",
    increase_contrast: "disabled",
  };
  const port = new IosDeviceMutationResetPort(
    {
      simctl: {
        listAppsOrThrow: async () => [],
        executeCommandArgs: async (args) => {
          commands.push(args);
          const stdout =
            args[0] === "ui" ? `${ui[args[2]]}\n` : args[3] === "export" ? globals : "";
          return {
            stdout,
            stderr: "",
            toString: () => stdout,
            trim: () => stdout.trim(),
            includes: (text) => stdout.includes(text),
          };
        },
      },
      files: { realpath: async (path) => path, remove: async () => {} },
      pasteboard: { assertSettled: () => {}, write: async () => {} },
    },
    new FakeTimer(),
  );
  const context: DeviceMutationResetContext = {
    scope: { deviceId: "UDID", incarnation: "generation", sessionUuid: "session" },
    signal: new AbortController().signal,
    assertOwned: async () => {},
    baseline: { completeKinds: ["installed-app"], observations: [], unobservable: [] },
  };
  const globalsSnapshot = async () =>
    (await port.capture(context)).observations.filter(
      (entry) =>
        !["appearance", "nightMode", "content-size", "increase-contrast"].includes(entry.key),
    );
  return { port, context, commands, globalsSnapshot };
}

describe("iOS baseline setting contracts", () => {
  test("defaults XML arrays preserve language tags, order and escaping without line parsing", async () => {
    const rig = harness(`<plist version="1.0"><dict>
<key>AppleLocale</key><string>en-US@calendar=gregorian</string>
<key>AppleLanguages</key><array><string>en-US</string><string>fr&amp;CA</string></array>
<key>AppleCalendar</key><string>buddhist</string>
<key>AppleICUForce24HourTime</key><true/>
<key>AppleICUForce12HourTime</key><false/>
<key>UnrelatedPreference</key><dict><key>nested</key><string>ignored</string></dict>
</dict></plist>`);
    const observations = await rig.globalsSnapshot();
    expect(observations).toEqual([
      {
        kind: "device-setting",
        key: "locale",
        value: { state: "present", value: "en-US@calendar=gregorian" },
      },
      {
        kind: "device-setting",
        key: "language",
        value: { state: "present", value: ["en-US", "fr&CA"] },
      },
      {
        kind: "device-setting",
        key: "calendarSystem",
        value: { state: "present", value: "buddhist" },
      },
      {
        kind: "device-setting",
        key: "force-24-hour-time",
        value: { state: "present", value: true },
      },
      {
        kind: "device-setting",
        key: "force-12-hour-time",
        value: { state: "present", value: false },
      },
    ]);
  });

  test("missing global keys are explicitly absent, not fabricated system defaults", async () => {
    const observations = await harness().globalsSnapshot();
    expect(observations).toHaveLength(5);
    expect(observations.every((entry) => entry.value.state === "absent")).toBe(true);
  });

  test("unsupported native types cannot certify settings or permit unsafe reverts", async () => {
    for (const xml of [
      "<plist><dict><key>AppleLocale</key><integer>1</integer></dict></plist>",
      "<plist><dict><key>AppleLanguages</key><array/></dict></plist>",
      "<plist><dict><key>AppleICUForce24HourTime</key><string>YES</string></dict></plist>",
    ]) {
      const rig = harness(xml);
      expect((await rig.port.capture(rig.context)).unobservable).toContain("device-setting");
    }
    const cases: Array<{ key: string; priorValue: MutationValue }> = [
      { key: "content-size", priorValue: { state: "present", value: "increment" } },
      { key: "increase-contrast", priorValue: { state: "present", value: true } },
      { key: "language", priorValue: { state: "present", value: [] } },
      { key: "language", priorValue: { state: "present", value: ["en", 1] } },
      { key: "fontScale", priorValue: { state: "present", value: 1.2 } },
      { key: "timeFormat", priorValue: { state: "present", value: "24" } },
    ];
    const rig = harness();
    for (const entry of cases) {
      expect(rig.port.canRevert({ kind: "device-setting", ...entry, toolName: "test" })).toBe(
        false,
      );
    }
  });

  test("reverts preserve raw locale bytes, arrays, booleans and absent keys", async () => {
    const commands: string[][] = [];
    const port = new IosDeviceMutationResetPort(
      {
        simctl: {
          listAppsOrThrow: async () => [],
          executeCommandArgs: async (args) => {
            commands.push(args);
            return {
              stdout: "",
              stderr: "",
              toString: () => "",
              trim: () => "",
              includes: () => false,
            };
          },
        },
        files: { realpath: async (path) => path, remove: async () => {} },
        pasteboard: { assertSettled: () => {}, write: async () => {} },
      },
      new FakeTimer(),
    );
    const context: DeviceMutationResetContext = {
      scope: { deviceId: "UDID", incarnation: "generation", sessionUuid: "session" },
      signal: new AbortController().signal,
      assertOwned: async () => {},
    };
    const cases: Array<{ key: string; priorValue: MutationValue; args: string[] }> = [
      {
        key: "locale",
        priorValue: { state: "present", value: "en-US@calendar=gregorian" },
        args: ["write", ".GlobalPreferences", "AppleLocale", "-string", "en-US@calendar=gregorian"],
      },
      {
        key: "language",
        priorValue: { state: "present", value: ["en-US", "fr-CA"] },
        args: ["write", ".GlobalPreferences", "AppleLanguages", "-array", "en-US", "fr-CA"],
      },
      {
        key: "force-24-hour-time",
        priorValue: { state: "present", value: false },
        args: ["write", ".GlobalPreferences", "AppleICUForce24HourTime", "-bool", "false"],
      },
      {
        key: "calendarSystem",
        priorValue: { state: "absent" },
        args: ["delete", ".GlobalPreferences", "AppleCalendar"],
      },
    ];
    for (const entry of cases) {
      await port.revert(
        { kind: "device-setting", key: entry.key, priorValue: entry.priorValue, toolName: "test" },
        context,
      );
      expect(commands.at(-1)).toEqual(["spawn", "UDID", "defaults", ...entry.args]);
    }
  });
});

describe("iOS journaled display setting reverts (#14790)", () => {
  const present = (value: string): MutationValue => ({ state: "present", value });
  const mutation = (key: string, priorValue: MutationValue) => ({
    kind: "device-setting",
    key,
    priorValue,
    toolName: "displayConfig",
  });

  test.each([
    ["increaseContrast", present("disabled"), ["ui", "UDID", "increase_contrast", "disabled"]],
    ["contentSize", present("large"), ["ui", "UDID", "content_size", "large"]],
    ["nightMode", present("light"), ["ui", "UDID", "appearance", "light"]],
    [
      "reduceMotion",
      present("1"),
      [
        "spawn",
        "UDID",
        "defaults",
        "write",
        "com.apple.Accessibility",
        "ReduceMotionEnabled",
        "-bool",
        "YES",
      ],
    ],
    [
      "boldText",
      present("0"),
      [
        "spawn",
        "UDID",
        "defaults",
        "write",
        "com.apple.Accessibility",
        "EnhancedTextLegibilityEnabled",
        "-bool",
        "NO",
      ],
    ],
    [
      "reduceMotion",
      { state: "absent" } as MutationValue,
      ["spawn", "UDID", "defaults", "delete", "com.apple.Accessibility", "ReduceMotionEnabled"],
    ],
  ] as const)("%s reverts to its recorded prior value", async (key, priorValue, expected) => {
    const rig = harness();
    expect(rig.port.canRevert(mutation(key, priorValue))).toBe(true);
    await rig.port.revert(mutation(key, priorValue), rig.context);
    expect(rig.commands).toEqual([[...expected]]);
  });

  test("values the recorded setting cannot take are refused", () => {
    const rig = harness();
    expect(rig.port.canRevert(mutation("increaseContrast", present("true")))).toBe(false);
    expect(rig.port.canRevert(mutation("contentSize", present("huge")))).toBe(false);
    expect(rig.port.canRevert(mutation("boldText", present("yes")))).toBe(false);
    expect(rig.port.canRevert(mutation("increaseContrast", { state: "absent" }))).toBe(false);
    expect(rig.port.canRevert(mutation("fontScale", present("1.2")))).toBe(false);
  });
});
