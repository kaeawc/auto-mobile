import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, test } from "bun:test";
import {
  applyKillProfile,
  parseAppOpMode,
  parseHibernationState,
  parseStandbyBucket,
  resetKillProfile,
} from "../../../src/features/utility/ApplyKillProfile";
import { KillProfileRestoreRegistry } from "../../../src/features/utility/KillProfileRestore";
import { KILL_PROFILE_IDS, KILL_PROFILES } from "../../../src/features/utility/KillProfiles";
import type { BootedDevice } from "../../../src/models";
import { createExecResult } from "../../../src/utils/execResult";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";

const emulator: BootedDevice = { name: "emu", platform: "android", deviceId: "emulator-5554" };
const APP = "com.example.app";
// Captures contain only the runtime section; supply the package/user context dumpsys normally has.
const notificationDump = (state: "granted" | "revoked", appId = APP) =>
  `Packages:\n  Package [${appId}] (test):\n    User 0: installed=true\n${readFileSync(
    new URL(
      `../../fixtures/android-notification-enabled/api35-deskclock-${state}-dumpsys-package.txt`,
      import.meta.url,
    ),
    "utf8",
  )}`;
const grantedNotifications = notificationDump("granted");
const revokedNotifications = notificationDump("revoked");
const Q = `'${APP}'`;

