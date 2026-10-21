import { describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DeviceLockState, ExecResult } from "../../../../src/models";
import type { AdbExecuteOptions } from "../../../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";
import {
  AdbLockSettingsClient,
  LOCK_SETTINGS_LOG_LABEL,
  parseLockSettingsCredentialType,
  scrubLockCredentials,
} from "../../../../src/features/utility/screenLock/AndroidLockSettings";
import { createExecResult } from "../../../../src/utils/execResult";
import { logger } from "../../../../src/utils/logger";

const fixture = (name: string): string =>
  readFileSync(join(import.meta.dir, "../../../fixtures/android-lock-settings", name), "utf8");

const EXIT = (code: number) => `AUTOMOBILE_LOCKSETTINGS_EXIT=${code}\n`;

function execResult(stdout: string, stderr = ""): ExecResult {
  return createExecResult(stdout, stderr);
}

/** The two adb calls the client makes, answered per argv and recorded with their options. */
class FakeLockSettingsAdb {
  calls: Array<{ args: string[]; options?: AdbExecuteOptions }> = [];
  responses: Array<ExecResult | Error> = [];
  deviceLock: DeviceLockState | null = null;

  async execute(args: string[], options?: AdbExecuteOptions): Promise<ExecResult> {
    this.calls.push({ args, options });
    const next = this.responses.shift() ?? execResult("");
    if (next instanceof Error) {
      throw next;
    }
    return next;
  }

  async getDeviceLock(): Promise<DeviceLockState | null> {
    return this.deviceLock;
  }
}

describe("parseLockSettingsCredentialType", () => {
  test("reads user 0's credential type from an Android 14 dump", () => {
    expect(
      parseLockSettingsCredentialType(fixture("dumpsys-lock-settings-api34-none.txt")),
    ).toEqual({ type: "none", secure: false });
    expect(parseLockSettingsCredentialType(fixture("dumpsys-lock-settings-api34-pin.txt"))).toEqual(
      {
        type: "pin",
        secure: true,
      },
    );
  });

  test("ignores a work profile's own credential", () => {
    expect(
      parseLockSettingsCredentialType(fixture("dumpsys-lock-settings-api34-work-profile.txt")),
    ).toEqual({ type: "none", secure: false });
  });

  test("an Android 10 integer 2 is secure but of unknown type; a missing line is unknown", () => {
    expect(
      parseLockSettingsCredentialType(fixture("dumpsys-lock-settings-api29-legacy-int.txt")),
    ).toEqual({ type: "unknown", secure: true });
    expect(
      parseLockSettingsCredentialType(fixture("dumpsys-lock-settings-no-credential-type.txt")),
    ).toEqual({ type: "unknown" });
  });
});

describe("scrubLockCredentials", () => {
  test("replaces longer secrets first and every device-shell-quoted form", () => {
    expect(scrubLockCredentials("old 1234, new 12345", ["1234", "12345"])).toBe(
      "old <redacted>, new <redacted>",
    );
    expect(scrubLockCredentials("argv 'pass word' echoed pass word", ["pass word"])).toBe(
      "argv <redacted> echoed <redacted>",
    );
  });
});

describe("AdbLockSettingsClient", () => {
  test("reads the type with dumpsys lock_settings", async () => {
    const adb = new FakeLockSettingsAdb();
    adb.responses.push(execResult(fixture("dumpsys-lock-settings-api34-pin.txt")));
    expect(await new AdbLockSettingsClient(adb).read()).toEqual({ type: "pin", secure: true });
    expect(adb.calls[0].args).toEqual(["shell", "dumpsys", "lock_settings"]);
  });

  test("falls back to the keyguard's secure flag when the dump names no type", async () => {
    const adb = new FakeLockSettingsAdb();
    adb.responses.push(execResult(fixture("dumpsys-lock-settings-no-credential-type.txt")));
    adb.deviceLock = { locked: true, keyguardShowing: true, secure: false };
    expect(await new AdbLockSettingsClient(adb).read()).toEqual({ type: "none", secure: false });
  });

  test("sets a PIN with --old, under a log label, without retries", async () => {
    const adb = new FakeLockSettingsAdb();
    adb.responses.push(execResult(fixture("locksettings-set-pin-ok.txt") + EXIT(0)));

    const result = await new AdbLockSettingsClient(adb).setCredential("pin", "1357", "2468");

    expect(result).toEqual({ outcome: "ok" });
    expect(adb.calls[0].args).toEqual([
      "shell",
      "locksettings",
      "set-pin",
      "--old",
      "2468",
      "1357",
      ";",
      "echo",
      "AUTOMOBILE_LOCKSETTINGS_EXIT=$?",
    ]);
    expect(adb.calls[0].options).toMatchObject({
      noRetry: true,
      logLabel: LOCK_SETTINGS_LOG_LABEL,
    });
  });

  test("quotes a password for the device shell", async () => {
    const adb = new FakeLockSettingsAdb();
    adb.responses.push(execResult(EXIT(0)));
    await new AdbLockSettingsClient(adb).setCredential("password", "a b$c");
    expect(adb.calls[0].args.slice(2, 4)).toEqual(["set-password", "'a b$c'"]);
  });

  test("classifies a refused old credential and scrubs the echoed value", async () => {
    const adb = new FakeLockSettingsAdb();
    adb.responses.push(execResult(fixture("locksettings-old-mismatch.txt") + EXIT(255)));

    const result = await new AdbLockSettingsClient(adb).setCredential("pin", "1357", "2468");

    expect(result.outcome).toBe("credential_mismatch");
    expect(result.detail).toBe("Old password '<redacted>' didn't match");
  });

  test("classifies clear outcomes", async () => {
    const adb = new FakeLockSettingsAdb();
    adb.responses.push(
      execResult(fixture("locksettings-clear-ok.txt") + EXIT(0)),
      execResult(fixture("locksettings-old-without-credential.txt") + EXIT(255)),
      execResult(fixture("locksettings-no-secure-lock-screen.txt") + EXIT(255)),
    );
    const client = new AdbLockSettingsClient(adb);

    expect((await client.clearCredential("1357")).outcome).toBe("ok");
    expect((await client.clearCredential("1357")).outcome).toBe("no_existing_credential");
    expect((await client.clearCredential("1357")).outcome).toBe("unsupported");
    expect(adb.calls[0].args.slice(1, 5)).toEqual(["locksettings", "clear", "--old", "1357"]);
  });

  test("a transport failure is scrubbed before it is logged or returned", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    const adb = new FakeLockSettingsAdb();
    adb.responses.push(
      new Error("Command failed: adb shell locksettings set-pin 1357: device offline"),
    );

    try {
      const result = await new AdbLockSettingsClient(adb).setCredential("pin", "1357");

      expect(result.outcome).toBe("failed");
      expect(result.detail).not.toContain("1357");
      expect(warn).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(warn.mock.calls)).not.toContain("1357");
    } finally {
      warn.mockRestore();
    }
  });

  test("output with no exit marker is a failure, not success", async () => {
    const adb = new FakeLockSettingsAdb();
    adb.responses.push(execResult(""));
    expect((await new AdbLockSettingsClient(adb).clearCredential("1357")).outcome).toBe("failed");
  });
});
