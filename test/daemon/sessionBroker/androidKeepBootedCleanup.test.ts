import { deviceToolMutations } from "../../../src/server/deviceMutationAdapters";
import { readFileSync } from "node:fs";
import { SETTINGS_TIMEOUT } from "./fixtures/androidResetLoadTimeouts";

import { describe, expect, test } from "bun:test";
import {
  androidBaselineCleanCovers,
  androidUserFilesNamespaceCovered,
  cleanAndroidBaseline,
  sessionCreatedSettingMatcher,
} from "../../../src/daemon/sessionBroker/androidKeepBootedCleanup";
import type {
  DeviceBaseline,
  DeviceMutationInput,
} from "../../../src/daemon/sessionBroker/mutations/types";
import { AndroidDeviceMutationResetPort } from "../../../src/daemon/sessionBroker/androidDeviceMutationResetPort";
import { AndroidKeepBootedReset } from "../../../src/daemon/sessionBroker/androidKeepBootedReset";
import { shellQuote } from "../../../src/utils/shellQuote";
import { createExecResult } from "../../../src/utils/execResult";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeDeviceMutationJournal } from "../../fakes/FakeDeviceMutationJournal";
import { ANDROID_RESET_DEVICE } from "./fixtures/androidReset";
import { androidBaselineRig, androidPackageDump } from "./fixtures/androidMutationBaseline";
import type { AndroidResetStrategy } from "../../../src/daemon/sessionBroker/androidBaselineReset";

const SESSION = { resourceId: "resource-a", sessionId: "session-a" };
const SCOPE = {
  deviceId: ANDROID_RESET_DEVICE.deviceId,
  incarnation: SESSION.resourceId,
  sessionUuid: SESSION.sessionId,
};

function settingsFixture(name: string): string {
  return readFileSync(
    new URL(`../../fixtures/android-settings-list/${name}.txt`, import.meta.url),
    "utf8",
  ).trimEnd();
}

function createdSetting(key: string) {
  return {
    kind: "device-setting",
    key,
    priorValue: { state: "absent" },
    toolName: "baseline-diff",
  } satisfies DeviceMutationInput;
}

async function rig(
  users: readonly number[] = [0],
  fallback?: AndroidResetStrategy,
  configureBaseline?: (reply: (command: string, stdout: string) => void) => void,
) {
  const { adb, reply } = androidBaselineRig(users);
  configureBaseline?.(reply);
  const timer = new FakeTimer();
  const journal = new FakeDeviceMutationJournal(timer);
  const port = new AndroidDeviceMutationResetPort(adb, timer);
  let owned = true;
  const assertOwned = async () => {
    if (!owned) {
      throw new Error("ownership lost");
    }
  };
  const strategy = new AndroidKeepBootedReset({ journal, port: () => port, timer, fallback });
  await strategy.capture(ANDROID_RESET_DEVICE, {
    ...SESSION,
    timeoutMs: 50,
    signal: new AbortController().signal,
    assertOwned,
  });
  adb.clearHistory();
  const reset = () =>
    strategy.reset(ANDROID_RESET_DEVICE, new Set(["com.example.probe"]), assertOwned, SESSION);
  return {
    adb,
    reply,
    journal,
    port,
    timer,
    strategy,
    reset,
    loseOwnership: () => {
      owned = false;
    },
  };
}

