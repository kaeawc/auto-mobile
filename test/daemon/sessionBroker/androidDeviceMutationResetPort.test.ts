import { FakeTimer } from "../../fakes/FakeTimer";

import { beforeEach, describe, expect, test } from "bun:test";
import { AndroidDeviceMutationResetPort } from "../../../src/daemon/sessionBroker/androidDeviceMutationResetPort";
import type { DeviceMutationResetContext } from "../../../src/daemon/sessionBroker/mutations/reset";
import type {
  DeviceMutationInput,
  MutationValue,
} from "../../../src/daemon/sessionBroker/mutations/types";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { createExecResult } from "../../../src/utils/execResult";
import { shellQuote } from "../../../src/utils/shellQuote";

const ABSENT: MutationValue = { state: "absent" };
const present = (value: string | boolean): MutationValue => ({ state: "present", value });
const mutation = (kind: string, key: string, priorValue: MutationValue): DeviceMutationInput => ({
  kind,
  key,
  priorValue,
  toolName: "test",
});

describe("AndroidDeviceMutationResetPort", () => {
  let adb: FakeAdbExecutor;
  let port: AndroidDeviceMutationResetPort;
  let controller: AbortController;
  let context: DeviceMutationResetContext;
  let fences: number;

  beforeEach(() => {
    adb = new FakeAdbExecutor();
    adb.setCommandResponse(
      "shell pm list packages --user 10",
      createExecResult("package:android\npackage:com.example.probe", ""),
    );
    adb.setCommandResponse("shell pm uninstall", createExecResult("Success", ""));
    adb.setCommandResponse("shell pm clear", createExecResult("Success", ""));
    port = new AndroidDeviceMutationResetPort(adb);
    controller = new AbortController();
    fences = 0;
    context = {
      scope: { deviceId: "emulator-5554", incarnation: "resource", sessionUuid: "session" },
      signal: controller.signal,
      assertOwned: async () => {
        fences++;
      },
    };
  });

  test("force-stops and uninstalls a session package with confirmed success", async () => {
    await port.revert(mutation("installed-app", "user:10:com.example.probe", ABSENT), context);
    expect(adb.getExecutedCommands()).toEqual([
      "shell pm list packages --user 10",
      "shell am force-stop --user 10 'com.example.probe'",
      "shell pm uninstall --user 10 'com.example.probe'",
    ]);
    expect(fences).toBe(6);
    for (const options of adb.getCommandCalls()) {
      expect(options).toMatchObject({
        noRetry: true,
        signal: controller.signal,
        waitForProcessSettlementAfterAbort: true,
      });
    }
    expect(adb.getCommandCalls().map((call) => call.timeoutMs)).toEqual([2000, 2000, 10_000]);
  });

  test.each([
    ["CAMERA", false, "revoke"],
    ["ACCESS_FINE_LOCATION", true, "grant"],
    ["POST_NOTIFICATIONS", false, "revoke"],
  ] as const)(
    "restores prior %s permission without device-wide reset",
    async (permission, prior, verb) => {
      await port.revert(
        mutation(
          "permission",
          `runtime:10:com.example.probe:android.permission.${permission}`,
          present(prior),
        ),
        context,
      );
      expect(adb.getExecutedCommands()).toEqual([
        `shell pm ${verb} --user 10 'com.example.probe' 'android.permission.${permission}'`,
      ]);
    },
  );

  test.each([ABSENT, present("foreground")])(
    "restores the prior app-op mode",
    async (priorValue) => {
      await port.revert(
        mutation("permission", "appops:0:com.example.probe:MOCK_LOCATION", priorValue),
        context,
      );
      expect(adb.getExecutedCommands()).toEqual([
        `shell cmd appops set --user 0 'com.example.probe' 'MOCK_LOCATION' ${priorValue.state === "absent" ? "default" : "foreground"}`,
      ]);
    },
  );

  test.each([
    [
      "global:animator_duration_scale",
      present("0.5"),
      "shell settings --user 0 put global animator_duration_scale '0.5'",
    ],
    [
      "global:transition_animation_scale",
      present("1"),
      "shell settings --user 0 put global transition_animation_scale '1'",
    ],
    [
      "global:window_animation_scale",
      ABSENT,
      "shell settings --user 0 delete global window_animation_scale",
    ],
    ["system:font_scale", present("1.2"), "shell settings --user 0 put system font_scale '1.2'"],
    [
      "system:system_locales",
      present("en-US"),
      "shell settings --user 0 put system system_locales 'en-US'",
    ],
    [
      "system:user:10:system_locales",
      present("fr-FR"),
      "shell settings --user 10 put system system_locales 'fr-FR'",
    ],
    [
      "secure:user:10:location_mode",
      present("3"),
      "shell settings --user 10 put secure location_mode '3'",
    ],
    [
      "secure:user:10:untracked-key",
      ABSENT,
      "shell settings --user 10 delete secure untracked-key",
    ],
    [
      "secure:default_input_method",
      ABSENT,
      "shell settings --user 0 delete secure default_input_method",
    ],
    [
      "secure:enabled_accessibility_services",
      present("com.example/.Service"),
      "shell settings --user 0 put secure enabled_accessibility_services 'com.example/.Service'",
    ],
    [
      "global:stay_on_while_plugged_in",
      present("0"),
      "shell settings --user 0 put global stay_on_while_plugged_in '0'",
    ],
    ["system:time_12_24", ABSENT, "shell settings --user 0 delete system time_12_24"],
    ["display:density", ABSENT, "shell wm density reset"],
    ["display:density", present("420"), "shell wm density 420"],
    ["display:size", ABSENT, "shell wm size reset"],
    ["display:size", present("1080x1920"), "shell wm size 1080x1920"],
    ["display:night-mode", present("auto"), "shell cmd uimode night auto"],
    ["global:airplane_mode_on", present("0"), "shell cmd connectivity airplane-mode disable"],
    ["global:wifi_on", present("1"), "shell svc wifi enable"],
    ["global:mobile_data", present("0"), "shell svc data disable"],
    ["global:zen_mode", present("2"), "shell cmd notification set_dnd none"],
  ] as const)("restores %s to its exact prior value", async (key, priorValue, command) => {
    await port.revert(mutation("device-setting", key, priorValue), context);
    expect(adb.getExecutedCommands()).toEqual([command]);
  });

  test("user-0 put and delete target the captured user, never the foreground user's default", async () => {
    await port.revert(
      mutation("device-setting", "secure:user:0:location_mode", present("3")),
      context,
    );
    await port.revert(mutation("device-setting", "system:added_key", ABSENT), context);
    expect(adb.getExecutedCommands()).toEqual([
      "shell settings --user 0 put secure location_mode '3'",
      "shell settings --user 0 delete system added_key",
    ]);
  });

  test.each([
    ["rotation", "system:accelerometer_rotation", "1"],
    ["keep-awake", "global:stay_on_while_plugged_in", "0"],
    ["screen-reader", "secure:accessibility_enabled", "0"],
    ["keyboard", "secure:enabled_input_methods", "com.example/.Keyboard"],
    ["clock", "global:auto_time", "1"],
    ["clock", "global:auto_time_zone", "1"],
  ])("supports the %s setting journal kind", async (kind, key, prior) => {
    await port.revert(mutation(kind, key, present(prior)), context);
    const [namespace, name] = key.split(":");
    expect(adb.getExecutedCommands()).toEqual([
      `shell settings --user 0 put ${namespace} ${name} ${shellQuote(prior)}`,
    ]);
  });

  test("clears only known-empty retained app data", async () => {
    await port.revert(mutation("preference", "app-data:0:com.example.probe", ABSENT), context);
    expect(adb.getExecutedCommands()).toEqual([
      "shell am force-stop --user 0 'com.example.probe'",
      "shell pm clear --user 0 'com.example.probe'",
    ]);
    expect(
      port.canRevert(
        mutation("preference", "app-data:0:com.example.probe", present("baseline data")),
      ),
    ).toBe(false);
  });

  test("restores timezone via the platform alarm service", async () => {
    await port.revert(mutation("clock", "timezone", present("America/Chicago")), context);
    expect(adb.getExecutedCommands()).toEqual(["shell cmd alarm set-timezone 'America/Chicago'"]);
  });

  test("removes a journaled mock provider and clears an originally empty clipboard", async () => {
    await port.revert(mutation("location", "provider:gps", ABSENT), context);
    await port.revert(mutation("clipboard", "device", present("")), context);
    expect(adb.getExecutedCommands()).toEqual([
      "shell cmd location providers remove-test-provider gps",
      "shell cmd clipboard clear",
    ]);
  });

  test("deletes a journaled sdcard file behind a canonical-path guard and requests rescan", async () => {
    const path = "/sdcard/Download/probe photo.jpg";
    await port.revert(mutation("shared-file", path, ABSENT), context);
    const script = `root=$(readlink -f /sdcard) && [ -n "$root" ] && target=$(readlink -f ${shellQuote(path)}) && [ "$target" = "$root"${shellQuote("/Download/probe photo.jpg")} ] && [ ! -L ${shellQuote(path)} ] && rm -f -- ${shellQuote(path)}`;
    expect(adb.getExecutedCommands()).toEqual([
      `shell sh -c ${shellQuote(script)}`,
      "shell am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d 'file:///sdcard/Download/probe photo.jpg'",
    ]);
  });

  test.each([
    "/sdcard/../data/file",
    "/sdcard/Download/../../file",
    "/data/local/tmp/file",
    "/sdcard/Download/",
    "/sdcard/Download//file",
    "/sdcard/Download/bad\nfile",
  ])("refuses unsafe shared-file path %s", async (path) => {
    const entry = mutation("shared-file", path, ABSENT);
    expect(port.canRevert(entry)).toBe(false);
    await expect(port.revert(entry, context)).rejects.toThrow("cannot restore");
    expect(adb.getExecutedCommands()).toEqual([]);
  });

  test.each([
    mutation("installed-app", "com.example.probe", ABSENT),
    mutation("installed-app", "com.example.probe", present("old APK")),
    mutation("device-setting", "locale", present("en-US")),
    mutation("device-setting", "system:user:bad:system_locales", present("en-US")),
    mutation("device-setting", "global:--user", present("10")),
    mutation("device-setting", "global:wifi_on", present("3")),
    mutation("account", "inventory", ABSENT),
    mutation("network-condition", "device", ABSENT),
    mutation("notification", "com.example.probe", ABSENT),
    mutation("shared-file", "/sdcard/Download/file", present("old contents")),
    mutation("future-kind", "device", ABSENT),
  ])("fails closed for unsupported $kind:$key", async (entry) => {
    expect(port.canRevert(entry)).toBe(false);
    await expect(port.revert(entry, context)).rejects.toThrow("cannot restore");
    expect(adb.getExecutedCommands()).toEqual([]);
  });

  test.each(["Failure [DELETE_FAILED_INTERNAL_ERROR]", "", "Success\nError: denied"])(
    "does not accept an unconfirmed package uninstall",
    async (stdout) => {
      adb.setCommandResponse("shell pm uninstall", createExecResult(stdout, ""));
      await expect(
        port.revert(mutation("installed-app", "user:10:com.example.probe", ABSENT), context),
      ).rejects.toThrow();
    },
  );

  test("skips unsupported clipboard output even when adb exits successfully", async () => {
    adb.setCommandResponse(
      "shell cmd clipboard clear",
      createExecResult("Can't find service: clipboard", ""),
    );
    await port.revert(mutation("clipboard", "device", ABSENT), context);
    expect(adb.getExecutedCommands()).toEqual(["shell cmd clipboard clear"]);
  });

  test.each([
    "Exception occurred while executing 'put':\njava.lang.SecurityException: denied",
    "java.lang.SecurityException: denied",
    "previous output\nError: denied\nmore output",
    "previous output\nUnknown command: put\nmore output",
    "previous output\nPermission Denial: denied\nmore output",
  ])("rejects shell failure stdout during setting replay: %s", async (stdout) => {
    adb.setCommandResponse("shell settings --user 0 put", createExecResult(stdout, ""));
    await expect(
      port.revert(
        mutation("device-setting", "global:window_animation_scale", present("1")),
        context,
      ),
    ).rejects.toThrow("command failed");
  });

  test("ownership loss after force-stop prevents the uninstall dispatch", async () => {
    context.assertOwned = async () => {
      if (++fences === 5) {
        throw new Error("ownership lost");
      }
    };
    await expect(
      port.revert(mutation("installed-app", "user:10:com.example.probe", ABSENT), context),
    ).rejects.toThrow("ownership lost");
    expect(adb.getExecutedCommands()).toEqual([
      "shell pm list packages --user 10",
      "shell am force-stop --user 10 'com.example.probe'",
    ]);
  });

  test("quotes setting values as literal shell arguments", async () => {
    const prior = " leading '; echo injected; ' trailing ";
    await port.revert(
      mutation("device-setting", "secure:enabled_input_methods", present(prior)),
      context,
    );
    expect(adb.getExecutedCommands()).toEqual([
      `shell settings --user 0 put secure enabled_input_methods ${shellQuote(prior)}`,
    ]);
  });

  test("already-absent session package is an idempotent no-op only after authoritative inventory", async () => {
    adb.setCommandResponse(
      "shell pm list packages --user 10",
      createExecResult("package:android\npackage:com.example.probe.suffix", ""),
    );
    await port.revert(mutation("installed-app", "user:10:com.example.probe", ABSENT), context);
    expect(adb.getExecutedCommands()).toEqual(["shell pm list packages --user 10"]);
  });

  test("an empty package read is not evidence that the session package is absent", async () => {
    adb.setCommandResponse("shell pm list packages --user 10", createExecResult("", ""));
    await expect(
      port.revert(mutation("installed-app", "user:10:com.example.probe", ABSENT), context),
    ).rejects.toThrow("confirm package absence");
    expect(adb.getExecutedCommands()).toEqual(["shell pm list packages --user 10"]);
  });

  test("an aborted reset does not dispatch adb", async () => {
    controller.abort(new Error("cancelled"));
    await expect(port.revert(mutation("clipboard", "device", ABSENT), context)).rejects.toThrow(
      "cancelled",
    );
    expect(adb.getExecutedCommands()).toEqual([]);
  });
});

