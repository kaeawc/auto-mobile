import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, test } from "bun:test";
import { applyKillProfile, resetKillProfile } from "../../../src/features/utility/ApplyKillProfile";
import { parseBootObservation } from "../../../src/features/utility/KillProfileObservationPlans";
import { runtimePermissionsPlan } from "../../../src/features/utility/KillProfileStatePlans";
import {
  KillProfileRestoreRegistry,
  restoreKillProfileFacets,
} from "../../../src/features/utility/KillProfileRestore";
import type { Context } from "../../../src/features/utility/KillProfileStepPlan";
import { parseAndroidRuntimePermissions } from "../../../src/features/action/parseAndroidRuntimePermissions";
import { parseCommandArgs } from "../../../src/utils/android-cmdline-tools/AdbCommandArguments";
import { createExecResult } from "../../../src/utils/execResult";
import type { BootedDevice } from "../../../src/models";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../fakes/FakeTimer";

const device: BootedDevice = { deviceId: "emulator-5554", name: "test", platform: "android" };
const CALENDAR = "com.google.android.calendar";
const CLOCK = "com.google.android.deskclock";
const fixture = (name: string) =>
  readFileSync(
    new URL(`../../fixtures/killProfile/api35/api35-${name}.txt`, import.meta.url),
    "utf8",
  );
const granted = fixture("calendar-package-runtime-granted");
const revoked = fixture("calendar-package-runtime-revoked");
const running = fixture("deskclock-package-running");
const stopped = fixture("deskclock-package-stopped");
const pending = fixture("alarm-deskclock-pending");
const cleared = fixture("alarm-deskclock-after-force-stop");
const response = (text: string) => createExecResult(text, "");

// These older captures contain only the runtime section, so provide their package/user context.
const notificationDump = (state: "granted" | "revoked") =>
  `Packages:\n  Package [${CLOCK}] (test):\n    User 0: installed=true\n${readFileSync(new URL(`../../fixtures/android-notification-enabled/api35-deskclock-${state}-dumpsys-package.txt`, import.meta.url), "utf8")}`;