describe("Android unconditional keep-booted cleaning", () => {
  test.each([
    ["installed-app", "any"],
    ["clipboard", "any"],
    ["device-setting", "global:setting"],
    ["device-setting", "secure:user:10:setting"],
    ["device-setting", "system:accelerometer_rotation"],
    ["device-setting", "display:density"],
    ["device-setting", "density"],
    ["device-setting", "nightMode"],
    ["device-setting", "screen-state"],
  ])("baseline cleaning covers %s:%s without a readable prior", (kind, key) => {
    expect(androidBaselineCleanCovers({ kind, key, priorValue: { state: "unobservable" } })).toBe(
      true,
    );
  });

  test.each([
    ["location", "provider:gps"],
    ["contact", "row"],
    ["media", "row"],
    ["calendar", "row"],
    ["notification", "row"],
    ["network-condition", "network"],
    ["device-setting", "appops:dev.example.app:op"],
    ["device-setting", "prefix-global:setting"],
  ])("baseline cleaning does not cover %s:%s", (kind, key) => {
    expect(androidBaselineCleanCovers({ kind, key, priorValue: { state: "unobservable" } })).toBe(
      false,
    );
  });

  test("production shared-file intents are never baseline-covered", () => {
    for (const target of [
      { domain: "user_files", namespace: "test", reset: true },
      { domain: "app_container", appId: "a.b", container: "files" },
    ]) {
      const rows = deviceToolMutations(
        "putAppFile",
        { target, files: [{ destinationPath: "x" }] },
        "android",
      );
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(Array.isArray(JSON.parse(row.key))).toBe(true);
        for (const priorValue of [
          { state: "absent" as const },
          { state: "present" as const, value: "old" },
        ]) {
          expect(androidBaselineCleanCovers({ ...row, priorValue })).toBe(false);
        }
      }
    }
  });

  test("production accessibility, font-scale and time-format rows require a journal revert", () => {
    const rows = [
      ...deviceToolMutations(
        "displayConfig",
        {
          fontScale: 1.2,
          increaseContrast: true,
          reduceMotion: true,
          boldText: true,
          colorInversion: true,
          colorCorrection: "grayscale",
          magnification: true,
          magnificationScale: 3,
          extraDim: true,
        },
        "android",
      ),
      ...deviceToolMutations("changeLocalization", { timeFormat: "24" }, "android"),
    ];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(androidBaselineCleanCovers({ ...row, priorValue: { state: "unobservable" } })).toBe(
        false,
      );
    }
  });

  test("displayConfig fontScale with a readable prior reverts in place and stays keep-booted", async () => {
    let fallbacks = 0;
    const { adb, journal, reset } = await rig([0], {
      reset: async () => {
        fallbacks++;
        return { outcome: "clean", mode: "snapshot", phases: {} };
      },
    });
    for (const row of deviceToolMutations("displayConfig", { fontScale: 1.3 }, "android")) {
      await journal.record(SCOPE, {
        ...row,
        toolName: "displayConfig",
        priorValue: { state: "present", value: "default" },
      });
    }
    expect(await reset()).toMatchObject({ outcome: "clean", mode: "keep-booted" });
    expect(fallbacks).toBe(0);
    expect(adb.getExecutedCommands()).toContain("shell settings --user 0 delete system font_scale");
  });

  test.each([
    {
      tool: "displayConfig",
      args: { colorInversion: true },
      namespace: "secure",
      key: "accessibility_display_inversion_enabled",
      value: "1",
    },
    {
      tool: "displayConfig",
      args: { reduceMotion: true },
      namespace: "global",
      key: "animator_duration_scale",
      value: "0",
    },
    {
      tool: "changeLocalization",
      args: { timeFormat: "24" },
      namespace: "system",
      key: "time_12_24",
      value: "24",
    },
  ])(
    "$tool $args escalates before a non-critical settings restore can fail",
    async ({ tool, args, namespace, key, value }) => {
      let fallbacks = 0;
      const { adb, reply, journal, reset } = await rig([0], {
        reset: async () => {
          fallbacks++;
          return { outcome: "clean", mode: "snapshot", phases: {} };
        },
      });
      reply(`shell settings --user 0 list ${namespace}`, `${key}=${value}`);
      const failedCommand =
        key === "animator_duration_scale"
          ? "shell settings --user 0 put global animator_duration_scale '0.5'"
          : `shell settings --user 0 delete ${namespace} ${key}`;
      adb.setCommandResponse(failedCommand, createExecResult("Error: refused", ""));
      const rows = deviceToolMutations(tool, args, "android");
      expect(rows).toHaveLength(1);
      for (const row of rows) {
        await journal.record(SCOPE, {
          ...row,
          toolName: tool,
          priorValue: { state: "unobservable" },
        });
      }
      expect(await reset()).toMatchObject({ outcome: "fallback:snapshot" });
      expect(fallbacks).toBe(1);
      expect(adb.getExecutedCommands()).toEqual([]);
    },
  );

  async function displayRig(verify = true) {
    const { adb, reply } = androidBaselineRig();
    reply("shell wm density", "Physical density: 420");
    reply("shell cmd uimode night", "Night mode: no");
    const context = {
      scope: SCOPE,
      signal: new AbortController().signal,
      assertOwned: async () => {},
    };
    const port = new AndroidDeviceMutationResetPort(adb);
    const baseline = await port.capture(context);
    const reverted: DeviceMutationInput[] = [];
    adb.clearHistory();
    const clean = () =>
      cleanAndroidBaseline(
        baseline,
        context,
        async (command) => (await adb.executeCommand(command)).stdout.trim(),
        async (mutation) => {
          reverted.push(mutation);
          await port.revert(mutation, context);
          if (verify && mutation.key.startsWith("display:")) {
            reply("shell wm density", "Physical density: 420");
            reply("shell wm size", "Physical size: 1080x1920");
            reply("shell cmd uimode night", "Night mode: no");
          }
        },
      );
    return { adb, reply, baseline, reverted, clean };
  }

  test("restores live density and night mode before settings rows", async () => {
    const { adb, reply, reverted, clean } = await displayRig();
    reply("shell wm density", "Physical density: 420\nOverride density: 480");
    reply("shell cmd uimode night", "Night mode: yes");
    reply("shell settings --user 0 list secure", "enabled_input_methods=\nlocation_mode=0");
    await clean();
    expect(reverted.slice(0, 2)).toEqual([
      {
        kind: "device-setting",
        key: "display:density",
        priorValue: { state: "absent" },
        toolName: "keep-booted-cleaning",
      },
      {
        kind: "device-setting",
        key: "display:night-mode",
        priorValue: { state: "present", value: "no" },
        toolName: "keep-booted-cleaning",
      },
    ]);
    expect(reverted[2]!.key).toBe("secure:location_mode");
    expect(adb.getExecutedCommands()).toContain("shell wm density reset");
    expect(adb.getExecutedCommands()).toContain("shell cmd uimode night no");
  });

  test("live display verification fails closed when overrides remain", async () => {
    const { reply, clean } = await displayRig(false);
    reply("shell wm density", "Physical density: 420\nOverride density: 480");
    reply("shell cmd uimode night", "Night mode: yes");
    await expect(clean()).rejects.toThrow(
      "Android cleaning did not restore live display state: display:density, display:night-mode",
    );
  });

  test("matching live display state needs no reversions", async () => {
    const { adb, reverted, clean } = await displayRig();
    await clean();
    expect(reverted).toEqual([]);
    expect(
      adb.getExecutedCommands().filter((command) => command === "shell wm density"),
    ).toHaveLength(2);
  });

  test("missing display observations are skipped", async () => {
    const { baseline, reply, reverted, clean } = await displayRig();
    baseline.observations = baseline.observations.filter(
      (observation) => !observation.key.startsWith("display:"),
    );
    reply("shell wm density", "Physical density: 420\nOverride density: 480");
    await clean();
    expect(reverted).toEqual([]);
  });

  test("display restoration errors propagate", async () => {
    const { adb, reply, clean } = await displayRig();
    reply("shell wm density", "Physical density: 420\nOverride density: 480");
    adb.setCommandError("shell wm density reset", new Error("display restore refused"));
    await expect(clean()).rejects.toThrow();
  });

  test.each(["android", "com.example.probe"])(
    "an absent-prior journal entry never dispatches uninstall for baseline package %s",
    async (packageName) => {
      const { adb, journal, reset } = await rig();
      await journal.record(SCOPE, {
        kind: "installed-app",
        key: `user:0:${packageName}`,
        priorValue: { state: "absent" },
        toolName: "install-update",
      });
      expect(await reset()).toMatchObject({ outcome: "clean", mode: "keep-booted" });
      expect(adb.getExecutedCommands().some((command) => command.includes("pm uninstall"))).toBe(
        false,
      );
    },
  );

  test("production partial baseline still runs all cleaners and reports keep-booted", async () => {
    const { adb, reset } = await rig();
    expect(await reset()).toMatchObject({
      outcome: "clean",
      mode: "keep-booted",
      phases: { journal: 0, clean: 0, health: 0 },
    });
    const commands = adb.getExecutedCommands();
    expect(commands).toContain("shell pm list users");
    expect(commands).toContain("shell pm list packages -3 --user 0");
    expect(commands).toContain("shell settings --user 0 list global");
    expect(commands).toContain("shell settings --user 0 list system");
    expect(commands).toContain("shell settings --user 0 list secure");
    expect(commands).toContain("shell cmd clipboard clear");
    expect(commands.some((command) => command.includes("pm clear"))).toBe(false);
    expect(commands.some((command) => command.includes("sha256sum"))).toBe(false);
    expect(commands).toContain("shell getprop persist.sys.timezone");
    expect(commands).toContain("shell getprop persist.sys.locale");
    expect(commands).toContain("shell dumpsys account");
    expect(commands.some((command) => command.includes("set-timezone"))).toBe(false);
    expect(
      adb
        .getCommandCalls()
        .every(
          (call) =>
            call.timeoutMs! >= 2000 &&
            call.noRetry &&
            call.signal &&
            call.waitForProcessSettlementAfterAbort,
        ),
    ).toBe(true);
  });

  test("uninstalls non-baseline third-party apps for every current user including new users", async () => {
    const { adb, reply, reset } = await rig([0, 10]);
    reply(
      "shell pm list users",
      "Users:\n UserInfo{0:Owner:c13} running\n UserInfo{10:Work:c13} running\n UserInfo{11:New:c13} running",
    );
    for (const user of [0, 10, 11]) {
      reply(
        `shell pm list packages -3 --user ${user}`,
        "package:com.example.probe\npackage:com.example.new",
      );
      reply(
        `shell pm list packages --user ${user}`,
        "package:android\npackage:com.example.probe\npackage:com.example.new",
      );
    }
    reply("shell pm uninstall", "Success");
    reply(
      "shell dumpsys account",
      [0, 10, 11].map((user) => `User UserInfo{${user}:Owner:c13}:\n  Accounts: 0`).join("\n"),
    );
    expect(await reset()).toMatchObject({ outcome: "clean" });
    const commands = adb.getExecutedCommands();
    for (const user of [0, 10, 11]) {
      expect(commands).toContain(`shell pm uninstall --user ${user} 'com.example.new'`);
    }
    expect(commands).toContain("shell pm uninstall --user 11 'com.example.probe'");
    expect(commands).not.toContain("shell pm uninstall --user 0 'com.example.probe'");
    expect(commands).not.toContain("shell pm uninstall --user 10 'com.example.probe'");
  });

  test("preserves baseline runtime grants and fixture data while revoking added grants", async () => {
    const { adb, reply, reset } = await rig([0, 10]);
    const dump = androidPackageDump("com.example.probe", [0, 10]).replaceAll(
      "android.permission.CAMERA: granted=true, flags=[ USER_SET ]",
      "android.permission.CAMERA: granted=true, flags=[ USER_SET ]\n        android.permission.RECORD_AUDIO: granted=true, flags=[]",
    );
    reply("shell dumpsys package 'com.example.probe'", dump);
    await reset();
    const commands = adb.getExecutedCommands();
    for (const user of [0, 10]) {
      expect(commands).toContain(
        `shell pm revoke --user ${user} 'com.example.probe' 'android.permission.RECORD_AUDIO'`,
      );
    }
    expect(
      commands.some(
        (command) =>
          command.includes("pm clear") ||
          command.includes("pm reset-permissions") ||
          (command.includes("pm revoke") && command.includes("CAMERA")),
      ),
    ).toBe(false);
  });

  test("restores changed and missing settings, deletes added keys, and targets secondary users", async () => {
    const { adb, reply, journal, reset } = await rig([0, 10]);
    await journal.record(SCOPE, {
      kind: "device-setting",
      key: "global:new_key",
      priorValue: { state: "absent" },
      toolName: "baseline-diff",
    });
    reply("shell settings --user 0 list global", "animator_duration_scale=0\nnew_key=1");
    reply("shell settings --user 10 list system", "font_scale=2");
    reply("shell settings --user 0 list secure", "enabled_input_methods=\nlocation_mode=0");
    await reset();
    const commands = adb.getExecutedCommands();
    expect(commands).toContain("shell settings --user 0 put global animator_duration_scale '0.5'");
    expect(commands).toContain("shell settings --user 0 delete global new_key");
    expect(commands).toContain("shell settings --user 10 put system font_scale '1.0'");
    expect(commands).toContain("shell settings --user 10 put system system_locales 'en-US'");
    expect(commands).toContain("shell settings --user 0 put secure location_mode '3'");
  });

  test.each([false, true])("persistent setting put failure is non-clean (%s)", async (critical) => {
    const { adb, reply, journal, reset } = await rig();
    const key = critical ? "adb_enabled" : "optional_key";
    await journal.record(SCOPE, {
      kind: "device-setting",
      key: `global:${key}`,
      priorValue: { state: "absent" },
      toolName: "baseline-diff",
    });
    reply("shell settings --user 0 list global", `${key}=0`);
    const failedCommand = `shell settings --user 0 delete global ${key}`;
    adb.setCommandResponse(failedCommand, createExecResult("Error: refused", ""));
    await expect(reset()).rejects.toThrow("non-clean");
  });

  describe("system-maintained settings absent from the baseline (#15178)", () => {
    const captured = (name: string) => settingsFixture(name);
    const baselineFromCleanedDevice = (reply: (command: string, stdout: string) => void) => {
      reply("shell settings --user 0 list system", captured("after-keep-booted-clean.system"));
      reply("shell settings --user 0 list secure", captured("after-keep-booted-clean.secure"));
    };
    const systemKeys = [
      "alarm_alert",
      "alarm_alert_set",
      "notification_sound",
      "notification_sound_set",
      "ringtone",
      "ringtone_set",
      "systemui.google.opa_enabled",
    ];

    test("keeps ringtone, alarm and opa settings the session start already had", async () => {
      const { adb, reply, reset } = await rig([0], undefined, baselineFromCleanedDevice);
      reply("shell settings --user 0 list system", captured("session-start.system"));
      reply("shell settings --user 0 list secure", captured("session-start.secure"));
      expect(await reset()).toMatchObject({ outcome: "clean", mode: "keep-booted" });
      const commands = adb.getExecutedCommands();
      expect(commands.filter((command) => command.includes("shell settings"))).toEqual(
        expect.arrayContaining([
          "shell settings --user 0 list global",
          "shell settings --user 0 list system",
          "shell settings --user 0 list secure",
        ]),
      );
      for (const key of systemKeys) {
        expect(commands.some((command) => command.endsWith(` ${key}`))).toBe(false);
      }
      expect(commands.some((command) => command.startsWith("shell settings --user 0 delete"))).toBe(
        false,
      );
    });

    test("still deletes a key the journal shows the session created, and restores changed keys", async () => {
      const { adb, reply, journal, reset } = await rig([0], undefined, baselineFromCleanedDevice);
      await journal.record(SCOPE, createdSetting("system:qa_session_key"));
      reply(
        "shell settings --user 0 list system",
        `${captured("session-start.system").replace(/^font_scale=1\.0$/m, "font_scale=2.0")}\nqa_session_key=1`,
      );
      reply("shell settings --user 0 list secure", captured("session-start.secure"));
      expect(await reset()).toMatchObject({ outcome: "clean", mode: "keep-booted" });
      const commands = adb.getExecutedCommands();
      expect(commands).toContain("shell settings --user 0 delete system qa_session_key");
      expect(commands).toContain("shell settings --user 0 put system font_scale '1.0'");
      expect([...new Set(commands.filter((command) => command.includes(" delete ")))]).toEqual([
        "shell settings --user 0 delete system qa_session_key",
      ]);
    });

    test("restores a baseline key the system or session removed", async () => {
      const { adb, reply, reset } = await rig([0], undefined, baselineFromCleanedDevice);
      reply(
        "shell settings --user 0 list system",
        captured("session-start.system")
          .split("\n")
          .filter((line) => !line.startsWith("font_scale="))
          .join("\n"),
      );
      reply("shell settings --user 0 list secure", captured("session-start.secure"));
      await reset();
      expect(adb.getExecutedCommands()).toContain(
        "shell settings --user 0 put system font_scale '1.0'",
      );
    });

    test("only absent-prior raw settings rows and tool-owned keys count as session-created", () => {
      const created = sessionCreatedSettingMatcher([
        { kind: "device-setting", key: "system:a", priorValue: { state: "absent" } },
        { kind: "device-setting", key: "secure:user:10:b", priorValue: { state: "absent" } },
        { kind: "device-setting", key: "system:c", priorValue: { state: "present", value: "1" } },
        { kind: "device-setting", key: "fontScale", priorValue: { state: "absent" } },
        { kind: "installed-app", key: "system:d", priorValue: { state: "absent" } },
        { kind: "rotation", key: "device", priorValue: { state: "unobservable" } },
      ]);
      expect(["system:a", "secure:user:10:b", "system:user_rotation"].filter(created)).toEqual([
        "system:a",
        "secure:user:10:b",
        "system:user_rotation",
      ]);
      expect(
        [
          "system:c",
          "system:d",
          "fontScale",
          "system:ringtone",
          "secure:enabled_accessibility_services",
        ].filter(created),
      ).toEqual([]);
    });

    test("deletes a tool-owned key absent from the baseline once its tool journaled a row", async () => {
      const { adb, reply, journal, reset } = await rig([0], undefined, baselineFromCleanedDevice);
      await journal.record(SCOPE, {
        kind: "keep-awake",
        key: "device",
        priorValue: { state: "unobservable" },
        toolName: "keepScreenAwake",
      });
      reply(
        "shell settings --user 0 list system",
        `${captured("session-start.system")}\nscreen_off_timeout=1800000`,
      );
      reply("shell settings --user 0 list secure", captured("session-start.secure"));
      await reset();
      expect([
        ...new Set(adb.getExecutedCommands().filter((command) => command.includes(" delete "))),
      ]).toEqual(["shell settings --user 0 delete system screen_off_timeout"]);
    });
  });

  test("removes only added files under inventory roots, preserving baseline contents", async () => {
    const { adb, reply, port, journal, reset } = await rig();
    const baseline = await journal.getBaseline(SCOPE);
    expect(baseline).not.toBeNull();
    if (!baseline) {
      throw new Error("missing test baseline");
    }
    baseline.observations.push({
      kind: "shared-file",
      key: "/sdcard/Download/fixture.txt",
      value: { state: "present", value: "hash" },
    });
    await journal.deleteResource(SESSION.resourceId);
    await journal.captureBaseline(SCOPE, baseline);
    const script =
      "if [ -d '/sdcard/Download' ]; then find '/sdcard/Download' -type f -print; elif [ -e '/sdcard/Download' ]; then exit 1; fi";
    reply(
      `shell sh -c ${shellQuote(script)}`,
      "/sdcard/Download/fixture.txt\n/sdcard/Download/new.txt",
    );
    await reset();
    expect(
      adb
        .getExecutedCommands()
        .some((command) => command.includes("rm -f") && command.includes("new.txt")),
    ).toBe(true);
    expect(
      adb
        .getExecutedCommands()
        .some((command) => command.includes("rm -f") && command.includes("fixture.txt")),
    ).toBe(false);
    expect(port.certifiableKinds).not.toContain("shared-file");
  });

  test("an uncovered unplannable account journal forces fallback despite unsupported clipboard", async () => {
    let fallbacks = 0;
    const { adb, journal, reset } = await rig([0], {
      reset: async () => {
        fallbacks++;
        return { outcome: "clean", mode: "snapshot", phases: {} };
      },
    });
    adb.setCommandResponse(
      "shell cmd clipboard clear",
      createExecResult("", "Can't find service: clipboard"),
    );
    await journal.record(SCOPE, {
      kind: "account",
      key: "external",
      priorValue: { state: "absent" },
      toolName: "test",
    });
    expect(await reset()).toMatchObject({
      outcome: "fallback:snapshot",
      fallbackReason: expect.stringContaining("account:external (test)"),
    });
    expect(fallbacks).toBe(1);
    expect(await journal.list(SCOPE)).toHaveLength(1);
  });

  test("hard cleaning failure uses the injected snapshot fallback", async () => {
    let fallbacks = 0;
    const { reply, reset } = await rig([0], {
      reset: async () => {
        fallbacks++;
      },
    });
    reply("shell pm list users", "Error: package manager died");
    expect(await reset()).toMatchObject({ outcome: "fallback:snapshot", mode: "snapshot" });
    expect(fallbacks).toBe(1);
  });

  test.each(["uninstall", "revoke", "file", "clipboard"])(
    "a failed %s cleaning command requires destruction without fallback",
    async (operation) => {
      const { adb, reply, reset } = await rig();
      let command = "shell cmd clipboard clear";
      if (operation === "uninstall") {
        reply(
          "shell pm list packages -3 --user 0",
          "package:com.example.probe\npackage:com.example.new",
        );
        reply(
          "shell pm list packages --user 0",
          "package:android\npackage:com.example.probe\npackage:com.example.new",
        );
        command = "shell pm uninstall";
      }
      if (operation === "revoke") {
        reply(
          "shell dumpsys package 'com.example.probe'",
          androidPackageDump("com.example.probe").replace(
            "android.permission.CAMERA: granted=true, flags=[ USER_SET ]",
            "android.permission.CAMERA: granted=true, flags=[ USER_SET ]\n        android.permission.RECORD_AUDIO: granted=true, flags=[]",
          ),
        );
        command = "shell pm revoke";
      }
      if (operation === "file") {
        const script =
          "if [ -d '/sdcard/Download' ]; then find '/sdcard/Download' -type f -print; elif [ -e '/sdcard/Download' ]; then exit 1; fi";
        reply(`shell sh -c ${shellQuote(script)}`, "/sdcard/Download/new.txt");
        command = "rm -f";
      }
      adb.setCommandResponse(command, createExecResult("Error: failed", ""));
      await expect(reset()).rejects.toThrow("non-clean");
    },
  );

  test("ownership loss cannot continue cleaning or enter idle", async () => {
    const { adb, reset, loseOwnership } = await rig();
    loseOwnership();
    await expect(reset()).rejects.toThrow("ownership lost");
    expect(adb.getExecutedCommands()).toEqual([]);
  });
});

