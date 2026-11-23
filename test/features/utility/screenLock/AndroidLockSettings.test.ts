import { describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DeviceLockState, ExecResult } from "../../../../src/models";
import type { AdbExecuteOptions } from "../../../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";
import {
  AdbLockSettingsClient,
  createLockUserResolver,
  LOCK_SETTINGS_LOG_LABEL,
  parseLockSettingsCredentialType,
  scrubLockCredentials,
} from "../../../../src/features/utility/screenLock/AndroidLockSettings";
import { createExecResult } from "../../../../src/utils/execResult";
import { logger } from "../../../../src/utils/logger";
import { runExecSeam } from "../../../../src/utils/ExecSeam";
import type { ToolCallCapture } from "../../../../src/utils/fixtureCapture/fixtureCaptureFormat";
import { runWithFixtureCapture } from "../../../../src/utils/fixtureCapture/fixtureCaptureScope";
import { FakeAdbClient } from "../../../fakes/FakeAdbClient";
import { FakeTimer } from "../../../fakes/FakeTimer";

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
  // API 30 prints `None`/`Pin`; API 34 and later print `NONE`/`PIN`; the parser folds case.
  test.each(["phone-api30", "phone-api34", "phone-api37", "watch-api37", "automotive-api34"])(
    "reads user 0's credential type on %s",
    (device) => {
      expect(
        parseLockSettingsCredentialType(fixture(`dumpsys-lock-settings-none-${device}.txt`)),
      ).toEqual({ type: "none", secure: false });
    },
  );

  test.each(["phone-api30", "phone-api34", "phone-api37", "watch-api37"])(
    "reads a PIN on %s",
    (device) => {
      expect(
        parseLockSettingsCredentialType(fixture(`dumpsys-lock-settings-pin-${device}.txt`)),
      ).toEqual({ type: "pin", secure: true });
    },
  );

  test("only user 0 counts: an Automotive image's driver user 10 has its own PIN", () => {
    const dump = fixture("dumpsys-lock-settings-pin-automotive-api34.txt");
    expect(dump).toMatch(/User 10[\s\S]*CredentialType: PIN/);
    expect(parseLockSettingsCredentialType(dump)).toEqual({ type: "none", secure: false });
  });

  test("reads the foreground driver user 10 when asked, on the same Automotive dump (#19060)", () => {
    const dump = fixture("dumpsys-lock-settings-pin-automotive-api34.txt");
    expect(parseLockSettingsCredentialType(dump, 10)).toEqual({ type: "pin", secure: true });
  });

  // Not reproducible on the AVDs available: an Android 10 dump and a dump with no type line.
  test("an Android 10 integer 2 is secure but of unknown type; a missing line is unknown", () => {
    expect(
      parseLockSettingsCredentialType("User State:\n  User 0\n    CredentialType: 2\n"),
    ).toEqual({ type: "unknown", secure: true });
    expect(parseLockSettingsCredentialType("User State:\n  User 0\n    Quality: 0\n")).toEqual({
      type: "unknown",
    });
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
    adb.responses.push(execResult(fixture("dumpsys-lock-settings-pin-phone-api34.txt")));
    expect(await new AdbLockSettingsClient(adb).read()).toEqual({ type: "pin", secure: true });
    expect(adb.calls[0].args).toEqual(["shell", "dumpsys", "lock_settings"]);
  });

  test("falls back to the keyguard's secure flag when the dump names no type", async () => {
    const adb = new FakeLockSettingsAdb();
    adb.responses.push(execResult("User State:\n  User 0\n    Quality: 0\n"));
    adb.deviceLock = { locked: true, keyguardShowing: true, secure: false };
    expect(await new AdbLockSettingsClient(adb).read()).toEqual({ type: "none", secure: false });
  });

  test("sets a PIN with --old, under a log label, without retries", async () => {
    const adb = new FakeLockSettingsAdb();
    adb.responses.push(execResult(fixture("locksettings-set-pin-ok-phone-api34.txt") + EXIT(0)));

    const result = await new AdbLockSettingsClient(adb).setCredential("pin", "1357", "2468");

    expect(result).toEqual({ outcome: "ok" });
    expect(adb.calls[0].args).toEqual([
      "shell",
      "locksettings",
      "set-pin",
      "--user",
      "0",
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
    expect(adb.calls[0].args.slice(2, 6)).toEqual(["set-password", "--user", "0", "'a b$c'"]);
  });

  test("classifies a refused old credential and scrubs the echoed value", async () => {
    const adb = new FakeLockSettingsAdb();
    adb.responses.push(
      execResult(fixture("locksettings-old-mismatch-phone-api34.txt") + EXIT(255)),
    );

    const result = await new AdbLockSettingsClient(adb).setCredential("pin", "1357", "2468");

    expect(result.outcome).toBe("credential_mismatch");
    expect(result.detail).toBe("Old password '<redacted>' didn't match");
  });

  test("classifies clear outcomes", async () => {
    const adb = new FakeLockSettingsAdb();
    adb.responses.push(
      execResult(fixture("locksettings-clear-ok-phone-api34.txt") + EXIT(0)),
      execResult(fixture("locksettings-old-without-credential-phone-api34.txt") + EXIT(255)),
      execResult(fixture("locksettings-set-pin-no-secure-lock-screen-tv-api36.txt") + EXIT(255)),
    );
    const client = new AdbLockSettingsClient(adb);

    expect((await client.clearCredential("1357")).outcome).toBe("ok");
    expect((await client.clearCredential("1357")).outcome).toBe("no_existing_credential");
    expect((await client.clearCredential("1357")).outcome).toBe("unsupported");
    expect(adb.calls[0].args.slice(1, 7)).toEqual([
      "locksettings",
      "clear",
      "--user",
      "0",
      "--old",
      "1357",
    ]);
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

describe("AdbLockSettingsClient fixture capture", () => {
  test("a refused change records the scrubbed output and marks the command redacted", async () => {
    const captures: ToolCallCapture[] = [];
    // Runs the command through the real exec seam, so the capture sees what locksettings echoed.
    const adb = new FakeLockSettingsAdb();
    adb.execute = (args) =>
      runExecSeam(
        async () => ({
          stdout: `${fixture("locksettings-old-mismatch-phone-api34.txt")}${EXIT(1)}`,
          stderr: "",
        }),
        {},
        { command: "adb", args },
      );

    await runWithFixtureCapture(
      "setScreenLock",
      {
        writer: { write: async (capture) => void captures.push(capture) },
        timer: new FakeTimer(),
        sourceIdentity: async () => ({ automobileVersion: "0", sourceTreeState: "clean" }),
      },
      () => new AdbLockSettingsClient(adb).clearCredential("2468"),
    );

    const [command] = captures[0]?.commands ?? [];
    expect(command?.stdout).toContain("Old password '<redacted>' didn't match");
    expect(command?.redacted).toBe(true);
    expect(JSON.stringify(captures)).not.toContain("2468");
  });
});

describe("AdbLockSettingsClient on an Automotive foreground user (#19060)", () => {
  test("sets, clears and reads back the resolved user instead of user 0", async () => {
    const adb = new FakeLockSettingsAdb();
    const client = new AdbLockSettingsClient(adb, async () => 10);
    adb.responses.push(execResult("Pin set to '2468'\n" + EXIT(0)));
    await client.setCredential("pin", "2468");
    adb.responses.push(execResult("Lock credential cleared\n" + EXIT(0)));
    await client.clearCredential("2468");
    adb.responses.push(execResult(fixture("dumpsys-lock-settings-pin-automotive-api34.txt")));
    const reading = await client.read();
    expect(adb.calls[0].args.slice(0, 5)).toEqual([
      "shell",
      "locksettings",
      "set-pin",
      "--user",
      "10",
    ]);
    expect(adb.calls[1].args.slice(0, 5)).toEqual([
      "shell",
      "locksettings",
      "clear",
      "--user",
      "10",
    ]);
    expect(reading).toEqual({ type: "pin", secure: true });
  });

  test("a non-automotive device never asks for the foreground user and targets user 0", async () => {
    const adb = new FakeLockSettingsAdb();
    const phone = new FakeAdbClient();
    const resolve = createLockUserResolver(phone, { formFactor: "phone" });
    expect(await resolve()).toBe(0);
    expect(phone.wasCommandExecuted("get-current-user")).toBe(false);
    await new AdbLockSettingsClient(adb, resolve).setCredential("pin", "2468");
    expect(adb.calls[0].args.slice(3, 5)).toEqual(["--user", "0"]);
  });

  test("falls back to user 0 when the foreground user cannot be read", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    const offline = new FakeAdbClient();
    offline.setCommandError("shell am get-current-user", new Error("offline"));
    const resolve = createLockUserResolver(offline, { formFactor: "automotive" });
    expect(await resolve()).toBe(0);
    warn.mockRestore();
  });
});