describe("OEM kill profile steps", () => {
  let shell: FakeAdbExecutor;
  let timer: FakeTimer;
  let registry: KillProfileRestoreRegistry;
  beforeEach(() => {
    shell = new FakeAdbExecutor();
    shell.setAndroidApiLevel(35);
    shell.setCommandResponse("shell pm path", response("package:/data/app/base.apk"));
    shell.setCommandResponseSequence("app_hibernation get-state", [
      response("false"),
      response("true"),
    ]);
    shell.setCommandResponse("shell dumpsys package", response(running));
    shell.setCommandResponse("shell dumpsys alarm", response(pending));
    shell.setCommandResponseSequence("shell appops get", [
      response("No operations."),
      response("RUN_ANY_IN_BACKGROUND: ignore"),
    ]);
    shell.setCommandResponseSequence("shell am get-standby-bucket", [
      response("10"),
      response("45"),
    ]);
    timer = new FakeTimer();
    timer.enableAutoAdvance();
    registry = new KillProfileRestoreRegistry();
  });
  const deps = () => ({ shell, timer, registry, owner: "session" });

  test("real runtime dumps enumerate four grants before revoke and only notifications afterwards", () => {
    const before = parseAndroidRuntimePermissions(granted, CALENDAR);
    const after = parseAndroidRuntimePermissions(revoked, CALENDAR);
    expect(
      [...before!.runtimePermissions.values()]
        .filter((p) => p.state === "granted")
        .map((p) => p.permission)
        .sort(),
    ).toEqual([
      "android.permission.POST_NOTIFICATIONS",
      "android.permission.READ_CALENDAR",
      "android.permission.READ_CONTACTS",
      "android.permission.WRITE_CALENDAR",
    ]);
    expect(
      [...after!.runtimePermissions.values()]
        .filter((p) => p.state === "granted")
        .map((p) => p.permission),
    ).toEqual(["android.permission.POST_NOTIFICATIONS"]);
  });

  test("revoke targets every captured grant, reports remaining names and retains exact restore set", async () => {
    shell.setCommandResponseSequence("shell dumpsys package", [
      response(granted),
      response(revoked),
    ]);
    const result = await applyKillProfile(device, CALENDAR, "samsung-auto-disable", deps());
    expect(result.status).toBe("partial");
    expect(result.steps[0]).toMatchObject({
      status: "failed",
      reason: "Runtime permissions still granted: android.permission.POST_NOTIFICATIONS",
    });
    const permissions = [
      ...parseAndroidRuntimePermissions(granted, CALENDAR)!.runtimePermissions.values(),
    ]
      .filter((p) => p.state === "granted")
      .map((p) => p.permission);
    const command = (verb: string) =>
      `shell ${permissions.map((p) => `pm ${verb} '${CALENDAR}' '${p}'`).join(" && ")}`;
    expect(result.steps[0].command).toBe(command("revoke"));
    const action = registry.pendingFor(device.deviceId, CALENDAR)[0];
    expect(action).toEqual({
      key: `runtimePermissions:${CALENDAR}`,
      appId: CALENDAR,
      command: command("grant"),
    });
    expect(parseCommandArgs(action.command!)).toEqual(["shell", command("grant").slice(6)]);
    await resetKillProfile(device, CALENDAR, {}, deps());
    expect(shell.getExecutedCommands()).toContain(command("grant"));
    expect(registry.pendingFor(device.deviceId, CALENDAR)).toEqual([]);
  });

  test("successful runtime revoke restores on session release and repeated apply keeps the first grant", async () => {
    shell.setCommandResponseSequence("shell dumpsys package", [
      response(notificationDump("granted")),
      response(notificationDump("revoked")),
    ]);
    const result = await applyKillProfile(device, CLOCK, "samsung-auto-disable", deps());
    expect(result.steps[0].status).toBe("applied");
    await applyKillProfile(device, CLOCK, "samsung-auto-disable", deps());
    const owned = registry.takeOwnedBy(device.deviceId, "session")!;
    expect(owned.actions[0].command).toBe(
      `shell pm grant '${CLOCK}' 'android.permission.POST_NOTIFICATIONS'`,
    );
    expect(await restoreKillProfileFacets(owned, () => shell, timer)).toEqual([]);
    expect(shell.getExecutedCommands()).toContain(owned.actions[0].command!);
  });

  test("zero granted permissions is applied without a write or restore command", async () => {
    shell.setCommandResponse("shell dumpsys package", response(notificationDump("revoked")));
    const result = await applyKillProfile(device, CLOCK, "samsung-auto-disable", deps());
    expect(result.steps[0]).toMatchObject({ status: "applied", command: "" });
    expect(shell.getExecutedCommands().some((c) => c.includes("pm revoke"))).toBe(false);
    expect(registry.pendingFor(device.deviceId, CLOCK)[0].command).toBeNull();
  });

  test("API 22 gates runtime revocation without reading or changing permissions", async () => {
    shell.setAndroidApiLevel(22);
    const result = await applyKillProfile(device, CLOCK, "samsung-auto-disable", deps());
    expect(result.steps.map((step) => step.status)).toEqual(["unsupported", "unsupported"]);
    expect(result.steps[0].reason).toContain("API 23+");
    expect(
      shell
        .getExecutedCommands()
        .some((c) => c.includes("dumpsys package") || c.includes("pm revoke")),
    ).toBe(false);
  });

  test("failed permission dump reports failed without a permission restore", async () => {
    shell.setCommandError("shell dumpsys package", new Error("dump unavailable"));
    const result = await applyKillProfile(device, CLOCK, "samsung-auto-disable", deps());
    expect(result.steps[0]).toMatchObject({ status: "failed", reason: "dump unavailable" });
    expect(registry.has(device.deviceId, `runtimePermissions:${CLOCK}`)).toBe(false);
  });

  test("partially refused permission write retains its original set", async () => {
    shell.setCommandResponseSequence("shell dumpsys package", [
      response(granted),
      response(revoked),
    ]);
    shell.setCommandResponse("shell pm revoke", response("SecurityException: fixed permission"));
    const result = await applyKillProfile(device, CALENDAR, "samsung-auto-disable", deps());
    expect(result.steps[0].status).toBe("failed");
    expect(registry.has(device.deviceId, `runtimePermissions:${CALENDAR}`)).toBe(true);
  });

  test("runtime capture rejects an unreadable dump", async () => {
    shell.setCommandResponse("shell dumpsys package", response("unreadable"));
    const context: Context = { device, appId: CLOCK, quoted: `'${CLOCK}'`, deps: deps() };
    await expect(runtimePermissionsPlan(context).capture!()).rejects.toThrow(
      "Could not read runtime permissions",
    );
  });

  test.each([
    ["deskclock", "failed"],
    ["settings", "applied"],
  ] as const)("foreground %s reads back as %s before hard kill", async (top, status) => {
    shell.setCommandResponse(
      "shell dumpsys activity activities",
      response(fixture(`top-resumed-${top}`)),
    );
    const result = await applyKillProfile(device, CLOCK, "samsung-foreground-kill", deps());
    expect(result.steps[0].status).toBe(status);
    if (status === "failed") {
      expect(result.steps[0].reason).toBe("app is still the top resumed activity");
    }
    expect(result.restore).toBeUndefined();
    const commands = shell.getExecutedCommands();
    expect(commands.indexOf("shell am start -a android.settings.SETTINGS")).toBeLessThan(
      commands.indexOf("shell dumpsys activity activities"),
    );
    expect(commands.at(-1)).toBe(`shell am force-stop '${CLOCK}'`);
  });

  test("missing top-resumed value fails instead of accepting a successful launch", async () => {
    shell.setCommandResponse("shell dumpsys activity activities", response(""));
    const result = await applyKillProfile(device, CLOCK, "samsung-foreground-kill", deps());
    expect(result.steps[0]).toMatchObject({
      status: "failed",
      reason: "top resumed activity reads back as unreadable",
    });
  });

  test.each(["awake", "asleep"] as const)(
    "screen initially %s waits six fake chunks and restores only if awake",
    async (initial) => {
      shell.setCommandResponseSequence("shell dumpsys power", [
        response(fixture(`power-wakefulness-${initial}`)),
        response(fixture("power-wakefulness-asleep")),
      ]);
      const result = await applyKillProfile(device, CLOCK, "screen-off-stop", deps());
      expect(result.status).toBe("applied");
      expect(timer.getSleepHistory()).toEqual(Array(6).fill(10_000));
      expect(registry.pendingFor(device.deviceId, CLOCK)).toEqual([
        {
          key: "screen",
          command: initial === "awake" ? "shell input keyevent KEYCODE_WAKEUP" : null,
        },
      ]);
      const reset = await resetKillProfile(device, CALENDAR, {}, deps());
      expect(reset.source).toBe("recorded");
      expect(shell.getExecutedCommands().includes("shell input keyevent KEYCODE_WAKEUP")).toBe(
        initial === "awake",
      );
    },
  );

  test("screen verification polls through Dozing before starting the screen-off wait", async () => {
    shell.setCommandResponseSequence("shell dumpsys power", [
      response(fixture("power-wakefulness-awake")),
      // No Dozing capture is available; only this transient wakefulness line is synthetic.
      response("  mWakefulness=Dozing\n"),
      response("  mWakefulness=Dozing\n"),
      response(fixture("power-wakefulness-asleep")),
    ]);
    const result = await applyKillProfile(device, CLOCK, "screen-off-stop", deps());
    expect(result.status).toBe("applied");
    expect(result.steps[0].status).toBe("applied");
    expect(timer.getSleepHistory()).toEqual([500, 500, ...Array(6).fill(10_000)]);
    expect(shell.getExecutedCommands().filter((c) => c === "shell dumpsys power")).toHaveLength(4); // One capture, then three verification attempts.
    expect(shell.getExecutedCommands().at(-1)).toBe(`shell am force-stop '${CLOCK}'`);
  });

  test.each([CLOCK, CALENDAR])(
    "screen verification stops after ten attempts and reset for %s wakes the recorded screen",
    async (resetAppId) => {
      shell.setCommandResponseSequence("shell dumpsys power", [
        response(fixture("power-wakefulness-awake")),
        ...Array.from({ length: 9 }, () => response("  mWakefulness=Dozing\n")),
        response(fixture("power-wakefulness-awake")),
      ]);
      const result = await applyKillProfile(device, CLOCK, "screen-off-stop", deps());
      expect(result.steps[0]).toMatchObject({
        status: "failed",
        reason: "wakefulness reads back as Awake, expected Asleep",
      });
      expect(timer.getSleepHistory()).toEqual(Array(9).fill(500));
      expect(shell.getExecutedCommands().filter((c) => c === "shell dumpsys power")).toHaveLength(
        11,
      ); // One capture, then exactly ten verification attempts.
      expect(registry.pendingFor(device.deviceId, resetAppId)).toEqual([
        { key: "screen", command: "shell input keyevent KEYCODE_WAKEUP" },
      ]);
      expect(result.restore?.commands).toEqual(["shell input keyevent KEYCODE_WAKEUP"]);
      // A fresh process/registry loses the record; an appId parameter does not filter it out.
      const withoutRecord = await resetKillProfile(
        device,
        resetAppId,
        {},
        {
          ...deps(),
          registry: new KillProfileRestoreRegistry(),
        },
      );
      expect(withoutRecord.source).toBe("none");
      expect(withoutRecord.message).toContain("No killProfile change is recorded");
      expect(shell.getExecutedCommands()).not.toContain("shell input keyevent KEYCODE_WAKEUP");
      const reset = await resetKillProfile(device, resetAppId, {}, deps());
      expect(reset.source).toBe("recorded");
      expect(reset.steps).toEqual([
        {
          step: "restore screen",
          command: "shell input keyevent KEYCODE_WAKEUP",
          status: "applied",
        },
      ]);
      expect(shell.getExecutedCommands().at(-1)).toBe("shell input keyevent KEYCODE_WAKEUP");
      expect(registry.pendingFor(device.deviceId, resetAppId)).toEqual([]);
    },
  );

  test("abort between screen verification attempts stops polling and retains screen restore", async () => {
    const controller = new AbortController();
    shell.setCommandResponseSequence("shell dumpsys power", [
      response(fixture("power-wakefulness-awake")),
      response("  mWakefulness=Dozing\n"),
    ]);
    const abortingTimer = {
      sleep: async (ms: number) => {
        await timer.sleep(ms);
        controller.abort();
      },
    };
    await expect(
      applyKillProfile(device, CLOCK, "screen-off-stop", {
        ...deps(),
        timer: abortingTimer,
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    expect(timer.getSleepHistory()).toEqual([500]);
    expect(shell.getExecutedCommands().filter((c) => c === "shell dumpsys power")).toHaveLength(2);
    expect(shell.getExecutedCommands().some((c) => c.includes("force-stop"))).toBe(false);
    expect(registry.has(device.deviceId, "screen")).toBe(true);
  });

  test("abort between screen-off chunks prevents hard kill and retains screen restore", async () => {
    const controller = new AbortController();
    shell.setCommandResponseSequence("shell dumpsys power", [
      response(fixture("power-wakefulness-awake")),
      response(fixture("power-wakefulness-asleep")),
    ]);
    const abortingTimer = {
      sleep: async (ms: number) => {
        await timer.sleep(ms);
        controller.abort();
      },
    };
    await expect(
      applyKillProfile(device, CLOCK, "screen-off-stop", {
        ...deps(),
        timer: abortingTimer,
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    expect(timer.getSleepHistory()).toEqual([10_000]);
    expect(shell.getExecutedCommands().some((c) => c.includes("force-stop"))).toBe(false);
    expect(registry.has(device.deviceId, "screen")).toBe(true);
  });

  test.each([
    [running, pending, false, 2],
    [stopped, cleared, true, 0],
  ] as const)("real boot observations count pending rows only", (pkg, alarms, isStopped, count) => {
    expect(parseBootObservation(pkg, alarms, CLOCK)).toEqual({
      bootReceivers: [`${CLOCK}/com.android.deskclock.AlarmInitReceiver`],
      bootPermissionGranted: true,
      stopped: isStopped,
      bootBroadcastDelivered: !isStopped,
      pendingAlarms: count,
    });
    expect(() => parseBootObservation(pkg, alarms, CALENDAR)).toThrow("Could not read");
  });

  test("boot check observes without a broadcast or extra restore record", async () => {
    const result = await applyKillProfile(device, CLOCK, "vivo-autostart", deps());
    expect(result.steps.at(-1)).toMatchObject({
      status: "applied",
      observation: { bootBroadcastDelivered: true, pendingAlarms: 2 },
    });
    expect(result.steps.at(-1)?.reason).toContain("default boot delivery=true");
    expect(registry.pendingFor(device.deviceId, CLOCK)).toHaveLength(2);
    expect(shell.getExecutedCommands().some((c) => c.includes("am broadcast"))).toBe(false);
  });

  test.each(["shell dumpsys package", "shell dumpsys alarm"])(
    "boot check fails when %s fails",
    async (command) => {
      shell.setCommandError(command, new Error("read denied"));
      const result = await applyKillProfile(device, CLOCK, "vivo-autostart", deps());
      expect(result.steps.at(-1)).toMatchObject({ status: "failed", reason: "read denied" });
    },
  );

  test("unreadable alarm output is a failed check", async () => {
    shell.setCommandResponse("shell dumpsys alarm", response(""));
    const result = await applyKillProfile(device, CLOCK, "vivo-autostart", deps());
    expect(result.steps.at(-1)?.status).toBe("failed");
  });
});