describe("Android putAppFile baseline coverage", () => {
  const SWEEP = `shell sh -c ${shellQuote("if [ -d '/sdcard/Download' ]; then find '/sdcard/Download' -type f -print; elif [ -e '/sdcard/Download' ]; then exit 1; fi")}`;
  const DOWNLOAD_ENTRIES = `shell sh -c ${shellQuote("if [ -d '/sdcard/Download' ]; then find '/sdcard/Download' -mindepth 1 -maxdepth 1 -print; elif [ -e '/sdcard/Download' ]; then exit 1; fi")}`;
  const userFiles = (userId?: number) =>
    deviceToolMutations(
      "putAppFile",
      {
        target: { domain: "user_files", namespace: " fixtures ", reset: true, indexMedia: true },
        files: [{ destinationPath: "docs/a.pdf" }],
        ...(userId === undefined ? {} : { userId }),
      },
      "android",
    );

  async function fallbackRig(
    users: readonly number[] = [0],
    configureBaseline?: (reply: (command: string, stdout: string) => void) => void,
  ) {
    const fallback = { count: 0 };
    const result = await rig(
      users,
      {
        reset: async () => {
          fallback.count++;
          return { outcome: "clean", mode: "snapshot", phases: {} };
        },
      },
      configureBaseline,
    );
    return { ...result, fallback };
  }

  async function journalRows(
    journal: FakeDeviceMutationJournal,
    rows: readonly { kind: string; key: string }[],
  ) {
    for (const row of rows) {
      await journal.record(SCOPE, {
        ...row,
        priorValue: { state: "unobservable" },
        toolName: "putAppFile",
      });
    }
  }

  test("user 0 rows in a namespace absent from the baseline are swept, including the directory tree", async () => {
    const { adb, reply, journal, reset, fallback } = await fallbackRig();
    const rows = userFiles();
    expect(rows.map((row) => row.kind)).toEqual(["shared-file", "shared-file", "media"]);
    await journalRows(journal, rows);
    reply(SWEEP, "/sdcard/Download/fixtures/docs/a.pdf");
    expect(await reset()).toMatchObject({ outcome: "clean", mode: "keep-booted" });
    expect(fallback.count).toBe(0);
    const commands = adb.getExecutedCommands();
    expect(commands.some((command) => command.includes("rm -f") && command.includes("a.pdf"))).toBe(
      true,
    );
    const rmdir = commands.filter((command) => command.includes("rmdir"));
    expect(rmdir).toHaveLength(1);
    expect(rmdir[0]).toContain("/sdcard/Download/fixtures");
    expect(commands.indexOf(rmdir[0]!)).toBeGreaterThan(
      commands.findIndex((command) => command.includes("rm -f") && command.includes("a.pdf")),
    );
  });

  test("explicit user 0 is covered on a multi-user baseline, other users are not", async () => {
    const covered = await fallbackRig([0, 10]);
    await journalRows(covered.journal, userFiles(0));
    expect(await covered.reset()).toMatchObject({ outcome: "clean", mode: "keep-booted" });

    for (const rows of [userFiles(10), userFiles()]) {
      const { journal, reset, fallback } = await fallbackRig([0, 10]);
      await journalRows(journal, rows);
      expect(await reset()).toMatchObject({
        outcome: "fallback:snapshot",
        fallbackReason: expect.stringContaining("user_files"),
      });
      expect(fallback.count).toBe(1);
    }
  });

  test("a namespace path present in the baseline Downloads escalates", async () => {
    const { adb, journal, reset, fallback } = await fallbackRig([0], (reply) =>
      reply(DOWNLOAD_ENTRIES, "/sdcard/Download/fixtures\n/sdcard/Download/other.txt"),
    );
    await journalRows(journal, userFiles());
    expect(await reset()).toMatchObject({ outcome: "fallback:snapshot" });
    expect(fallback.count).toBe(1);
    expect(adb.getExecutedCommands().some((command) => command.includes("rmdir"))).toBe(false);
  });

  test("a baseline without the Downloads entry inventory escalates", async () => {
    const { journal, reset, fallback } = await fallbackRig();
    const baseline = await journal.getBaseline(SCOPE);
    if (!baseline) {
      throw new Error("missing test baseline");
    }
    await journal.deleteResource(SESSION.resourceId);
    await journal.captureBaseline(SCOPE, {
      ...baseline,
      observations: baseline.observations.filter((entry) => entry.key !== "download-entries"),
    });
    await journalRows(journal, userFiles(0));
    expect(await reset()).toMatchObject({ outcome: "fallback:snapshot" });
    expect(fallback.count).toBe(1);
  });

  test("an unremovable namespace tree fails cleaning closed", async () => {
    const { adb, journal, reset, fallback } = await fallbackRig();
    await journalRows(journal, userFiles());
    adb.setCommandResponse("rmdir", createExecResult("", "rmdir: Directory not empty"));
    expect(await reset()).toMatchObject({ outcome: "fallback:snapshot" });
    expect(fallback.count).toBe(1);
  });

  test("namespace coverage rejects unsafe, mistyped or baseline-backed scopes", () => {
    const baseline = {
      completeKinds: [],
      unobservable: [],
      observations: [
        { kind: "installed-app", key: "users:0", value: { state: "present", value: true } },
        { kind: "shared-file", key: "download-entries", value: { state: "present", value: "[]" } },
        {
          kind: "shared-file",
          key: "/sdcard/Download/kept/a.txt",
          value: { state: "present", value: "hash" },
        },
      ],
    } satisfies DeviceBaseline;
    const key = (namespace: string, user: unknown = "default", path: string | null = "a") =>
      JSON.stringify(["user_files", null, null, namespace, user, ...(path === null ? [] : [path])]);
    expect(
      androidUserFilesNamespaceCovered({ kind: "shared-file", key: key("ns") }, baseline),
    ).toBe("/sdcard/Download/ns");
    expect(
      androidUserFilesNamespaceCovered({ kind: "media", key: key("ns", 0, null) }, baseline),
    ).toBe("/sdcard/Download/ns");
    for (const entry of [
      { kind: "shared-file", key: key("kept") },
      { kind: "shared-file", key: key("..") },
      { kind: "shared-file", key: key("a/b") },
      { kind: "shared-file", key: key("  ") },
      { kind: "shared-file", key: key("ns", "0") },
      { kind: "media", key: key("ns") },
      { kind: "shared-file", key: key("ns", 0, null) },
      { kind: "preference", key: key("ns") },
      { kind: "shared-file", key: "/sdcard/Download/ns/a" },
    ]) {
      expect(androidUserFilesNamespaceCovered(entry, baseline)).toBeUndefined();
    }
    expect(androidUserFilesNamespaceCovered({ kind: "shared-file", key: key("ns") }, null)).toBe(
      undefined,
    );
  });

  test("app-container writes are covered only for apps absent from the baseline", async () => {
    const write = (appId: string) =>
      deviceToolMutations(
        "putAppFile",
        {
          target: { domain: "app_containers", appId, container: "files" },
          files: [{ destinationPath: "seed.json" }],
        },
        "android",
      );
    const covered = await fallbackRig();
    await journalRows(covered.journal, write("com.example.session"));
    expect(await covered.reset()).toMatchObject({ outcome: "clean", mode: "keep-booted" });

    const held = await fallbackRig();
    await journalRows(held.journal, write("com.example.probe"));
    expect(await held.reset()).toMatchObject({
      outcome: "fallback:snapshot",
      fallbackReason: expect.stringContaining("com.example.probe"),
    });
  });
});

