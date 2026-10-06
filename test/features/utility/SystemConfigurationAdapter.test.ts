import { afterEach, beforeEach, describe, it, expect, spyOn, type Mock } from "bun:test";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android/AndroidCtrlProxyClient";
import { FakeSystemConfigurationAdapter } from "../../fakes/FakeSystemConfigurationAdapter";
import { AndroidSystemConfigurationAdapter } from "../../../src/features/utility/system-configuration/AndroidSystemConfigurationAdapter";
import { IosSystemConfigurationAdapter } from "../../../src/features/utility/system-configuration/IosSystemConfigurationAdapter";
import { createSystemConfigurationAdapter } from "../../../src/features/utility/system-configuration/createSystemConfigurationAdapter";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";
import { FakeProcessExecutor } from "../../fakes/FakeProcessExecutor";
import { FakeTimer } from "../../fakes/FakeTimer";
import type { BootedDevice, ExecResult } from "../../../src/models";
import type { SystemConfigurationAdapter } from "../../../src/utils/interfaces/SystemConfigurationAdapter";

import { logger } from "../../../src/utils/logger";
import {
  LOCALE_CAPTURE_APP_ID,
  LOCALE_CAPTURE_MISSING_APP_ID,
  readLocaleCapture,
  readMissingPackageCapture,
} from "../../helpers/androidLocaleCapture";

/**
 * Sanity-check the platform-agnostic SystemConfigurationAdapter contract.
 * Tests deliberately type their subjects as the abstract interface so a
 * regression that drops one of the shared members will surface as a
 * compile error here.
 */