describe("non-idempotent reset commands", () => {
  test.each(["uninstall", "clear"])("pm %s timeout has one derived attempt", async (verb) => {
    const timer = new FakeTimer();
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse(
      "shell pm list packages --user 10",
      createExecResult("package:android\npackage:com.example.probe", ""),
    );
    adb.setCommandError(`shell pm ${verb}`, new Error("Command timed out after 2000ms: adb"));
    const port = new AndroidDeviceMutationResetPort(adb, timer);
    const context: DeviceMutationResetContext = {
      scope: { deviceId: "emulator-5558", incarnation: "a", sessionUuid: "b" },
      deadlineMs: 60_000,
      signal: new AbortController().signal,
      assertOwned: async () => {},
    };
    await expect(
      port.revert(
        mutation(
          verb === "uninstall" ? "installed-app" : "preference",
          verb === "uninstall" ? "user:10:com.example.probe" : "app-data:10:com.example.probe",
          ABSENT,
        ),
        context,
      ),
    ).rejects.toThrow("timed out");
    const calls = adb
      .getCommandCalls()
      .filter((call) => call.command.startsWith(`shell pm ${verb}`));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.timeoutMs).toBe(verb === "uninstall" ? 10_000 : 7500);
    expect(timer.getSleepHistory()).toEqual([]);
  });
});