describe("cleaning adb under load", () => {
  test("captured secure settings timeout retries and cleaning stays clean", async () => {
    const { adb } = androidBaselineRig();
    const timer = new FakeTimer();
    const journal = new FakeDeviceMutationJournal(timer);
    const port = new AndroidDeviceMutationResetPort(adb, timer);
    const strategy = new AndroidKeepBootedReset({ journal, port: () => port, timer });
    await strategy.capture(ANDROID_RESET_DEVICE, {
      ...SESSION,
      timeoutMs: 600_000,
      signal: new AbortController().signal,
      assertOwned: async () => {},
    });
    const execute = adb.executeCommand.bind(adb);
    let reads = 0;
    adb.executeCommand = async (command, options) => {
      if (command === "shell settings --user 0 list secure" && ++reads === 1) {
        throw new Error(SETTINGS_TIMEOUT);
      }
      return execute(command, options);
    };
    timer.enableAutoAdvance();
    const result = await strategy.reset(ANDROID_RESET_DEVICE, new Set(), async () => {}, {
      ...SESSION,
      timeoutMs: 600_000,
      deadlineMs: 600_000,
    });
    expect(result.outcome).toBe("clean");
    expect(reads).toBe(2);
    expect(timer.getSleepHistory()).toEqual([250]);
  });
});

