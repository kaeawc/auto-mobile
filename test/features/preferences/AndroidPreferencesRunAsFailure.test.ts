import { describe, expect, test } from "bun:test";
import type { BootedDevice } from "../../../src/models";
import type { AdbClientFactory } from "../../../src/utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";
import { wrapCommandError } from "../../../src/utils/CommandError";
import { createExecResult } from "../../../src/utils/execResult";
import { AppPreferences } from "../../../src/features/preferences/AppPreferences";
import {
  androidRunAsOutput,
  readAndroidPreferencesXml,
} from "../../../src/features/preferences/AndroidPreferencesXmlFile";
import {
  clearAndroidKeyValueFileDirect,
  removeAndroidKeyValueDirect,
  setAndroidKeyValueDirect,
} from "../../../src/features/storage/AndroidSharedPreferencesKeyValueFile";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";

// Issue #10085: a read that failed because the explicit user does not exist was classified
// as "prefs file missing" because the error message echoes the command line, which contains
// `shared_prefs/<name>.xml`.

const androidDevice: BootedDevice = {
  name: "Pixel",
  platform: "android",
  deviceId: "emulator-5600",
};

const APP_ID = "dev.jasonpearson.automobile.playground";
const ADB_PATH = "/Users/jason/Library/Android/sdk/platform-tools/adb";

/**
 * Captured on emulator-5600 (API 36, only user 0) with `--user 10`: the stderr that the real
 * `setPreference` run recorded in scratch/mt38/b1.out (#7) and
 * scratch/mt38/out/b1-7-setPreference.json of the manual-test worktree.
 */
const REAL_MISSING_USER_STDERR = "run-as: couldn't stat /data/user/10: No such file or directory";

const WRITE_COMMAND_LINE = `${ADB_PATH} -s emulator-5600 shell run-as ${APP_ID} --user 10 sh -c 'mkdir -p shared_prefs && printf '\\''%s'\\'' '\\''PD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0idXRmLTgiIHN0YW5kYWxvbmU9InllcyI/PjxtYXA+PHN0cmluZyBuYW1lPSJrMyI+djM8L3N0cmluZz48L21hcD4='\\'' | base64 -d > shared_prefs/mt38prefs.xml'`;

/** The exact message the adb client produced for that run (same text as b1.out #7). */
const REAL_WRITE_FAILURE_MESSAGE = [
  `Command failed: ${WRITE_COMMAND_LINE}`,
  "exit code: 1",
  `raw error: (last 4000 chars) Command failed: ${WRITE_COMMAND_LINE}`,
  REAL_MISSING_USER_STDERR,
  "stderr: (last 4000 chars)",
  REAL_MISSING_USER_STDERR,
].join("\n");

/** A failed adb run formatted as AdbClient does (`wrapCommandError`), stderr attached. */
function failedRunAs(args: string, stderr: string): Error {
  const raw = Object.assign(new Error(`Command failed: ${ADB_PATH} ${args}`), {
    code: 1,
    stderr,
  });
  return wrapCommandError(raw, { command: ADB_PATH, args: args.split(" "), stderr });
}

const READ_USER_10 = `-s emulator-5600 shell run-as ${APP_ID} --user 10 cat shared_prefs/mt38prefs.xml`;

function factoryFor(adb: AdbExecutor): AdbClientFactory {
  return { create: () => adb };
}

function missingUserAdb(): FakeAdbExecutor {
  const adb = new FakeAdbExecutor();
  adb.setCommandError(
    `run-as ${APP_ID} --user 10`,
    failedRunAs(READ_USER_10, REAL_MISSING_USER_STDERR),
  );
  return adb;
}

describe("androidRunAsOutput", () => {
  test("returns the stderr attached to a wrapped error, not the echoed command line", () => {
    const output = androidRunAsOutput(failedRunAs(READ_USER_10, REAL_MISSING_USER_STDERR));

    expect(output).toBe(REAL_MISSING_USER_STDERR);
    expect(output).not.toContain("shared_prefs");
  });

  test("drops the command-line lines when only a formatted message is available", () => {
    const output = androidRunAsOutput(new Error(REAL_WRITE_FAILURE_MESSAGE));

    expect(output).not.toContain("shared_prefs/mt38prefs.xml");
    expect(output).toContain(REAL_MISSING_USER_STDERR);
  });
});

describe("getPreference with an explicit userId that does not exist (#10085)", () => {
  test("fails naming the user instead of reporting found:false", async () => {
    const preferences = new AppPreferences(androidDevice, {
      adbFactory: factoryFor(missingUserAdb()),
    });

    const result = preferences.getPreference({
      scope: "sharedPreferences",
      appId: APP_ID,
      suite: "mt38prefs",
      key: "k1",
      userId: 10,
    });

    await expect(result).rejects.toThrow(/user 10 does not exist/);
  });

  test("still reports found:false for a missing prefs file of an existing user", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandError(
      `run-as ${APP_ID} --user 10 cat`,
      failedRunAs(READ_USER_10, "cat: shared_prefs/mt38prefs.xml: No such file or directory"),
    );
    const preferences = new AppPreferences(androidDevice, { adbFactory: factoryFor(adb) });

    const result = await preferences.getPreference({
      scope: "sharedPreferences",
      appId: APP_ID,
      suite: "mt38prefs",
      key: "k1",
      userId: 10,
    });

    expect(result).toMatchObject({ success: true, found: false, value: null, userId: 10 });
  });

  test("other run-as diagnostics stay errors even though the command names the prefs file", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandError(
      `run-as ${APP_ID} cat`,
      failedRunAs(
        `-s emulator-5600 shell run-as ${APP_ID} cat shared_prefs/mt38prefs.xml`,
        `run-as: unknown package: ${APP_ID}`,
      ),
    );

    await expect(readAndroidPreferencesXml(adb, APP_ID, "mt38prefs")).rejects.toThrow(
      /Failed to read Android SharedPreferences via run-as/,
    );
  });
});

describe("key-value direct edits share the missing-user classification (#10085)", () => {
  test("setKeyValue names the missing user", async () => {
    const result = setAndroidKeyValueDirect(
      missingUserAdb(),
      "emulator-5600",
      APP_ID,
      "mt38prefs",
      "k3",
      "v3",
      "STRING",
      10,
    );

    await expect(result).rejects.toThrow(/user 10 does not exist/);
  });

  test("removeKeyValue names the missing user instead of silently doing nothing", async () => {
    const result = removeAndroidKeyValueDirect(
      missingUserAdb(),
      "emulator-5600",
      APP_ID,
      "mt38prefs",
      "k1",
      10,
    );

    await expect(result).rejects.toThrow(/user 10 does not exist/);
  });

  test("clearKeyValueFile names the missing user instead of silently doing nothing", async () => {
    const result = clearAndroidKeyValueFileDirect(
      missingUserAdb(),
      "emulator-5600",
      APP_ID,
      "mt38prefs",
      10,
    );

    await expect(result).rejects.toThrow(/user 10 does not exist/);
  });

  test("a write failure for a missing user names the user", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandError(`run-as ${APP_ID} --user 10 sh -c`, new Error(REAL_WRITE_FAILURE_MESSAGE));
    adb.setCommandResponse(`run-as ${APP_ID} --user 10 cat`, createExecResult("<map/>", ""));

    const result = setAndroidKeyValueDirect(
      adb,
      "emulator-5600",
      APP_ID,
      "mt38prefs",
      "k3",
      "v3",
      "STRING",
      10,
    );

    await expect(result).rejects.toThrow(/user 10 does not exist/);
  });
});