describe("kill profiles (#14051)", () => {
  let adb: FakeAdbExecutor;
  let registry: KillProfileRestoreRegistry;

  beforeEach(() => {
    adb = new FakeAdbExecutor();
    adb.setAndroidApiLevel(34);
    adb.setCommandResponse("shell pm path", createExecResult("package:/data/app/base.apk\n", ""));
    adb.setCommandResponse(
      "shell dumpsys battery",
      createExecResult("Current Battery Service state:\n  AC powered: true\n", ""),
    );
    adb.setCommandResponse("shell am get-standby-bucket", createExecResult("10\n", ""));
    adb.setCommandResponse("shell appops get", createExecResult("No operations.\n", ""));
    registry = new KillProfileRestoreRegistry();
  });

  const deps = (owner?: string) => ({ shell: adb, registry, owner });
  const writes = () =>
    adb
      .getExecutedCommands()
      .filter(
        (command) =>
          !/pm path|dumpsys package|appops get|app_hibernation get-state|get-standby-bucket|^shell dumpsys battery$/.test(
            command,
          ),
      );

  test("every catalog entry is versioned and evidenced", () => {
    for (const id of KILL_PROFILE_IDS) {
      const profile = KILL_PROFILES[id];
      expect(profile.id).toBe(id);
      expect(profile.version).toBeGreaterThan(0);
      expect(profile.steps.length).toBeGreaterThan(0);
      expect(profile.evidenceNote.length).toBeGreaterThan(0);
    }
    expect(KILL_PROFILES["user-restricted"].evidenceStatus).toBe("cdd_derived");
    expect(KILL_PROFILES["samsung-sleeping"].evidenceStatus).toBe("vendor_documented");
  });

  test("user-restricted ignores RUN_ANY_IN_BACKGROUND and records the default for reset", async () => {
    const result = await applyKillProfile(emulator, APP, "user-restricted", deps());
    expect(result).toMatchObject({
      status: "applied",
      profile: { id: "user-restricted", version: 1, evidenceStatus: "cdd_derived" },
      steps: [{ step: "appops RUN_ANY_IN_BACKGROUND ignore", status: "applied" }],
      restore: {
        commands: [`shell appops set ${Q} RUN_ANY_IN_BACKGROUND default`],
        onSessionRelease: false,
      },
    });
    expect(writes()).toEqual([`shell appops set ${Q} RUN_ANY_IN_BACKGROUND ignore`]);
  });

  test.each(["granted", "revoked"] as const)(
    "notifications-off restores the original %s grant on reset",
    async (original) => {
      adb.setCommandResponseSequence(`shell dumpsys package ${Q}`, [
        createExecResult(original === "granted" ? grantedNotifications : revokedNotifications, ""),
        createExecResult(revokedNotifications, ""),
      ]);
      const result = await applyKillProfile(emulator, APP, "notifications-off", deps());
      expect(result.status).toBe("applied");
      expect(result.profile.version).toBe(2);
      expect(writes()).toEqual([`shell pm revoke ${Q} android.permission.POST_NOTIFICATIONS`]);
      const commands = adb.getExecutedCommands();
      expect(commands.indexOf(`shell dumpsys package ${Q}`)).toBeLessThan(
        commands.indexOf(`shell pm revoke ${Q} android.permission.POST_NOTIFICATIONS`),
      );
      expect(commands.filter((command) => command === `shell dumpsys package ${Q}`)).toHaveLength(
        2,
      );
      const restoreCommand =
        original === "granted" ? `shell pm grant ${Q} android.permission.POST_NOTIFICATIONS` : null;
      expect(registry.pendingFor(emulator.deviceId, APP)).toEqual([
        {
          key: `notificationPermission:${APP}`,
          appId: APP,
          command: restoreCommand,
        },
      ]);
      expect(result.restore?.commands).toEqual(restoreCommand ? [restoreCommand] : undefined);

      adb.clearHistory();
      const reset = await resetKillProfile(emulator, APP, {}, deps());
      expect(reset).toMatchObject({ source: "recorded", status: "applied" });
      expect(writes()).toEqual(restoreCommand ? [restoreCommand] : []);
      expect(registry.pendingFor(emulator.deviceId, APP)).toEqual([]);
    },
  );

  test("notifications-off keeps the first grant across repeated applies", async () => {
    adb.setCommandResponseSequence(`shell dumpsys package ${Q}`, [
      createExecResult(grantedNotifications, ""),
      createExecResult(revokedNotifications, ""),
      createExecResult(revokedNotifications, ""),
      createExecResult(revokedNotifications, ""),
    ]);
    await applyKillProfile(emulator, APP, "notifications-off", deps());
    const again = await applyKillProfile(emulator, APP, "notifications-off", deps());
    expect(again.restore?.commands).toEqual([
      `shell pm grant ${Q} android.permission.POST_NOTIFICATIONS`,
    ]);
  });

  const grantRecord = {
    key: `notificationPermission:${APP}`,
    appId: APP,
    command: `shell pm grant ${Q} android.permission.POST_NOTIFICATIONS`,
  };

  test("notifications-off drops a new record when read-back is still granted", async () => {
    adb.setCommandResponseSequence(`shell dumpsys package ${Q}`, [
      createExecResult(grantedNotifications, ""),
      createExecResult(grantedNotifications, ""),
    ]);
    await expect(applyKillProfile(emulator, APP, "notifications-off", deps())).rejects.toThrow(
      "POST_NOTIFICATIONS still granted after pm revoke",
    );
    expect(registry.pendingFor(emulator.deviceId, APP)).toEqual([]);
  });

  test.each([
    { name: "unreadable", readback: "" },
    { name: "a shell read failure", readback: "Exception: read refused" },
  ])(
    "notifications-off keeps the record when read-back is $name, since revoke may have landed",
    async ({ readback }) => {
      adb.setCommandResponseSequence(`shell dumpsys package ${Q}`, [
        createExecResult(grantedNotifications, ""),
        createExecResult(readback, ""),
      ]);
      await expect(applyKillProfile(emulator, APP, "notifications-off", deps())).rejects.toThrow(
        "Could not read POST_NOTIFICATIONS",
      );
      expect(registry.pendingFor(emulator.deviceId, APP)).toEqual([grantRecord]);
    },
  );

  test("notifications-off keeps the record when read-back throws after revoke", async () => {
    adb.setCommandResponse(
      `shell dumpsys package ${Q}`,
      createExecResult(grantedNotifications, ""),
    );
    const shell = new (class extends FakeAdbExecutor {
      override async executeCommand(
        command: string,
        options?: Parameters<FakeAdbExecutor["executeCommand"]>[1],
      ) {
        const result = await adb.executeCommand(command, options);
        if (command.includes("pm revoke")) {
          adb.setCommandError(`shell dumpsys package ${Q}`, new Error("adb connection closed"));
        }
        return result;
      }
    })();
    await expect(
      applyKillProfile(emulator, APP, "notifications-off", { shell, registry }),
    ).rejects.toThrow("adb connection closed");
    expect(registry.pendingFor(emulator.deviceId, APP)).toEqual([grantRecord]);

    adb.clearHistory();
    const reset = await resetKillProfile(emulator, APP, {}, deps());
    expect(reset).toMatchObject({ source: "recorded", status: "applied" });
    expect(writes()).toEqual([grantRecord.command]);
  });

  test("notifications-off reads a package whose name contains a failure keyword", async () => {
    const appId = "com.example.exception";
    const quoted = `'${appId}'`;
    adb.setCommandResponseSequence(`shell dumpsys package ${quoted}`, [
      createExecResult(notificationDump("granted", appId), ""),
      createExecResult(notificationDump("revoked", appId), ""),
    ]);
    const result = await applyKillProfile(emulator, appId, "notifications-off", deps());
    expect(result.status).toBe("applied");
    expect(result.restore?.commands).toEqual([
      `shell pm grant ${quoted} android.permission.POST_NOTIFICATIONS`,
    ]);
  });

  test("notifications-off drops a new record when revoke fails", async () => {
    adb.setCommandResponse(
      `shell dumpsys package ${Q}`,
      createExecResult(grantedNotifications, ""),
    );
    adb.setCommandResponse(
      `shell pm revoke ${Q}`,
      createExecResult("", "Exception: revoke refused"),
    );
    await expect(applyKillProfile(emulator, APP, "notifications-off", deps())).rejects.toThrow(
      "revoke refused",
    );
    expect(registry.pendingFor(emulator.deviceId, APP)).toEqual([]);
    expect(
      adb.getExecutedCommands().filter((command) => command === `shell dumpsys package ${Q}`),
    ).toHaveLength(1);
  });

  test("notifications-off keeps the record when the revoke transport throws", async () => {
    adb.setCommandResponse(
      `shell dumpsys package ${Q}`,
      createExecResult(grantedNotifications, ""),
    );
    adb.setCommandError(`shell pm revoke ${Q}`, new Error("revoke transport failed"));
    await expect(applyKillProfile(emulator, APP, "notifications-off", deps())).rejects.toThrow(
      "revoke transport failed",
    );
    expect(registry.pendingFor(emulator.deviceId, APP)).toEqual([grantRecord]);
  });

  test("a failed repeated revoke preserves the original restore record", async () => {
    adb.setCommandResponseSequence(`shell dumpsys package ${Q}`, [
      createExecResult(grantedNotifications, ""),
      createExecResult(revokedNotifications, ""),
      createExecResult(grantedNotifications, ""),
      createExecResult(grantedNotifications, ""),
    ]);
    await applyKillProfile(emulator, APP, "notifications-off", deps());
    await expect(applyKillProfile(emulator, APP, "notifications-off", deps())).rejects.toThrow(
      "POST_NOTIFICATIONS still granted after pm revoke",
    );
    expect(registry.pendingFor(emulator.deviceId, APP)).toEqual([
      {
        key: `notificationPermission:${APP}`,
        appId: APP,
        command: `shell pm grant ${Q} android.permission.POST_NOTIFICATIONS`,
      },
    ]);
  });

  test("notifications-off refuses an unreadable original grant before writing", async () => {
    adb.setCommandResponse(`shell dumpsys package ${Q}`, createExecResult("", ""));
    await expect(applyKillProfile(emulator, APP, "notifications-off", deps())).rejects.toThrow(
      "Could not read POST_NOTIFICATIONS",
    );
    expect(writes()).toEqual([]);
    expect(registry.pendingFor(emulator.deviceId, APP)).toEqual([]);
  });

  test.each(["false", "true"])(
    "Samsung auto-disable restores captured hibernation %s",
    async (original) => {
      adb.setCommandResponse(
        `shell cmd app_hibernation get-state --user 0 ${Q}`,
        createExecResult(`${original}\n`, ""),
      );
      const result = await applyKillProfile(emulator, APP, "samsung-auto-disable", deps());
      expect(result).toMatchObject({
        status: "applied",
        steps: [{ step: "app hibernation", status: "applied" }],
      });
      expect(writes()).toEqual([`shell cmd app_hibernation set-state --user 0 ${Q} true`]);
      const commands = adb.getExecutedCommands();
      const captureIndex = commands.indexOf(`shell cmd app_hibernation get-state --user 0 ${Q}`);
      expect(captureIndex).toBeGreaterThanOrEqual(0);
      expect(captureIndex).toBeLessThan(
        commands.indexOf(`shell cmd app_hibernation set-state --user 0 ${Q} true`),
      );
      expect(result.restore?.commands).toEqual([
        `shell cmd app_hibernation set-state --user 0 ${Q} ${original}`,
      ]);
      expect(registry.has(emulator.deviceId, `hibernation:${APP}`)).toBe(true);

      adb.clearHistory();
      const reset = await resetKillProfile(emulator, APP, {}, deps());
      expect(reset).toMatchObject({ source: "recorded", status: "applied" });
      expect(writes()).toEqual([`shell cmd app_hibernation set-state --user 0 ${Q} ${original}`]);
      expect(registry.pendingFor(emulator.deviceId, APP)).toEqual([]);
    },
  );

  test.each([
    ["notifications-off", 32, 33],
    ["samsung-auto-disable", 30, 31],
  ] as const)("%s is unsupported on API %s", async (profile, api, minimum) => {
    adb.setAndroidApiLevel(api);
    const result = await applyKillProfile(emulator, APP, profile, deps());
    expect(result.status).toBe("unsupported");
    expect(result.steps[0].reason).toBe(`needs API ${minimum}+, device is API ${api}`);
    expect(result.restore).toBeUndefined();
    expect(writes()).toEqual([]);
    expect(
      adb
        .getExecutedCommands()
        .some((command) => /dumpsys package|appops get|app_hibernation get-state/.test(command)),
    ).toBe(false);
    expect(registry.pendingFor(emulator.deviceId, APP)).toEqual([]);
  });

  const cases: [string, "true" | "false"][] = [
    ["true", "true"],
    ["false", "false"],
    ["true\n", "true"],
    ["garbage", "false"],
    ["", "false"],
  ];
  test.each(cases)("parseHibernationState parses %j as %s", (stdout, expected) => {
    expect(parseHibernationState(stdout)).toBe(expected);
  });

  test("baseline reset includes notification and hibernation defaults on supported APIs", async () => {
    const result = await resetKillProfile(emulator, APP, { baseline: true }, deps());
    expect(result).toMatchObject({ source: "baseline", status: "applied" });
    expect(writes()).toContain(`shell appops set ${Q} POST_NOTIFICATION default`);
    expect(writes()).toContain(`shell cmd app_hibernation set-state --user 0 ${Q} false`);
  });

  test("Samsung deep sleeping denies wake locks after capturing the mode and resets it", async () => {
    adb.setCommandResponseSequence(`shell appops get ${Q} WAKE_LOCK`, [
      createExecResult("WAKE_LOCK: allow\n", ""),
    ]);
    const result = await applyKillProfile(emulator, APP, "samsung-deep-sleeping", deps());
    expect(result.status).toBe("applied");
    expect(result.profile.version).toBe(2);
    expect(writes()).toEqual([
      `shell am force-stop ${Q}`,
      `shell appops set ${Q} RUN_ANY_IN_BACKGROUND ignore`,
      `shell appops set ${Q} WAKE_LOCK ignore`,
    ]);
    const commands = adb.getExecutedCommands();
    const captureIndex = commands.indexOf(`shell appops get ${Q} WAKE_LOCK`);
    expect(captureIndex).toBeGreaterThanOrEqual(0);
    expect(captureIndex).toBeLessThan(commands.indexOf(`shell appops set ${Q} WAKE_LOCK ignore`));
    expect(result.restore?.commands).toEqual([
      `shell appops set ${Q} RUN_ANY_IN_BACKGROUND default`,
      `shell appops set ${Q} WAKE_LOCK allow`,
    ]);
    expect(registry.has(emulator.deviceId, `appOp:WAKE_LOCK:${APP}`)).toBe(true);

    adb.clearHistory();
    const reset = await resetKillProfile(emulator, APP, {}, deps());
    expect(reset).toMatchObject({ source: "recorded", status: "applied" });
    expect(writes()).toEqual([
      `shell appops set ${Q} RUN_ANY_IN_BACKGROUND default`,
      `shell appops set ${Q} WAKE_LOCK allow`,
    ]);
    expect(registry.pendingFor(emulator.deviceId, APP)).toEqual([]);
  });

  test("an unknown WAKE_LOCK operation is unsupported and its restore record is dropped", async () => {
    adb.setCommandResponse(
      `shell appops set ${Q} WAKE_LOCK`,
      createExecResult("Unknown operation string\n", ""),
    );
    const result = await applyKillProfile(emulator, APP, "samsung-deep-sleeping", deps());
    expect(result.status).toBe("partial");
    expect(result.steps.map((step) => step.status)).toEqual(["applied", "applied", "unsupported"]);
    expect(result.steps[2]).toMatchObject({
      step: "appops WAKE_LOCK ignore",
      reason: "Unknown operation string",
    });
    expect(writes()).toContain(`shell appops set ${Q} WAKE_LOCK ignore`);
    expect(result.restore?.commands).toEqual([
      `shell appops set ${Q} RUN_ANY_IN_BACKGROUND default`,
    ]);
    expect(registry.has(emulator.deviceId, `appOp:WAKE_LOCK:${APP}`)).toBe(false);
    expect(registry.pendingFor(emulator.deviceId, APP).map((action) => action.key)).toEqual([
      `appOp:RUN_ANY_IN_BACKGROUND:${APP}`,
    ]);
  });

  test("Samsung deep sleeping below API 28 force-stops but gates both app ops", async () => {
    adb.setAndroidApiLevel(27);
    const result = await applyKillProfile(emulator, APP, "samsung-deep-sleeping", deps());
    expect(result.status).toBe("partial");
    expect(result.steps.map((step) => step.status)).toEqual([
      "applied",
      "unsupported",
      "unsupported",
    ]);
    expect(result.steps[2]).toMatchObject({
      step: "appops WAKE_LOCK ignore",
      reason: "needs API 28+, device is API 27",
    });
    expect(writes()).toEqual([`shell am force-stop ${Q}`]);
    expect(adb.getExecutedCommands()).not.toContain(`shell appops get ${Q} WAKE_LOCK`);
    expect(result.restore).toBeUndefined();
    expect(registry.pendingFor(emulator.deviceId, APP)).toEqual([]);
  });

  test("Xiaomi and OnePlus force-stop recipes retain their version and steps", () => {
    for (const id of ["xiaomi-autostart-off", "oneplus-deep-optimization"] as const) {
      expect(KILL_PROFILES[id].version).toBe(1);
      expect(KILL_PROFILES[id].steps).toEqual([
        { kind: "kill", mode: "hard" },
        { kind: "appOp", op: "RUN_ANY_IN_BACKGROUND", mode: "ignore" },
      ]);
    }
  });

  test("apply is idempotent and reset restores the state found before the first apply", async () => {
    await applyKillProfile(emulator, APP, "samsung-sleeping", deps());
    // The device now reports the applied state; a second apply must not record it as the original.
    adb.setCommandResponse(
      "shell dumpsys battery",
      createExecResult("Current Battery Service state:\n  (UPDATES STOPPED -- use 'reset')\n", ""),
    );
    adb.setCommandResponse("shell am get-standby-bucket", createExecResult("45\n", ""));
    const again = await applyKillProfile(emulator, APP, "samsung-sleeping", deps());
    expect(again.restore?.commands).toEqual([
      "shell dumpsys battery reset",
      `shell am set-standby-bucket ${Q} 10`,
    ]);

    adb.clearHistory();
    const reset = await resetKillProfile(emulator, APP, {}, deps());
    expect(reset).toMatchObject({ source: "recorded", status: "applied" });
    expect(writes()).toEqual([
      "shell dumpsys battery reset",
      `shell am set-standby-bucket ${Q} 10`,
    ]);

    adb.clearHistory();
    const second = await resetKillProfile(emulator, APP, {}, deps());
    expect(second).toMatchObject({ source: "none", steps: [] });
    expect(writes()).toEqual([]);
  });

  test("a battery already unplugged by hand is left unplugged by reset", async () => {
    adb.setCommandResponse(
      "shell dumpsys battery",
      createExecResult("Current Battery Service state:\n  (UPDATES STOPPED -- use 'reset')\n", ""),
    );
    const result = await applyKillProfile(emulator, APP, "samsung-sleeping", deps());
    expect(result.restore?.commands).toEqual([`shell am set-standby-bucket ${Q} 10`]);
  });

  test("the restricted bucket below API 30 is unsupported and the profile is partial", async () => {
    adb.setAndroidApiLevel(29);
    const result = await applyKillProfile(emulator, APP, "samsung-sleeping", deps());
    expect(result.status).toBe("partial");
    expect(result.steps.map((step) => step.status)).toEqual(["applied", "unsupported"]);
    expect(result.steps[1].reason).toContain("API 30+");
    expect(result.restore?.commands).toEqual(["shell dumpsys battery reset"]);
    expect(writes()).toEqual(["shell dumpsys battery unplug"]);
  });

  test("a profile no step of which this API level supports is unsupported and changes nothing", async () => {
    adb.setAndroidApiLevel(27);
    const result = await applyKillProfile(emulator, APP, "user-restricted", deps());
    expect(result.status).toBe("unsupported");
    expect(result.restore).toBeUndefined();
    expect(writes()).toEqual([]);
  });

  test("force-idle with Doze disabled is unsupported and its record is dropped", async () => {
    adb.setCommandResponse(
      "shell dumpsys deviceidle force-idle",
      createExecResult("Unable to go deep idle; not enabled\n", ""),
    );
    const result = await applyKillProfile(emulator, APP, "oneplus-sleep-standby", deps());
    expect(result.status).toBe("partial");
    expect(result.steps[1]).toMatchObject({ status: "unsupported" });
    expect(result.restore?.commands).toEqual(["shell dumpsys battery reset"]);
  });

  test("a profile whose every step fails throws and keeps no record", async () => {
    adb.setCommandResponse(
      "shell appops set",
      createExecResult("", "Exception: java.lang.SecurityException\n"),
    );
    await expect(applyKillProfile(emulator, APP, "user-restricted", deps())).rejects.toThrow(
      "changed nothing",
    );
    expect(registry.pendingFor(emulator.deviceId, APP)).toEqual([]);
  });

  test("recents-swipe-kill backgrounds then kills, with nothing to restore", async () => {
    const result = await applyKillProfile(emulator, APP, "recents-swipe-kill", deps());
    expect(writes()).toEqual(["shell input keyevent KEYCODE_HOME", `shell am kill ${Q}`]);
    expect(result.restore).toBeUndefined();
  });

  test("exact-alarm-denied sets the uid mode and restores the uid mode read first", async () => {
    // Sequences take precedence over the catch-all `shell appops get` response.
    adb.setCommandResponseSequence("shell appops get --uid", [
      createExecResult("Uid mode: SCHEDULE_EXACT_ALARM: allow\n", ""),
    ]);
    const result = await applyKillProfile(emulator, APP, "exact-alarm-denied", deps());
    expect(writes()).toEqual([`shell appops set --uid ${Q} SCHEDULE_EXACT_ALARM deny`]);
    expect(result.restore?.commands).toEqual([
      `shell appops set --uid ${Q} SCHEDULE_EXACT_ALARM allow`,
    ]);
  });

  test("an app that is not installed is refused before anything changes", async () => {
    adb.setCommandResponse("shell pm path", createExecResult("", ""));
    await expect(applyKillProfile(emulator, APP, "user-restricted", deps())).rejects.toThrow(
      "not installed",
    );
    expect(writes()).toEqual([]);
  });

  test("iOS is refused", async () => {
    const ios: BootedDevice = { name: "sim", platform: "ios", deviceId: "SIM-1" };
    await expect(applyKillProfile(ios, APP, "user-restricted", deps())).rejects.toThrow(
      "Android-only",
    );
  });

  test("reset with nothing recorded writes the AOSP defaults only with baseline: true", async () => {
    adb.setAndroidApiLevel(30);
    const result = await resetKillProfile(emulator, APP, { baseline: true }, deps());
    expect(result.source).toBe("baseline");
    expect(result.status).toBe("partial");
    expect(writes()).toEqual([
      "shell dumpsys battery reset",
      "shell dumpsys deviceidle unforce",
      `shell am set-standby-bucket ${Q} active`,
      `shell appops set ${Q} RUN_ANY_IN_BACKGROUND default`,
      `shell appops set ${Q} WAKE_LOCK default`,
    ]);
    expect(result.steps.at(-1)).toMatchObject({ status: "unsupported" });
  });

  test("a baseline reset after a daemon restart restores WAKE_LOCK from Samsung deep sleeping", async () => {
    await applyKillProfile(emulator, APP, "samsung-deep-sleeping", deps());
    expect(writes()).toContain(`shell appops set ${Q} WAKE_LOCK ignore`);

    // A restarted daemon starts with an empty restore registry.
    registry = new KillProfileRestoreRegistry();
    adb.clearHistory();
    const reset = await resetKillProfile(emulator, APP, { baseline: true }, deps());
    expect(reset.source).toBe("baseline");
    expect(writes()).toContain(`shell appops set ${Q} WAKE_LOCK default`);
    expect(reset.steps).toContainEqual(
      expect.objectContaining({ step: "appops WAKE_LOCK default", status: "applied" }),
    );
  });

  test("a baseline reset below API 28 gates the WAKE_LOCK default", async () => {
    adb.setAndroidApiLevel(27);
    const reset = await resetKillProfile(emulator, APP, { baseline: true }, deps());
    expect(writes()).not.toContain(`shell appops set ${Q} WAKE_LOCK default`);
    expect(reset.steps).toContainEqual(
      expect.objectContaining({
        step: "appops WAKE_LOCK default",
        status: "unsupported",
        reason: "needs API 28+, device is API 27",
      }),
    );
  });

  test("a restore the device refuses stays recorded for a later reset or release", async () => {
    await applyKillProfile(emulator, APP, "user-restricted", deps());
    adb.setCommandResponse(
      "shell appops set",
      createExecResult("", "Exception: java.lang.SecurityException\n"),
    );
    await expect(resetKillProfile(emulator, APP, {}, deps())).rejects.toThrow("failed");
    expect(registry.pendingFor(emulator.deviceId, APP)).toHaveLength(1);
  });

  test("a session owner makes the receipt restore on release", async () => {
    const result = await applyKillProfile(emulator, APP, "motorola-adaptive", deps("session-1"));
    expect(result.restore).toEqual({
      commands: [`shell am set-standby-bucket ${Q} 10`],
      onSessionRelease: true,
    });
  });

  test("appops and standby-bucket output parse into restorable values", () => {
    expect(parseAppOpMode("WAKE_LOCK: ignore; time=+1m ago", "WAKE_LOCK")).toBe("ignore");
    expect(parseAppOpMode("No operations.\n", "RUN_ANY_IN_BACKGROUND")).toBe("default");
    expect(
      parseAppOpMode(
        "Uid mode: RUN_ANY_IN_BACKGROUND: allow\nRUN_ANY_IN_BACKGROUND: ignore; time=+1m2s ago\n",
        "RUN_ANY_IN_BACKGROUND",
      ),
    ).toBe("ignore");
    expect(parseAppOpMode("Uid mode: SCHEDULE_EXACT_ALARM: deny\n", "SCHEDULE_EXACT_ALARM")).toBe(
      "deny",
    );
    expect(parseStandbyBucket("40\n")).toBe("40");
    expect(parseStandbyBucket("Unknown package\n")).toBeUndefined();
  });
});