test.each([false, true])(
  "non-critical setting restore re-read matches baseline (absent: %s)",
  async (absent) => {
    const { adb, journal, reset } = await rig();
    const key = absent ? "optional_key" : "animator_duration_scale";
    if (absent) {
      await journal.record(SCOPE, createdSetting(`global:${key}`));
    }
    adb.setCommandResponseSequence("shell settings --user 0 list global", [
      createExecResult(`${key}=0`, ""),
      createExecResult(absent ? "" : `${key}=0.5`, ""),
    ]);
    adb.setCommandResponse(
      absent
        ? `shell settings --user 0 delete global ${key}`
        : `shell settings --user 0 put global ${key} '0.5'`,
      createExecResult("Error: refused", ""),
    );
    expect(await reset()).toMatchObject({ outcome: "clean", mode: "keep-booted" });
    expect(
      adb
        .getExecutedCommands()
        .filter((command) => command === "shell settings --user 0 list global"),
    ).toHaveLength(2);
  },
);

test("persistent non-critical restore failures escalate and name every still-dirty key", async () => {
  let fallbacks = 0;
  const { adb, journal, reset } = await rig([0], {
    reset: async () => {
      fallbacks++;
      return { outcome: "clean", mode: "snapshot", phases: {} };
    },
  });
  for (const key of ["dirty_a", "dirty_b", "now_clean"]) {
    await journal.record(SCOPE, createdSetting(`global:${key}`));
  }
  adb.setCommandResponseSequence("shell settings --user 0 list global", [
    createExecResult("dirty_a=1\ndirty_b=2\nnow_clean=3", ""),
    createExecResult("dirty_a=1\ndirty_b=2", ""),
  ]);
  for (const key of ["dirty_a", "dirty_b", "now_clean"]) {
    adb.setCommandResponse(
      `shell settings --user 0 delete global ${key}`,
      createExecResult("Error: refused", ""),
    );
  }
  const result = await reset();
  expect(result.outcome).toBe("fallback:snapshot");
  expect(result.fallbackReason).toContain("global:dirty_a, global:dirty_b");
  expect(result.fallbackReason).not.toContain("now_clean");
  expect(fallbacks).toBe(1);
});

