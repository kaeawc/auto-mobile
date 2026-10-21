import { describe, expect, test } from "bun:test";
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

async function rig(users: readonly number[] = [0], fallback?: AndroidResetStrategy) {
  const { adb, reply } = androidBaselineRig(users);
  const timer = new FakeTimer();
  const journal = new FakeDeviceMutationJournal(timer);
  const port = new AndroidDeviceMutationResetPort(adb);
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
    expect(
      commands.some(
        (command) => command.includes("sha256sum") || command.includes("dumpsys account"),
      ),
    ).toBe(false);
    expect(
      adb
        .getCommandCalls()
        .every(
          (call) =>
            call.timeoutMs === 2000 &&
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
    await reset();
    const commands = adb.getExecutedCommands();
    for (const user of [0, 10, 11]) {
      expect(commands).toContain(`shell pm uninstall --user ${user} 'com.example.new'`);
    }
    expect(commands).toContain("shell pm uninstall --user 11 'com.example.probe'");
    expect(commands).not.toContain("shell pm uninstall --user 0 'com.example.probe'");
    expect(commands).not.toContain("shell pm uninstall --user 10 'com.example.probe'");
  });

  test("preserves baseline runtime grants and fixture data while revoking added grants", async () => {
    const { adb, reply, reset, journal } = await rig([0, 10]);
    const dump = androidPackageDump("com.example.probe", [0, 10]).replaceAll(
      "android.permission.CAMERA: granted=true, flags=[ USER_SET ]",
      "android.permission.CAMERA: granted=true, flags=[ USER_SET ]\n        android.permission.RECORD_AUDIO: granted=true, flags=[]",
    );
    reply("shell dumpsys package 'com.example.probe'", dump);
    await journal.record(SCOPE, {
      kind: "preference",
      key: "app-data:0:com.example.probe",
      priorValue: { state: "absent" },
      toolName: "test",
    });
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
    const { adb, reply, reset } = await rig([0, 10]);
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

  test.each([false, true])(
    "setting put failure is hard only for a critical key (%s)",
    async (critical) => {
      const { adb, reply, reset } = await rig();
      const key = critical ? "adb_enabled" : "optional_key";
      reply("shell settings --user 0 list global", `${key}=0`);
      const failedCommand = `shell settings --user 0 delete global ${key}`;
      adb.setCommandResponse(failedCommand, createExecResult("Error: refused", ""));
      if (critical) {
        await expect(reset()).rejects.toThrow("non-clean");
      } else {
        expect(await reset()).toMatchObject({ outcome: "clean", mode: "keep-booted" });
        expect(adb.getExecutedCommands()).toContain("shell cmd clipboard clear");
      }
    },
  );

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

  test("unsupported clipboard and unplannable journals do not force fallback", async () => {
    const { adb, journal, reset } = await rig();
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
    expect(await reset()).toMatchObject({ outcome: "clean", mode: "keep-booted" });
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
