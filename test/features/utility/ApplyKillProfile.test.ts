import { beforeEach, describe, expect, test } from "bun:test";
import {
  applyKillProfile,
  parseAppOpMode,
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
        (command) => !/pm path|appops get|get-standby-bucket|^shell dumpsys battery$/.test(command),
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
    ]);
    expect(result.steps.at(-1)).toMatchObject({ status: "unsupported" });
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