describe("Android keep-booted accounts, time zone and device locale (#14364)", () => {
  const ACCOUNT = "    Account {name=user@example.com, type=com.example.auth}";

  async function fallbackRig(
    configureBaseline?: (reply: (command: string, stdout: string) => void) => void,
  ) {
    let fallbacks = 0;
    const result = await rig(
      [0],
      {
        reset: async () => {
          fallbacks++;
          return { outcome: "clean", mode: "snapshot", phases: {} };
        },
      },
      configureBaseline,
    );
    return { ...result, fallbacks: () => fallbacks };
  }

  test.each([
    ["added", undefined, `User UserInfo{0:Owner:c13}:\n  Accounts: 1\n${ACCOUNT}`],
    [
      "removed",
      `User UserInfo{0:Owner:c13}:\n  Accounts: 1\n${ACCOUNT}`,
      "User UserInfo{0:Owner:c13}:\n  Accounts: 0",
    ],
  ])("an account %s during the session escalates", async (_label, before, after) => {
    const { reply, reset, fallbacks } = await fallbackRig((baselineReply) => {
      if (before) {
        baselineReply("shell dumpsys account", before);
      }
    });
    reply("shell dumpsys account", after);
    const result = await reset();
    expect(result.outcome).toBe("fallback:snapshot");
    expect(result.fallbackReason).toContain("changed accounts for user 0");
    expect(result.fallbackReason).not.toContain("user@example.com");
    expect(fallbacks()).toBe(1);
  });

  test("an unreadable account list at reset escalates", async () => {
    const { reply, reset } = await fallbackRig();
    reply("shell dumpsys account", "Can't find service: account");
    expect(await reset()).toMatchObject({
      outcome: "fallback:snapshot",
      fallbackReason: expect.stringContaining("account inventory is unreadable"),
    });
  });

  test("accounts are read after uninstalling session apps, whose authenticator accounts go with them", async () => {
    const { adb, reply, reset } = await rig();
    reply(
      "shell pm list packages -3 --user 0",
      "package:com.example.probe\npackage:com.example.auth",
    );
    reply(
      "shell pm list packages --user 0",
      "package:android\npackage:com.example.probe\npackage:com.example.auth",
    );
    reply("shell pm uninstall", "Success");
    expect(await reset()).toMatchObject({ outcome: "clean", mode: "keep-booted" });
    const commands = adb.getExecutedCommands();
    expect(commands.indexOf("shell dumpsys account")).toBeGreaterThan(
      commands.indexOf("shell pm uninstall --user 0 'com.example.auth'"),
    );
  });

  test("an out-of-band time zone change is restored in place and read back", async () => {
    const { adb, reset } = await rig();
    adb.setCommandResponseSequence("shell getprop persist.sys.timezone", [
      createExecResult("Asia/Tokyo", ""),
      createExecResult("America/Chicago", ""),
    ]);
    expect(await reset()).toMatchObject({ outcome: "clean", mode: "keep-booted" });
    expect(adb.getExecutedCommands()).toContain("shell cmd alarm set-timezone 'America/Chicago'");
  });

  test("a time zone that does not read back after restore escalates", async () => {
    const { adb, reset } = await fallbackRig();
    adb.setCommandResponse(
      "shell getprop persist.sys.timezone",
      createExecResult("Asia/Tokyo", ""),
    );
    expect(await reset()).toMatchObject({ outcome: "fallback:snapshot" });
    expect(adb.getExecutedCommands()).toContain("shell cmd alarm set-timezone 'America/Chicago'");
  });

  test("a changed time zone escalates when the baseline had none", async () => {
    const { adb, reply, reset } = await fallbackRig((baselineReply) =>
      baselineReply("shell getprop persist.sys.timezone", ""),
    );
    reply("shell getprop persist.sys.timezone", "Asia/Tokyo");
    expect(await reset()).toMatchObject({
      outcome: "fallback:snapshot",
      fallbackReason: expect.stringContaining("time zone the baseline lacks"),
    });
    expect(adb.getExecutedCommands().some((command) => command.includes("set-timezone"))).toBe(
      false,
    );
  });

  test("a journaled changeLocalization time zone with a readable prior reverts in place", async () => {
    const { adb, journal, reset } = await rig();
    for (const row of deviceToolMutations(
      "changeLocalization",
      { timeZone: "Asia/Tokyo" },
      "android",
    )) {
      await journal.record(SCOPE, {
        ...row,
        priorValue: { state: "present", value: "America/Chicago" },
        toolName: "changeLocalization",
      });
    }
    expect(await reset()).toMatchObject({ outcome: "clean", mode: "keep-booted" });
    expect(adb.getExecutedCommands()).toContain("shell cmd alarm set-timezone 'America/Chicago'");
  });

  test("a journaled time zone with an unreadable prior escalates", async () => {
    const { journal, reset } = await fallbackRig();
    await journal.record(SCOPE, {
      kind: "clock",
      key: "timezone",
      priorValue: { state: "unobservable" },
      toolName: "changeLocalization",
    });
    expect(await reset()).toMatchObject({
      outcome: "fallback:snapshot",
      fallbackReason: expect.stringContaining("clock:timezone (changeLocalization)"),
    });
  });

  test("a journaled device-wide locale change never reports clean, even with a readable prior", async () => {
    const { journal, reset } = await fallbackRig();
    for (const row of deviceToolMutations("changeLocalization", { locale: "fr-FR" }, "android")) {
      await journal.record(SCOPE, {
        ...row,
        priorValue: { state: "present", value: "en-US" },
        toolName: "changeLocalization",
      });
    }
    expect(await reset()).toMatchObject({
      outcome: "fallback:snapshot",
      fallbackReason: expect.stringContaining("device-setting:locale (changeLocalization)"),
    });
  });

  test("an out-of-band device locale change escalates even when the system_locales row is restored", async () => {
    const { adb, reply, reset } = await fallbackRig();
    reply("shell settings --user 0 list system", "font_scale=1.0\nsystem_locales=fr-FR");
    reply("shell getprop persist.sys.locale", "fr-FR");
    expect(await reset()).toMatchObject({
      outcome: "fallback:snapshot",
      fallbackReason: expect.stringContaining("changed device locale"),
    });
    expect(adb.getExecutedCommands()).toContain(
      "shell settings --user 0 put system system_locales 'en-US'",
    );
  });
});