describe("SystemConfigurationAdapter", () => {
  const androidDevice: BootedDevice = {
    deviceId: "emulator-5554",
    name: "Pixel 7",
    platform: "android",
  };
  const iosSimulator: BootedDevice = {
    deviceId: "A1B2C3D4-E5F6-7890-ABCD-EF1234567890",
    name: "iPhone 15",
    platform: "ios",
  };
  const iosPhysical: BootedDevice = {
    deviceId: "00008130-001234567890abcd",
    name: "iPhone 15 Pro",
    platform: "ios",
  };

  const execResult = (stdout: string, stderr = ""): ExecResult => ({
    stdout,
    stderr,
    toString: () => stdout,
    trim: () => stdout.trim(),
    includes: (s: string) => stdout.includes(s),
  });

  // (FakeSystemConfigurationAdapter self-tests moved to
  // test/fakes/FakeSystemConfigurationAdapter.test.ts — they exercise only the
  // fake, not production code.)

  // Two platform adapters plus the fake all satisfy SystemConfigurationAdapter.
  // The conformance guard is the compile-time `SystemConfigurationAdapter`
  // annotation on the constructed adapter: if a shared member is dropped from an
  // implementation, `c.build()` no longer assigns to the interface-typed local
  // and this file fails to type-check. The former runtime `typeof x === "function"`
  // assertions restated what the type system already enforces, so they are gone.
  interface AdapterCase {
    name: string;
    build: () => SystemConfigurationAdapter;
  }

  const cases: ReadonlyArray<AdapterCase> = [
    {
      name: "AndroidSystemConfigurationAdapter",
      build: () => new AndroidSystemConfigurationAdapter(androidDevice, new FakeAdbClient() as any),
    },
    {
      name: "IosSystemConfigurationAdapter",
      build: () => new IosSystemConfigurationAdapter(iosSimulator, new FakeProcessExecutor()),
    },
    {
      name: "FakeSystemConfigurationAdapter",
      build: () => new FakeSystemConfigurationAdapter(),
    },
  ];

  for (const c of cases) {
    describe(c.name, () => {
      it("constructs as a SystemConfigurationAdapter", () => {
        const adapter: SystemConfigurationAdapter = c.build();
        expect(adapter).toBeDefined();
      });
    });
  }

  describe("Android configuration failure traces", () => {
    const cases = [
      {
        name: "device-wide locale",
        command: "setprop persist.sys.locale",
        run: (adapter: AndroidSystemConfigurationAdapter) =>
          adapter.setLocale("ja-JP", { appId: "com.test", broadcast: false }),
        legacy: true,
      },
      {
        name: "app locale",
        command: "cmd locale set-app-locales",
        run: (adapter: AndroidSystemConfigurationAdapter) =>
          adapter.setLocale("ja-JP", { appId: "com.test", broadcast: false }),
      },
      {
        name: "time zone",
        command: "setprop persist.sys.timezone",
        run: (adapter: AndroidSystemConfigurationAdapter) => adapter.setTimeZone("UTC"),
      },
      {
        name: "24-hour format",
        command: "settings put system time_12_24",
        run: (adapter: AndroidSystemConfigurationAdapter) => adapter.set24HourFormat(true),
      },
      {
        name: "calendar system",
        command: "settings put system calendar_type",
        run: (adapter: AndroidSystemConfigurationAdapter) => adapter.setCalendarSystem("gregory"),
      },
    ];
    for (const entry of cases) {
      it(`retains the ${entry.name} typed failure and warns`, async () => {
        const adb = new FakeAdbExecutor();
        adb.setAndroidApiLevel(entry.legacy ? 32 : 33);
        adb.setCommandResponse("shell id", { stdout: "uid=0(root)", stderr: "" });
        adb.setCommandError(entry.command, new Error("write denied"));
        const capability = spyOn(AndroidCtrlProxyClient, "getInstance").mockImplementation(() => {
          throw new Error("optional service unavailable");
        });
        const log = spyOn(logger, "warn").mockImplementation(() => {});
        try {
          const result = await entry.run(
            new AndroidSystemConfigurationAdapter(androidDevice, adb, new FakeTimer()),
          );
          expect(result.success).toBe(false);
          expect(result.error).toContain("write denied");
          expect(log).toHaveBeenCalledWith(
            `[SystemConfigurationManager] Failed to set ${entry.name}: write denied`,
            expect.any(Error),
          );
        } finally {
          capability.mockRestore();
          log.mockRestore();
        }
      });
    }
  });

  describe("AndroidSystemConfigurationAdapter behavior", () => {
    it("quotes raw calendar input before the device shell and preserves normal identifiers", async () => {
      const adb = new FakeAdbClient();
      const adapter = new AndroidSystemConfigurationAdapter(androidDevice, adb as any);
      const payload = "gregorian; touch /data/local/tmp/pwn";
      adb.setCommandResult("shell settings get system calendar_type", payload);

      expect((await adapter.setCalendarSystem(payload)).success).toBe(true);
      expect(
        adb
          .getCommandCalls()
          .filter((call) => call.command.startsWith("shell settings put system"))
          .map((call) => call.command),
      ).toEqual(["shell settings put system calendar_type 'gregorian; touch /data/local/tmp/pwn'"]);

      adb.setCommandResult("shell settings get system calendar_type", "gregory");
      expect((await adapter.setCalendarSystem("gregory")).success).toBe(true);
      expect(adb.wasCommandExecuted("shell settings put system calendar_type 'gregory'")).toBe(
        true,
      );
    });

    it("sets an app-scoped locale with cmd locale when appId is provided", async () => {
      const adb = new FakeAdbClient();
      adb.setCommandResult("shell getprop ro.build.version.sdk", "36");
      // Device replies are the API 36 captures in test/fixtures/android-locale/.
      const appLocaleResponses = [
        readLocaleCapture("0-initial").appLocalesUser0,
        readLocaleCapture("7-fr-FR").appLocalesUser0,
      ];
      const original = adb.executeCommand.bind(adb);
      adb.executeCommand = (async (command: string, ...rest: any[]) => {
        if (command === `shell cmd locale get-app-locales '${LOCALE_CAPTURE_APP_ID}' --user 0`) {
          const stdout = appLocaleResponses.shift() ?? readLocaleCapture("7-fr-FR").appLocalesUser0;
          return {
            stdout,
            stderr: "",
            toString: () => stdout,
            trim: () => stdout.trim(),
            includes: (s: string) => stdout.includes(s),
          };
        }
        return original(command, ...rest);
      }) as any;

      const adapter = new AndroidSystemConfigurationAdapter(androidDevice, adb as any);
      const result = await adapter.setLocale("fr-FR", {
        broadcast: false,
        appId: LOCALE_CAPTURE_APP_ID,
      });

      expect(result.success).toBe(true);
      expect(result.method).toBe(`cmd locale set-app-locales ${LOCALE_CAPTURE_APP_ID} --user 0`);
      expect(result.previousLanguageTag).toBeNull();
      expect(
        adb.wasCommandExecuted(
          `cmd locale set-app-locales '${LOCALE_CAPTURE_APP_ID}' --user 0 --locales 'fr-FR'`,
        ),
      ).toBe(true);
      expect(adb.wasCommandExecuted("setprop persist.sys.locale")).toBe(false);
      expect(adb.wasCommandExecuted("stop; start")).toBe(false);
    });

    it("targets the foreground Android work-profile user for app-scoped locale commands", async () => {
      const adb = new FakeAdbClient();
      adb.setCommandResult("shell getprop ro.build.version.sdk", "36");
      adb.setForegroundApp({ packageName: "com.example.app", userId: 10 });
      const appLocaleResponses = [
        "Locales for com.example.app for user 10 are []\n",
        "Locales for com.example.app for user 10 are [ja-JP]\n",
      ];
      const original = adb.executeCommand.bind(adb);
      adb.executeCommand = (async (command: string, ...rest: any[]) => {
        if (command === "shell cmd locale get-app-locales 'com.example.app' --user 10") {
          await original(command, ...rest);
          const stdout =
            appLocaleResponses.shift() ?? "Locales for com.example.app for user 10 are [ja-JP]\n";
          return {
            stdout,
            stderr: "",
            toString: () => stdout,
            trim: () => stdout.trim(),
            includes: (s: string) => stdout.includes(s),
          };
        }
        return original(command, ...rest);
      }) as any;

      const adapter = new AndroidSystemConfigurationAdapter(androidDevice, adb as any);
      const result = await adapter.setLocale("ja-JP", {
        broadcast: false,
        appId: "com.example.app",
      });

      expect(result.success).toBe(true);
      expect(result.method).toBe("cmd locale set-app-locales com.example.app --user 10");
      expect(
        adb.wasCommandExecuted(
          "cmd locale set-app-locales 'com.example.app' --user 10 --locales 'ja-JP'",
        ),
      ).toBe(true);
      expect(adb.wasCommandExecuted("cmd locale get-app-locales 'com.example.app' --user 10")).toBe(
        true,
      );
      expect(adb.wasCommandExecuted("cmd locale get-app-locales 'com.example.app' --user 0")).toBe(
        false,
      );
    });

    describe("app-scoped locale user targeting (issue #10012)", () => {
      const OWNER = { userId: 0, name: "Owner", flags: 0x13, running: true };
      const WORK = { userId: 10, name: "Work", flags: 0x30, running: true };
      const SECONDARY = { userId: 11, name: "Guest", flags: 0x400, running: true };
      const packages = (...names: string[]) => names.map((name) => `package:${name}\n`).join("");

      /** Background app on API 36 whose per-user locale read-back succeeds. */
      const backgroundApp = (
        users: Array<{ userId: number; name: string; flags: number; running: boolean }>,
        installedFor: Record<number, string>,
      ) => {
        const adb = new FakeAdbClient();
        adb.setCommandResult("shell getprop ro.build.version.sdk", "36");
        adb.setForegroundApp({ packageName: "com.other.app", userId: 0 });
        adb.setUsers(users);
        for (const user of users) {
          adb.setCommandResult(
            `shell pm list packages --user ${user.userId}`,
            installedFor[user.userId] ?? "",
          );
          adb.setCommandResultSequence(
            `shell cmd locale get-app-locales 'com.example.app' --user ${user.userId}`,
            [
              `Locales for com.example.app for user ${user.userId} are []\n`,
              `Locales for com.example.app for user ${user.userId} are [ja-JP]\n`,
            ],
          );
        }
        return adb;
      };
      const setJa = (adb: FakeAdbClient) =>
        new AndroidSystemConfigurationAdapter(androidDevice, adb).setLocale("ja-JP", {
          broadcast: false,
          appId: "com.example.app",
        });
      const setCommands = (adb: FakeAdbClient) =>
        adb
          .getCommandCalls()
          .map((call) => call.command)
          .filter((command) => command.startsWith("shell cmd locale set-app-locales"));

      it("targets the running user where the app is installed for a backgrounded app", async () => {
        const adb = backgroundApp([OWNER, WORK], { 10: packages("com.example.app") });

        const result = await setJa(adb);

        expect(result.success).toBe(true);
        expect(result.method).toBe("cmd locale set-app-locales com.example.app --user 10");
        expect(setCommands(adb)).toEqual([
          "shell cmd locale set-app-locales 'com.example.app' --user 10 --locales 'ja-JP'",
        ]);
      });

      it("does not send a personal-only app to a running work profile", async () => {
        const adb = backgroundApp([OWNER, WORK], { 0: packages("com.example.app") });

        const result = await setJa(adb);

        expect(result.success).toBe(true);
        expect(result.method).toBe("cmd locale set-app-locales com.example.app --user 0");
        expect(setCommands(adb)).toEqual([
          "shell cmd locale set-app-locales 'com.example.app' --user 0 --locales 'ja-JP'",
        ]);
      });

      it("does not treat a running non-managed secondary user as a work profile", async () => {
        const adb = backgroundApp([OWNER, SECONDARY], { 0: packages("com.example.app") });

        const result = await setJa(adb);

        expect(result.success).toBe(true);
        expect(setCommands(adb)).toEqual([
          "shell cmd locale set-app-locales 'com.example.app' --user 0 --locales 'ja-JP'",
        ]);
      });

      it("keeps a single-user device on user 0 without probing installs", async () => {
        const adb = backgroundApp([OWNER], {});

        const result = await setJa(adb);

        expect(result.success).toBe(true);
        expect(setCommands(adb)).toEqual([
          "shell cmd locale set-app-locales 'com.example.app' --user 0 --locales 'ja-JP'",
        ]);
        expect(adb.wasCommandExecuted("pm list packages")).toBe(false);
      });

      it("returns a typed failure, without mutating, when the target user is ambiguous", async () => {
        const adb = backgroundApp(
          [OWNER, WORK, { userId: 12, name: "Work 2", flags: 0x30, running: true }],
          { 10: packages("com.example.app"), 12: packages("com.example.app") },
        );

        const result = await setJa(adb);

        expect(result.success).toBe(false);
        expect(result.error).toContain("ambiguous");
        expect(setCommands(adb)).toEqual([]);
      });

      it("pins the work profile when the app is installed for both users", async () => {
        // Same choice the pre-resolver code made (first running non-zero user), now via the
        // shared resolver's managed-profile preference. Locale goes to the work copy, not user 0's.
        const adb = backgroundApp([OWNER, WORK], {
          0: packages("com.example.app"),
          10: packages("com.example.app"),
        });

        const result = await setJa(adb);

        expect(result.success).toBe(true);
        expect(result.method).toBe("cmd locale set-app-locales com.example.app --user 10");
        expect(setCommands(adb)).toEqual([
          "shell cmd locale set-app-locales 'com.example.app' --user 10 --locales 'ja-JP'",
        ]);
      });

      describe("single-user device whose user list cannot be trusted", () => {
        const unreadable = (users: Array<typeof OWNER | typeof WORK>) => {
          const adb = backgroundApp([OWNER], {});
          adb.setUsers(users);
          return adb;
        };

        it("falls back to user 0 with a warning when the user list comes back empty", async () => {
          const adb = unreadable([]);
          adb.setCommandResult("shell am get-current-user", "0\n");

          const result = await setJa(adb);

          expect(result.success).toBe(true);
          expect(result.method).toBe("cmd locale set-app-locales com.example.app --user 0");
          expect(result.warning).toContain("Could not read the device's Android user list");
          expect(setCommands(adb)).toEqual([
            "shell cmd locale set-app-locales 'com.example.app' --user 0 --locales 'ja-JP'",
          ]);
        });

        it("falls back to user 0 when the only listed user is not marked running", async () => {
          // dumpsys State: line missing or further than 10 lines from UserInfo.
          const adb = unreadable([{ ...OWNER, running: false }]);
          adb.setCommandResult("shell am get-current-user", "0\n");

          const result = await setJa(adb);

          expect(result.success).toBe(true);
          expect(result.warning).toBeDefined();
          expect(setCommands(adb)).toHaveLength(1);
        });

        it("does not warn on a normal single-user resolution", async () => {
          const result = await setJa(backgroundApp([OWNER], {}));

          expect(result.success).toBe(true);
          expect(result.warning).toBeUndefined();
        });

        it("keeps failing when a managed profile is known but nothing is running", async () => {
          const adb = unreadable([
            { ...OWNER, running: false },
            { ...WORK, running: false },
          ]);

          const result = await setJa(adb);

          expect(result.success).toBe(false);
          expect(result.error).toContain("unavailable");
          expect(setCommands(adb)).toEqual([]);
        });

        it("keeps failing on an empty user list when the current user is not user 0", async () => {
          const adb = unreadable([]);
          adb.setCommandResult("shell am get-current-user", "10\n");

          const result = await setJa(adb);

          expect(result.success).toBe(false);
          expect(result.error).toContain("unavailable");
          expect(setCommands(adb)).toEqual([]);
        });

        it("keeps failing when the user list is empty and the current-user probe fails too", async () => {
          const adb = unreadable([]);
          adb.setCommandError("shell am get-current-user", new Error("adb timeout"));

          const result = await setJa(adb);

          expect(result.success).toBe(false);
          expect(result.error).toContain("unavailable");
          expect(setCommands(adb)).toEqual([]);
        });

        it("keeps failing when the user list is empty and the current user is unparseable", async () => {
          const adb = unreadable([]);
          adb.setCommandResult("shell am get-current-user", "Error: system not ready\n");

          const result = await setJa(adb);

          expect(result.success).toBe(false);
          expect(result.error).toContain("unavailable");
          expect(setCommands(adb)).toEqual([]);
        });

        it("falls back when the current user can be read and is user 0", async () => {
          const adb = unreadable([]);
          adb.setCommandResult("shell am get-current-user", "0\n");

          const result = await setJa(adb);

          expect(result.success).toBe(true);
          expect(result.warning).toBeDefined();
        });
      });

      it("returns a typed failure when the Android user list cannot be read", async () => {
        const adb = backgroundApp([OWNER, WORK], { 0: packages("com.example.app") });
        adb.listUsers = async () => {
          throw new Error("adb offline");
        };

        const result = await setJa(adb);

        expect(result.success).toBe(false);
        expect(result.error).toBe(
          "Failed to resolve Android user for com.example.app: adb offline",
        );
        expect(setCommands(adb)).toEqual([]);
      });
    });

    it("uses root-backed system locale after adb root below Android 13 and reports system scope", async () => {
      const adb = new FakeAdbClient();
      adb.setCommandResult("shell getprop ro.build.version.sdk", "32");
      adb.setCommandResult("root", "restarting adbd as root\n");
      adb.setCommandResult("wait-for-device", "");
      adb.setCommandResult("shell id", "uid=0(root) gid=0(root)\n");
      // persist.sys.locale is read once for the previous value, then again for the
      // race-free read-back after the framework restart.
      adb.setCommandResultSequence("shell getprop persist.sys.locale", [
        { stdout: "en-US", stderr: "" },
        { stdout: "ja-JP", stderr: "" },
      ]);
      adb.setCommandResult("shell getprop sys.boot_completed", "1");
      const adapter = new AndroidSystemConfigurationAdapter(androidDevice, adb as any);
      const result = await adapter.setLocale("ja-JP", {
        broadcast: false,
        appId: "com.example.app",
      });

      expect(result.success).toBe(true);
      expect(result.method).toBe("setprop persist.sys.locale + stop/start after adb root");
      expect(result.localeScope).toBe("system");
      expect(result.previousLanguageTag).toBe("en-US");
      expect(adb.wasCommandExecuted("root")).toBe(true);
      expect(adb.getCommandCalls().find((call) => call.command === "root")?.timeoutMs).toBe(30_000);
      expect(
        adb.getCommandCalls().find((call) => call.command === "wait-for-device")?.timeoutMs,
      ).toBe(60_000);
      expect(adb.wasCommandExecuted("shell id")).toBe(true);
      expect(adb.wasCommandExecuted("cmd locale set-app-locales")).toBe(false);
      expect(adb.wasCommandExecuted("setprop persist.sys.locale 'ja-JP'")).toBe(true);
      // Read-back verifies the prop we actually wrote, never `am get-config`,
      // which would race the in-progress framework restart (issue #6346).
      expect(adb.wasCommandExecuted("shell am get-config")).toBe(false);
    });

    it("returns a root-capability error below Android 13 when adb root fails", async () => {
      const adb = new FakeAdbClient();
      adb.setCommandResult("shell getprop ro.build.version.sdk", "32");
      adb.setCommandError("root", new Error("adbd cannot run as root in production builds"));
      const adapter = new AndroidSystemConfigurationAdapter(androidDevice, adb as any);
      const result = await adapter.setLocale("ja-JP", { appId: "com.example.app" });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Android API 32 does not support app-scoped locale changes");
      expect(result.error).toContain("target emulator is not root-capable");
      expect(result.error).toContain("adbd cannot run as root in production builds");
      expect(adb.wasCommandExecuted("setprop persist.sys.locale")).toBe(false);
    });

    it("returns a root-capability error below Android 13 when shell remains non-root", async () => {
      const adb = new FakeAdbClient();
      adb.setCommandResult("shell getprop ro.build.version.sdk", "32");
      adb.setCommandResult("root", "adbd cannot run as root in production builds\n");
      adb.setCommandResult("wait-for-device", "");
      adb.setCommandResult("shell id", "uid=2000(shell) gid=2000(shell)\n");
      const adapter = new AndroidSystemConfigurationAdapter(androidDevice, adb as any);
      const result = await adapter.setLocale("ja-JP", { appId: "com.example.app" });

      expect(result.success).toBe(false);
      expect(result.error).toContain("ADB shell is still not root");
      expect(result.error).toContain("uid=2000(shell)");
      expect(adb.wasCommandExecuted("setprop persist.sys.locale")).toBe(false);
    });

    it("returns false when app-scoped locale read-back does not match", async () => {
      const adb = new FakeAdbClient();
      adb.setCommandResult("shell getprop ro.build.version.sdk", "36");
      adb.setCommandResult(
        `shell cmd locale get-app-locales '${LOCALE_CAPTURE_APP_ID}' --user 0`,
        readLocaleCapture("6-he-IL").appLocalesUser0,
      );
      const adapter = new AndroidSystemConfigurationAdapter(androidDevice, adb as any);
      const result = await adapter.setLocale("fr-FR", { appId: LOCALE_CAPTURE_APP_ID });

      expect(result.success).toBe(false);
      expect(result.error).toBe(
        `Read-back verification failed for ${LOCALE_CAPTURE_APP_ID}: expected "fr-FR" but got "he-IL"`,
      );
      expect(adb.wasCommandExecuted("am broadcast")).toBe(false);
    });

    it("returns false when app-scoped locale read-back has no locale list", async () => {
      const adb = new FakeAdbExecutor();
      adb.setAndroidApiLevel(36);
      adb.setCommandResponse("cmd locale get-app-locales", execResult(""));
      const adapter = new AndroidSystemConfigurationAdapter(androidDevice, adb, new FakeTimer());
      const result = await adapter.setLocale("ja-JP", { appId: "com.example.app" });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Locale change outcome is indeterminate");
      expect(result.error).toContain("could not be read back for com.example.app");
      expect(adb.wasCommandExecuted("am broadcast")).toBe(false);
    });

    it("returns a definite not-installed failure, not an indeterminate one, for an unknown package (#10211)", async () => {
      const adb = new FakeAdbClient();
      adb.setCommandResult("shell getprop ro.build.version.sdk", "36");
      adb.setCommandResult(
        `shell cmd locale get-app-locales '${LOCALE_CAPTURE_MISSING_APP_ID}' --user 0`,
        readMissingPackageCapture().getAppLocalesUser0.output,
      );
      const adapter = new AndroidSystemConfigurationAdapter(androidDevice, adb as any);
      const result = await adapter.setLocale("fr-FR", { appId: LOCALE_CAPTURE_MISSING_APP_ID });

      expect(result.success).toBe(false);
      expect(result.error).toContain(
        `app ${LOCALE_CAPTURE_MISSING_APP_ID} is not installed for user 0; nothing was changed`,
      );
      expect(result.error).not.toContain("indeterminate");
      expect(adb.wasCommandExecuted("set-app-locales")).toBe(false);
      expect(adb.wasCommandExecuted("am broadcast")).toBe(false);
    });

    // Not captured: a two-locale app override. The comma-joined list is Android's LocaleList form
    // but no capture holds one, so this reply is hand-built.
    it("uses the first locale when app-scoped read-back returns multiple locales", async () => {
      const adb = new FakeAdbClient();
      adb.setCommandResult("shell getprop ro.build.version.sdk", "36");
      adb.setCommandResult(
        "shell cmd locale get-app-locales 'com.example.app' --user 0",
        "Locales for com.example.app for user 0 are [ja-JP,en-US]\n",
      );
      const adapter = new AndroidSystemConfigurationAdapter(androidDevice, adb as any);
      const result = await adapter.setLocale("ja-JP", {
        broadcast: false,
        appId: "com.example.app",
      });

      expect(result.success).toBe(true);
      expect(result.previousLanguageTag).toBe("ja-JP");
    });

    it("requires appId for Android locale changes", async () => {
      const adb = new FakeAdbClient();
      const adapter = new AndroidSystemConfigurationAdapter(androidDevice, adb as any);
      const result = await adapter.setLocale("ja-JP", { broadcast: false });

      expect(result.success).toBe(false);
      expect(result.error).toContain("appId is required for Android locale changes");
      expect(adb.wasCommandExecuted("setprop persist.sys.locale")).toBe(false);
      expect(adb.wasCommandExecuted("cmd locale set-app-locales")).toBe(false);
    });

    it("returns false with system scope when the legacy setprop read-back does not take", async () => {
      const adb = new FakeAdbClient();
      adb.setCommandResult("shell getprop ro.build.version.sdk", "32");
      adb.setCommandResult("root", "restarting adbd as root\n");
      adb.setCommandResult("wait-for-device", "");
      adb.setCommandResult("shell id", "uid=0(root) gid=0(root)\n");
      // setprop silently no-ops (e.g. read-only prop): persist.sys.locale keeps
      // its old value on read-back, so we honestly report failure.
      adb.setCommandResult("shell getprop persist.sys.locale", "en-US");
      adb.setCommandResult("shell getprop sys.boot_completed", "1");
      const adapter = new AndroidSystemConfigurationAdapter(androidDevice, adb as any);
      const result = await adapter.setLocale("ja-JP", { appId: "com.example.app" });

      expect(result.success).toBe(false);
      expect(result.localeScope).toBe("system");
      expect(result.previousLanguageTag).toBe("en-US");
      expect(result.error).toBe(
        'Read-back verification failed: expected persist.sys.locale "ja-JP" but got "en-US"',
      );
      expect(adb.wasCommandExecuted("am broadcast")).toBe(false);
    });

    it("reports app scope on the Android 13+ app-scoped path (issue #6346)", async () => {
      const adb = new FakeAdbClient();
      adb.setCommandResult("shell getprop ro.build.version.sdk", "36");
      adb.setCommandResultSequence(
        `shell cmd locale get-app-locales '${LOCALE_CAPTURE_APP_ID}' --user 0`,
        [
          { stdout: readLocaleCapture("0-initial").appLocalesUser0, stderr: "" },
          { stdout: readLocaleCapture("7-fr-FR").appLocalesUser0, stderr: "" },
        ],
      );
      const adapter = new AndroidSystemConfigurationAdapter(androidDevice, adb as any);
      const result = await adapter.setLocale("fr-FR", {
        broadcast: false,
        appId: LOCALE_CAPTURE_APP_ID,
      });

      expect(result.success).toBe(true);
      expect(result.localeScope).toBe("app");
      expect(adb.wasCommandExecuted("setprop persist.sys.locale")).toBe(false);
    });

    it("waits for the framework restart before the legacy read-back instead of racing it (issue #6346)", async () => {
      const adb = new FakeAdbClient();
      adb.setCommandResult("shell getprop ro.build.version.sdk", "31");
      adb.setCommandResult("root", "restarting adbd as root\n");
      adb.setCommandResult("wait-for-device", "");
      adb.setCommandResult("shell id", "uid=0(root) gid=0(root)\n");
      // Previous value, then the value after the restart settles.
      adb.setCommandResultSequence("shell getprop persist.sys.locale", [
        { stdout: "en-US", stderr: "" },
        { stdout: "es-ES", stderr: "" },
      ]);
      // The framework is still restarting for the first two polls (empty
      // boot_completed) before it comes back up — mirroring the wedge in #6346.
      adb.setCommandResultSequence("shell getprop sys.boot_completed", [
        { stdout: "", stderr: "" },
        { stdout: "", stderr: "" },
        { stdout: "1", stderr: "" },
      ]);
      const timer = new FakeTimer();
      timer.enableAutoAdvance();
      const adapter = new AndroidSystemConfigurationAdapter(androidDevice, adb as any, timer);

      const result = await adapter.setLocale("es-ES", {
        broadcast: false,
        appId: "com.android.settings",
      });

      // Result and reality agree: the change applied device-wide and we say so.
      expect(result.success).toBe(true);
      expect(result.localeScope).toBe("system");
      expect(result.languageTag).toBe("es-ES");
      expect(result.previousLanguageTag).toBe("en-US");
      // We polled boot_completed until it returned "1" (did not read back on the
      // first, racing, poll) and slept between polls via the injected timer.
      expect(adb.getCommandCount("shell getprop sys.boot_completed")).toBe(3);
      expect(timer.getSleepCallCount()).toBeGreaterThanOrEqual(2);
      expect(adb.wasCommandExecuted("shell am get-config")).toBe(false);
    });

    it("returns success once the legacy prop is applied even if the framework never reports ready (issue #6346)", async () => {
      const adb = new FakeAdbClient();
      adb.setCommandResult("shell getprop ro.build.version.sdk", "28");
      adb.setCommandResult("root", "restarting adbd as root\n");
      adb.setCommandResult("wait-for-device", "");
      adb.setCommandResult("shell id", "uid=0(root) gid=0(root)\n");
      adb.setCommandResultSequence("shell getprop persist.sys.locale", [
        { stdout: "en-US", stderr: "" },
        { stdout: "es-ES", stderr: "" },
      ]);
      // boot_completed never flips to "1"; the readiness wait times out but the
      // prop-based read-back still confirms the change was applied.
      adb.setCommandResult("shell getprop sys.boot_completed", "");
      const timer = new FakeTimer();
      timer.enableAutoAdvance();
      const adapter = new AndroidSystemConfigurationAdapter(androidDevice, adb as any, timer);

      const result = await adapter.setLocale("es-ES", {
        broadcast: false,
        appId: "com.android.settings",
      });

      // The change applied and persisted, so we must not report success:false.
      expect(result.success).toBe(true);
      expect(result.localeScope).toBe("system");
      expect(result.previousLanguageTag).toBe("en-US");
    });

    it("ignores no-op user_locale when reading Android localization settings", async () => {
      const adb = new FakeAdbClient();
      adb.setCommandResult("shell settings get system user_locale", "fr-FR");
      adb.setCommandResult("shell am get-config", "config: mcc310-mnc260-en-rUS-sw411dp\n");
      const adapter = new AndroidSystemConfigurationAdapter(androidDevice, adb as any);
      const result = await adapter.getLocalizationSettings();

      expect(result.locale).toBe("en-US");
      expect(adb.wasCommandExecuted("settings get system user_locale")).toBe(false);
    });

    it("broadcasts the LOCALE_CHANGED intent via ADB", async () => {
      const adb = new FakeAdbClient();
      const adapter = new AndroidSystemConfigurationAdapter(androidDevice, adb as any);
      const result = await adapter.broadcastLocaleChange();
      expect(result).toBe(true);
      const calls = (adb as any).getCommandCalls?.() ?? [];
      // Look for the broadcast command (FakeAdbClient records under commandCalls)
      const recorded = (adb as any).commandCalls ?? calls;
      expect(
        recorded.some((c: { command: string }) =>
          c.command.includes("am broadcast -a android.intent.action.LOCALE_CHANGED"),
        ),
      ).toBe(true);
    });

    it("returns false from broadcastLocaleChange when ADB fails", async () => {
      const adb = new FakeAdbClient();
      adb.setCommandError(
        "shell am broadcast -a android.intent.action.LOCALE_CHANGED",
        new Error("device offline"),
      );
      const adapter = new AndroidSystemConfigurationAdapter(androidDevice, adb as any);
      expect(await adapter.broadcastLocaleChange()).toBe(false);
    });

    it("sets the system time zone via setprop and verifies the read-back", async () => {
      const adb = new FakeAdbClient();
      adb.setCommandResult("shell getprop persist.sys.timezone", "Asia/Tokyo");
      const adapter = new AndroidSystemConfigurationAdapter(androidDevice, adb as any);
      const result = await adapter.setTimeZone("Asia/Tokyo");
      expect(result.success).toBe(true);
      expect(result.zoneId).toBe("Asia/Tokyo");
      expect(result.method).toBe("setprop persist.sys.timezone");
      expect(adb.wasCommandExecuted("setprop persist.sys.timezone 'Asia/Tokyo'")).toBe(true);
      expect(adb.wasCommandExecuted("cmd alarm set-timezone 'Asia/Tokyo'")).toBe(false);
    });

    it("falls back to cmd alarm when setprop is refused and verifies its read-back", async () => {
      const adb = new FakeAdbExecutor();
      adb.setCommandResponseSequence("shell getprop persist.sys.timezone", [
        execResult("America/Chicago"),
        execResult("Asia/Tokyo"),
      ]);
      adb.setCommandError(
        "shell setprop persist.sys.timezone 'Asia/Tokyo'",
        new Error(
          "Failed to set property 'persist.sys.timezone' to 'Asia/Tokyo'.\nSee dmesg for error reason.",
        ),
      );
      const adapter = new AndroidSystemConfigurationAdapter(androidDevice, adb);
      const result = await adapter.setTimeZone("Asia/Tokyo");
      expect(result).toMatchObject({
        success: true,
        previousZoneId: "America/Chicago",
        method: "cmd alarm set-timezone",
      });
      expect(result).not.toHaveProperty("warning");
      expect(adb.wasCommandExecuted("cmd alarm set-timezone 'Asia/Tokyo'")).toBe(true);
    });

    it("reports read-back mismatch when cmd alarm silently ignores an unknown zone", async () => {
      const adb = new FakeAdbExecutor();
      adb.setCommandResponse("shell getprop persist.sys.timezone", execResult("America/Chicago"));
      adb.setCommandError(
        "shell setprop persist.sys.timezone 'Not/AZone'",
        new Error(
          "Failed to set property 'persist.sys.timezone' to 'Not/AZone'.\nSee dmesg for error reason.",
        ),
      );
      const adapter = new AndroidSystemConfigurationAdapter(androidDevice, adb);
      const result = await adapter.setTimeZone("Not/AZone");
      expect(result).toMatchObject({
        success: false,
        error:
          "Read-back verification failed: expected \"Not/AZone\" but got \"America/Chicago\" Failed to set time zone: Failed to set property 'persist.sys.timezone' to 'Not/AZone'.\nSee dmesg for error reason..",
      });
      expect(adb.wasCommandExecuted("setprop persist.sys.timezone 'America/Chicago'")).toBe(false);
      expect(adb.wasCommandExecuted("cmd alarm set-timezone 'Not/AZone'")).toBe(true);
      expect(adb.wasCommandExecuted("cmd alarm set-timezone 'America/Chicago'")).toBe(false);
    });

    it("retains a failed fallback cause after a no-op setprop", async () => {
      const adb = new FakeAdbExecutor();
      adb.setCommandResponse("shell getprop persist.sys.timezone", execResult("America/Chicago"));
      adb.setCommandError("shell cmd alarm set-timezone 'Asia/Tokyo'", new Error("alarm denied"));
      const adapter = new AndroidSystemConfigurationAdapter(androidDevice, adb);

      const result = await adapter.setTimeZone("Asia/Tokyo");

      expect(result.error).toBe(
        'Read-back verification failed: expected "Asia/Tokyo" but got "America/Chicago" Failed to set time zone: cmd alarm set-timezone: alarm denied.',
      );
      expect(adb.wasCommandExecuted("cmd alarm set-timezone 'Asia/Tokyo'")).toBe(true);
      expect(adb.wasCommandExecuted("cmd alarm set-timezone 'America/Chicago'")).toBe(false);
    });

    it("reports both errors when setprop and cmd alarm fail", async () => {
      const adb = new FakeAdbExecutor();
      adb.setCommandResponse("shell getprop persist.sys.timezone", execResult("America/Chicago"));
      adb.setCommandError(
        "shell setprop persist.sys.timezone 'Asia/Tokyo'",
        new Error("setprop denied"),
      );
      adb.setCommandError("shell cmd alarm set-timezone 'Asia/Tokyo'", new Error("alarm denied"));
      const adapter = new AndroidSystemConfigurationAdapter(androidDevice, adb);
      const result = await adapter.setTimeZone("Asia/Tokyo");
      expect(result).toMatchObject({
        success: false,
        error:
          'Read-back verification failed: expected "Asia/Tokyo" but got "America/Chicago" Failed to set time zone: setprop denied; cmd alarm set-timezone: alarm denied.',
      });
    });

    it("restores the previous zone through cmd alarm when restore setprop is refused", async () => {
      const adb = new FakeAdbExecutor();
      adb.setCommandResponseSequence("shell getprop persist.sys.timezone", [
        execResult("America/Chicago"),
        execResult("America/New_York"),
        execResult("America/New_York"),
        execResult("America/New_York"),
        execResult("America/Chicago"),
      ]);
      adb.setCommandError(
        "shell setprop persist.sys.timezone 'Asia/Tokyo'",
        new Error("set denied"),
      );
      adb.setCommandError(
        "shell setprop persist.sys.timezone 'America/Chicago'",
        new Error("restore denied"),
      );
      const adapter = new AndroidSystemConfigurationAdapter(androidDevice, adb);
      const result = await adapter.setTimeZone("Asia/Tokyo");
      expect(result).toMatchObject({
        success: false,
        error:
          'Read-back verification failed: expected "Asia/Tokyo" but got "America/New_York". Restored the previous time zone ("America/Chicago"). Failed to set time zone: set denied.',
      });
      expect(adb.wasCommandExecuted("cmd alarm set-timezone 'America/Chicago'")).toBe(true);
    });

    it("does not retry a write when the first read-back is unreadable", async () => {
      const adb = new FakeAdbExecutor();
      adb.setCommandError(
        "shell setprop persist.sys.timezone 'Asia/Tokyo'",
        new Error("set denied"),
      );
      const adapter = new AndroidSystemConfigurationAdapter(androidDevice, adb);
      const result = await adapter.setTimeZone("Asia/Tokyo");
      expect(result).toMatchObject({
        success: false,
        error: expect.stringContaining("indeterminate"),
      });
      expect(adb.wasCommandExecuted("cmd alarm set-timezone 'Asia/Tokyo'")).toBe(false);
    });

    it("includes the setprop cause when the first read-back is unreadable", async () => {
      const adb = new FakeAdbExecutor();
      adb.setCommandError(
        "shell setprop persist.sys.timezone 'Asia/Tokyo'",
        new Error("write denied"),
      );
      const adapter = new AndroidSystemConfigurationAdapter(androidDevice, adb);

      const result = await adapter.setTimeZone("Asia/Tokyo");

      expect(result.error).toEqual(
        expect.stringContaining("Time zone change outcome is indeterminate"),
      );
      expect(result.error).toEqual(
        expect.stringContaining("Failed to set time zone: write denied."),
      );
      expect(adb.wasCommandExecuted("cmd alarm set-timezone 'Asia/Tokyo'")).toBe(false);
    });

    it("retains both write failures when the fallback read-back is unreadable", async () => {
      const adb = new FakeAdbExecutor();
      adb.setCommandResponseSequence("shell getprop persist.sys.timezone", [
        execResult("America/Chicago"),
        execResult("America/New_York"),
        execResult(""),
      ]);
      adb.setCommandError(
        "shell setprop persist.sys.timezone 'Asia/Tokyo'",
        new Error("write denied"),
      );
      adb.setCommandError("shell cmd alarm set-timezone 'Asia/Tokyo'", new Error("alarm busy"));
      const adapter = new AndroidSystemConfigurationAdapter(androidDevice, adb);

      const result = await adapter.setTimeZone("Asia/Tokyo");

      expect(result.error).toContain("Time zone change outcome is indeterminate");
      expect(result.error).toContain('"Asia/Tokyo" was sent');
      expect(result.error).toContain('previously "America/Chicago"');
      expect(result.error).toContain("Do not retry automatically");
      expect(result.error).toContain(
        "Failed to set time zone: write denied; cmd alarm set-timezone: alarm busy.",
      );
    });

    it("returns the previous time zone when read-back confirms the change", async () => {
      const adb = new FakeAdbClient();
      const responses = ["America/New_York", "Asia/Tokyo"];
      const original = adb.executeCommand.bind(adb);
      adb.executeCommand = (async (command: string, ...rest: any[]) => {
        if (command === "shell getprop persist.sys.timezone") {
          return {
            stdout: responses.shift() ?? "Asia/Tokyo",
            stderr: "",
            toString: () => "",
            trim: () => "",
            includes: () => false,
          };
        }
        return original(command, ...rest);
      }) as any;
      const adapter = new AndroidSystemConfigurationAdapter(androidDevice, adb as any);
      const result = await adapter.setTimeZone("Asia/Tokyo");
      expect(result.success).toBe(true);
      expect(result.previousZoneId).toBe("America/New_York");
    });

    it("returns false when the time-zone read-back does not match (silent no-op)", async () => {
      const adb = new FakeAdbClient();
      // setprop is silently ignored (e.g. non-root adbd): getprop still returns the old value.
      adb.setCommandResult("shell getprop persist.sys.timezone", "America/New_York");
      const adapter = new AndroidSystemConfigurationAdapter(androidDevice, adb as any);
      const result = await adapter.setTimeZone("Asia/Tokyo");

      expect(result.success).toBe(false);
      expect(result.zoneId).toBe("Asia/Tokyo");
      expect(result.error).toBe(
        'Read-back verification failed: expected "Asia/Tokyo" but got "America/New_York"',
      );
    });

    it("reports an unreadable time-zone read-back as indeterminate, not as not applied", async () => {
      const adb = new FakeAdbClient();
      const adapter = new AndroidSystemConfigurationAdapter(androidDevice, adb as any);
      const result = await adapter.setTimeZone("Asia/Tokyo");

      expect(result.success).toBe(false);
      expect(result.error).toContain("Time zone change outcome is indeterminate");
    });

    it("surfaces setprop failures for time-zone changes", async () => {
      const adb = new FakeAdbClient();
      adb.setCommandError(
        "shell setprop persist.sys.timezone 'Asia/Tokyo'",
        new Error("device offline"),
      );
      adb.setCommandResult("shell getprop persist.sys.timezone", "America/Chicago");
      adb.setCommandError("shell cmd alarm set-timezone 'Asia/Tokyo'", new Error("alarm offline"));
      const adapter = new AndroidSystemConfigurationAdapter(androidDevice, adb as any);
      const result = await adapter.setTimeZone("Asia/Tokyo");

      expect(result.success).toBe(false);
      expect(result.error).toBe(
        'Read-back verification failed: expected "Asia/Tokyo" but got "America/Chicago" Failed to set time zone: device offline; cmd alarm set-timezone: alarm offline.',
      );
    });

    it("shell-quotes the time-zone id to avoid injection", async () => {
      const adb = new FakeAdbClient();
      adb.setCommandResult("shell getprop persist.sys.timezone", "Asia/Tokyo");
      const adapter = new AndroidSystemConfigurationAdapter(androidDevice, adb as any);
      await adapter.setTimeZone("Asia/Tokyo");
      expect(adb.wasCommandExecuted("setprop persist.sys.timezone 'Asia/Tokyo'")).toBe(true);
      expect(adb.wasCommandExecuted("setprop persist.sys.timezone Asia/Tokyo;")).toBe(false);
    });
  });

  describe("IosSystemConfigurationAdapter behavior", () => {
    let warn: Mock<typeof logger.warn>;
    beforeEach(() => {
      warn = spyOn(logger, "warn").mockImplementation(() => {});
    });
    afterEach(() => warn.mockRestore());

    it("logs simulator write failures and preserves each typed failure", async () => {
      const error = new Error("defaults write failed");
      const exec = new FakeProcessExecutor();
      exec.setCommandHandler("defaults write", () => {
        throw error;
      });
      const adapter = new IosSystemConfigurationAdapter(iosSimulator, exec);
      const cases = [
        {
          run: () => adapter.setLocale("ja-JP", {}),
          field: { languageTag: "ja-JP" },
          message: "Failed to set locale",
        },
        {
          run: () => adapter.setTimeZone("Asia/Tokyo"),
          field: { zoneId: "Asia/Tokyo" },
          message: "Failed to set time zone",
        },
        {
          run: () => adapter.set24HourFormat(true),
          field: { enabled: true },
          message: "Failed to set 24-hour format",
        },
        {
          run: () => adapter.setCalendarSystem("japanese"),
          field: { calendarSystem: "japanese" },
          message: "Failed to set calendar system",
        },
      ];
      for (const { run, field, message } of cases) {
        warn.mockClear();
        expect(await run()).toEqual({
          success: false,
          ...field,
          error: `${message}: defaults write failed`,
        });
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith(`${message}: defaults write failed`, error);
      }
    });

    it("rejects physical iOS system configuration without executing commands", async () => {
      const exec = new FakeProcessExecutor();
      const adapter = new IosSystemConfigurationAdapter(iosPhysical, exec);

      await expect(adapter.setLocale("ja-JP", {})).resolves.toMatchObject({
        success: false,
        error: "System configuration is not supported on physical iOS devices.",
      });
      await expect(adapter.getLocalizationSettings()).resolves.toMatchObject({
        success: false,
        error: "System configuration is not supported on physical iOS devices.",
      });
      await expect(adapter.getCalendarSystem()).resolves.toMatchObject({
        success: false,
        error: "System configuration is not supported on physical iOS devices.",
      });
      expect(exec.getExecutedCommands()).toHaveLength(0);
    });

    it("rejects time-zone changes on physical devices", async () => {
      const adapter = new IosSystemConfigurationAdapter(iosPhysical, new FakeProcessExecutor());
      const result = await adapter.setTimeZone("Asia/Tokyo");
      expect(result.success).toBe(false);
      expect(result.error).toBe("System configuration is not supported on physical iOS devices.");
    });

    it("rejects 24-hour format changes on physical devices with a capability-specific error", async () => {
      const adapter = new IosSystemConfigurationAdapter(iosPhysical, new FakeProcessExecutor());
      const result = await adapter.set24HourFormat(true);
      expect(result.success).toBe(false);
      expect(result.error).toBe("System configuration is not supported on physical iOS devices.");
    });

    it("rejects calendar changes on physical devices with a capability-specific error", async () => {
      const adapter = new IosSystemConfigurationAdapter(iosPhysical, new FakeProcessExecutor());
      const result = await adapter.setCalendarSystem("japanese");
      expect(result.success).toBe(false);
      expect(result.error).toBe("System configuration is not supported on physical iOS devices.");
    });

    it("setTextDirection returns the iOS-specific error regardless of simulator state", async () => {
      const adapter = new IosSystemConfigurationAdapter(iosSimulator, new FakeProcessExecutor());
      const result = await adapter.setTextDirection(true, {});
      expect(result.success).toBe(false);
      expect(result.rtl).toBe(true);
      expect(result.error).toContain("Text direction is not supported on iOS");
    });

    it("broadcastLocaleChange is a no-op on iOS (returns false)", async () => {
      const adapter = new IosSystemConfigurationAdapter(iosSimulator, new FakeProcessExecutor());
      expect(await adapter.broadcastLocaleChange()).toBe(false);
    });

    it("writes AppleLocale via xcrun simctl spawn defaults", async () => {
      const exec = new FakeProcessExecutor();
      exec.setCommandResponse(
        "defaults read .GlobalPreferences AppleLocale",
        execResult("ja_JP\n"),
      );
      const adapter = new IosSystemConfigurationAdapter(iosSimulator, exec);
      const result = await adapter.setLocale("ja-JP", {});

      expect(result.success).toBe(true);
      expect(
        exec.wasCommandExecuted(
          `xcrun simctl spawn ${iosSimulator.deviceId} defaults write .GlobalPreferences AppleLocale ja_JP`,
        ),
      ).toBe(true);
    });
  });

  describe("createSystemConfigurationAdapter factory", () => {
    it("returns an AndroidSystemConfigurationAdapter for Android devices", () => {
      const adapter = createSystemConfigurationAdapter(
        androidDevice,
        new FakeAdbClient() as any,
        new FakeProcessExecutor(),
      );
      expect(adapter).toBeInstanceOf(AndroidSystemConfigurationAdapter);
    });

    it("returns an IosSystemConfigurationAdapter for iOS devices", () => {
      const adapter = createSystemConfigurationAdapter(
        iosSimulator,
        new FakeAdbClient() as any,
        new FakeProcessExecutor(),
      );
      expect(adapter).toBeInstanceOf(IosSystemConfigurationAdapter);
    });
  });
});
