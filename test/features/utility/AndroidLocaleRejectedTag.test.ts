import { beforeEach, describe, expect, it } from "bun:test";
import { AndroidSystemConfigurationAdapter } from "../../../src/features/utility/system-configuration/AndroidSystemConfigurationAdapter";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../fakes/FakeTimer";
import type { BootedDevice, ExecResult } from "../../../src/models";

/**
 * Issue #10155: a locale change that is reported as failed must not leave the
 * rejected locale applied on the device. Layer 1 rejects a tag that cannot be a
 * real locale before anything is sent; layer 2 restores the earlier locale when
 * a tag that passed validation does not read back.
 */
describe("Android changeLocalization rejected locale (#10155)", () => {
  const device: BootedDevice = { deviceId: "emulator-5554", name: "Pixel 7", platform: "android" };
  const APP = "com.example.app";
  const GET_APP = `cmd locale get-app-locales '${APP}' --user 0`;
  const SET_APP = `cmd locale set-app-locales '${APP}' --user 0`;

  const result = (stdout: string): ExecResult => ({
    stdout,
    stderr: "",
    toString: () => stdout,
    trim: () => stdout.trim(),
    includes: (s: string) => stdout.includes(s),
  });
  const appLocales = (list: string): ExecResult =>
    result(`Locales for ${APP} for user 0 are [${list}]\n`);

  let adb: FakeAdbExecutor;
  let adapter: AndroidSystemConfigurationAdapter;

  beforeEach(() => {
    adb = new FakeAdbExecutor();
    adb.setAndroidApiLevel(36);
    adb.setCommandResponse("getprop ro.build.version.sdk", result("36"));
    adb.setForegroundApp({ packageName: APP, userId: 0 });
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    adapter = new AndroidSystemConfigurationAdapter(device, adb, timer);
  });

  const setCommands = (): string[] =>
    adb.getExecutedCommands().filter((command) => command.includes("set-app-locales"));

  describe("validation before sending", () => {
    for (const tag of [
      "not_a_locale!!",
      "zz-ZZZZZZZZZ-123456789",
      "und",
      "und-US",
      "x-private",
      "fr-FR,de-DE",
      "qaa",
      "i-klingon",
    ]) {
      it(`rejects ${JSON.stringify(tag)} without sending any command`, async () => {
        const outcome = await adapter.setLocale(tag, { broadcast: false, appId: APP });

        expect(outcome.success).toBe(false);
        expect(outcome.error).toContain(`Invalid locale "${tag}"`);
        expect(adb.getExecutedCommands()).toEqual([]);
      });
    }

    it("rejects an invalid tag on the legacy device-wide path too", async () => {
      adb.setAndroidApiLevel(32);
      adb.setCommandResponse("getprop ro.build.version.sdk", result("32"));

      const outcome = await adapter.setLocale("und", { broadcast: false, appId: APP });

      expect(outcome.success).toBe(false);
      expect(outcome.error).toContain('Invalid locale "und"');
      expect(adb.getExecutedCommands()).toEqual([]);
    });
  });

  describe("restore after a read-back mismatch", () => {
    it("restores an app that had no locale override and says so", async () => {
      adb.setCommandResponseSequence(GET_APP, [appLocales(""), appLocales("und"), appLocales("")]);

      const outcome = await adapter.setLocale("fr-FR", { broadcast: false, appId: APP });

      expect(outcome.success).toBe(false);
      expect(outcome.error).toBe(
        `Read-back verification failed for ${APP}: expected "fr-FR" but got "und". Restored the app's previous locale (unset).`,
      );
      expect(setCommands()).toEqual([
        `shell ${SET_APP} --locales 'fr-FR'`,
        // An empty --locales clears the override: the form the repo's probe
        // script uses (`--locales ""`), quoted so the empty word survives the
        // device shell.
        `shell ${SET_APP} --locales ''`,
      ]);
      expect(adb.wasCommandExecuted("am broadcast")).toBe(false);
    });

    it("restores every previous locale, not just the first", async () => {
      adb.setCommandResponseSequence(GET_APP, [
        appLocales("en-US,de-DE"),
        appLocales("fr"),
        appLocales("en-US,de-DE"),
      ]);

      const outcome = await adapter.setLocale("fr-FR", { broadcast: false, appId: APP });

      expect(outcome.success).toBe(false);
      expect(outcome.previousLanguageTag).toBe("en-US");
      expect(outcome.error).toContain(`Restored the app's previous locale ("en-US,de-DE").`);
      expect(setCommands()).toEqual([
        `shell ${SET_APP} --locales 'fr-FR'`,
        `shell ${SET_APP} --locales 'en-US,de-DE'`,
      ]);
    });

    it("names the left-over state when the restore command fails", async () => {
      adb.setCommandResponseSequence(GET_APP, [appLocales("en-US"), appLocales("und")]);
      adb.setCommandError(`--locales 'en-US'`, new Error("device offline"));

      const outcome = await adapter.setLocale("fr-FR", { broadcast: false, appId: APP });

      expect(outcome.success).toBe(false);
      expect(outcome.error).toBe(
        `Read-back verification failed for ${APP}: expected "fr-FR" but got "und". ` +
          `Restoring the app's previous locale ("en-US") failed (device offline); the app's locale is left as "und".`,
      );
    });

    it("names the left-over state when the restore does not read back", async () => {
      adb.setCommandResponseSequence(GET_APP, [appLocales("en-US"), appLocales("und")]);

      const outcome = await adapter.setLocale("fr-FR", { broadcast: false, appId: APP });

      expect(outcome.success).toBe(false);
      expect(outcome.error).toContain(
        `Restoring the app's previous locale ("en-US") failed; the app's locale is left as "und".`,
      );
      expect(setCommands()).toHaveLength(2);
    });

    it("does not restore when the device still reports the previous locale", async () => {
      adb.setCommandResponseSequence(GET_APP, [appLocales("en-US")]);

      const outcome = await adapter.setLocale("fr-FR", { broadcast: false, appId: APP });

      expect(outcome.success).toBe(false);
      expect(outcome.error).toBe(
        `Read-back verification failed for ${APP}: expected "fr-FR" but got "en-US"`,
      );
      expect(setCommands()).toEqual([`shell ${SET_APP} --locales 'fr-FR'`]);
    });

    it("does not guess a restore when the previous locale could not be read", async () => {
      adb.setCommandResponseSequence(GET_APP, [
        result("Unknown package com.example.app for userId 0\n"),
        appLocales("und"),
      ]);

      const outcome = await adapter.setLocale("fr-FR", { broadcast: false, appId: APP });

      expect(outcome.success).toBe(false);
      expect(outcome.error).toContain(
        `previous locale could not be read before the change, so it was not restored; the app's locale is now "und".`,
      );
      expect(setCommands()).toEqual([`shell ${SET_APP} --locales 'fr-FR'`]);
    });
  });

  describe("unreadable read-back is indeterminate, not a failed apply", () => {
    it("does not restore the app locale when the read-back cannot be parsed", async () => {
      adb.setCommandResponseSequence(GET_APP, [
        appLocales("en-US"),
        result("Unknown package com.example.app for userId 0\n"),
      ]);

      const outcome = await adapter.setLocale("fr-FR", { broadcast: false, appId: APP });

      expect(outcome.success).toBe(false);
      expect(outcome.error).toContain("Locale change outcome is indeterminate");
      expect(outcome.error).toContain(`"fr-FR" was sent`);
      expect(outcome.error).toContain('previously "en-US"');
      expect(outcome.error).toContain("Do not retry automatically");
      expect(setCommands()).toEqual([`shell ${SET_APP} --locales 'fr-FR'`]);
      expect(adb.wasCommandExecuted("am broadcast")).toBe(false);
    });

    it("treats a readable but different app locale as not applied and restores", async () => {
      adb.setCommandResponseSequence(GET_APP, [
        appLocales("en-US"),
        appLocales("de"),
        appLocales("en-US"),
      ]);

      const outcome = await adapter.setLocale("fr-FR", { broadcast: false, appId: APP });

      expect(outcome.error).toContain("Read-back verification failed");
      expect(setCommands()).toHaveLength(2);
    });

    describe("device-wide (legacy) path", () => {
      const PROP = "shell getprop persist.sys.locale";
      const mutating = (): string[] =>
        adb.getExecutedCommands().filter((c) => c.includes("setprop") || c.includes("stop; start"));

      beforeEach(() => {
        adb.setAndroidApiLevel(32);
        adb.setCommandResponse("getprop ro.build.version.sdk", result("32"));
        adb.setCommandResponse("shell id", result("uid=0(root) gid=0(root)\n"));
        adb.setCommandResponse("getprop sys.boot_completed", result("1"));
      });

      it("does not restore (or restart the framework again) when the prop reads back empty", async () => {
        adb.setCommandResponseSequence(PROP, [result("en-US"), result("")]);

        const outcome = await adapter.setLocale("fr-FR", { broadcast: false, appId: APP });

        expect(outcome.success).toBe(false);
        expect(outcome.error).toContain("Locale change outcome is indeterminate");
        expect(outcome.error).toContain("persist.sys.locale could not be read back");
        expect(mutating()).toEqual([
          "shell setprop persist.sys.locale 'fr-FR'",
          "shell stop; start",
        ]);
        expect(adb.wasCommandExecuted("am broadcast")).toBe(false);
      });

      it("says the framework never came back when the read-back is unreadable and boot never completes", async () => {
        adb.setCommandResponse("getprop sys.boot_completed", result("0"));
        adb.setCommandResponseSequence(PROP, [result("en-US"), result("")]);

        const outcome = await adapter.setLocale("fr-FR", { broadcast: false, appId: APP });

        expect(outcome.error).toContain("did not report boot_completed");
        expect(mutating()).toHaveLength(2);
      });

      it("reads the prop back only after boot_completed is reported", async () => {
        adb.setCommandResponseSequence("getprop sys.boot_completed", [
          result("0"),
          result("0"),
          result("1"),
        ]);
        adb.setCommandResponseSequence(PROP, [result("en-US"), result("fr-FR")]);

        const outcome = await adapter.setLocale("fr-FR", { broadcast: false, appId: APP });

        expect(outcome.success).toBe(true);
        const commands = adb.getExecutedCommands();
        const lastBootProbe = commands.lastIndexOf("shell getprop sys.boot_completed");
        const readBack = commands.lastIndexOf(PROP);
        expect(lastBootProbe).toBeGreaterThan(commands.indexOf("shell stop; start"));
        expect(readBack).toBeGreaterThan(lastBootProbe);
      });
    });
  });

  describe("canonical read-back comparison", () => {
    const cases: ReadonlyArray<readonly [requested: string, reported: string]> = [
      ["iw", "he"],
      ["in-ID", "id-ID"],
      ["ji", "yi"],
      ["he", "he-IL"],
      ["zh-TW", "zh-Hant-TW"],
      ["fr-FR", "fr-fr"],
    ];
    for (const [requested, reported] of cases) {
      it(`app path: request ${requested} read back as ${reported} is applied`, async () => {
        adb.setCommandResponseSequence(GET_APP, [appLocales(""), appLocales(reported)]);

        const outcome = await adapter.setLocale(requested, { broadcast: false, appId: APP });

        expect(outcome.success).toBe(true);
        expect(setCommands()).toEqual([`shell ${SET_APP} --locales '${requested}'`]);
      });

      it(`legacy path: request ${requested} read back as ${reported} is applied`, async () => {
        adb.setAndroidApiLevel(32);
        adb.setCommandResponse("getprop ro.build.version.sdk", result("32"));
        adb.setCommandResponse("shell id", result("uid=0(root) gid=0(root)\n"));
        adb.setCommandResponse("getprop sys.boot_completed", result("1"));
        adb.setCommandResponseSequence("shell getprop persist.sys.locale", [
          result(""),
          result(reported),
        ]);

        const outcome = await adapter.setLocale(requested, { broadcast: false, appId: APP });

        expect(outcome.success).toBe(true);
      });
    }

    it("still restores when the device reports a different region than requested", async () => {
      adb.setCommandResponseSequence(GET_APP, [
        appLocales(""),
        appLocales("fr-CA"),
        appLocales(""),
      ]);

      const outcome = await adapter.setLocale("fr-FR", { broadcast: false, appId: APP });

      expect(outcome.success).toBe(false);
      expect(outcome.error).toContain("Restored the app's previous locale (unset)");
    });
  });

  describe("success path", () => {
    it("sends exactly the same commands as before", async () => {
      adb.setCommandResponseSequence(GET_APP, [appLocales(""), appLocales("fr-FR")]);

      const outcome = await adapter.setLocale("fr-FR", { appId: APP });

      expect(outcome).toMatchObject({
        success: true,
        languageTag: "fr-FR",
        previousLanguageTag: null,
        localeScope: "app",
        method: `cmd locale set-app-locales ${APP} --user 0`,
      });
      const commands = adb.getExecutedCommands();
      expect(commands.filter((command) => /locale/i.test(command))).toEqual([
        `shell ${GET_APP}`,
        `shell ${SET_APP} --locales 'fr-FR'`,
        `shell ${GET_APP}`,
        "shell am broadcast -a android.intent.action.LOCALE_CHANGED",
      ]);
    });

    it("sends real languages the runtime's ICU has no display name for and lets the device judge", async () => {
      for (const tag of ["apc-SY", "lld-IT", "mhn-IT", "skr-PK"]) {
        adb.clearHistory();
        adb.setCommandResponseSequence(GET_APP, [appLocales(""), appLocales(tag)]);

        const outcome = await adapter.setLocale(tag, { broadcast: false, appId: APP });

        expect(outcome.success).toBe(true);
        expect(setCommands()).toEqual([`shell ${SET_APP} --locales '${tag}'`]);
      }
    });

    it("accepts the tag shapes the issue calls out", async () => {
      for (const tag of ["fr-FR", "sr-Latn-RS", "zh-Hant-TW", "en_US", "fil"]) {
        adb.clearHistory();
        adb.setCommandResponseSequence(GET_APP, [appLocales(""), appLocales(tag)]);

        const outcome = await adapter.setLocale(tag, { broadcast: false, appId: APP });

        expect(outcome.success).toBe(true);
        expect(setCommands()).toEqual([`shell ${SET_APP} --locales '${tag}'`]);
      }
    });
  });

  describe("device-wide (legacy) path", () => {
    beforeEach(() => {
      adb.setAndroidApiLevel(32);
      adb.setCommandResponse("getprop ro.build.version.sdk", result("32"));
      adb.setCommandResponse("shell id", result("uid=0(root) gid=0(root)\n"));
      adb.setCommandResponse("getprop sys.boot_completed", result("1"));
    });

    const PROP = "shell getprop persist.sys.locale";
    const mutating = (): string[] =>
      adb.getExecutedCommands().filter((c) => c.includes("setprop") || c.includes("stop; start"));

    it("restores the previous persisted locale when the new one does not read back", async () => {
      adb.setCommandResponseSequence(PROP, [result("en-US"), result("und"), result("en-US")]);

      const outcome = await adapter.setLocale("fr-FR", { broadcast: false, appId: APP });

      expect(outcome.success).toBe(false);
      expect(outcome.error).toBe(
        'Read-back verification failed: expected persist.sys.locale "fr-FR" but got "und". Restored the previous device-wide locale ("en-US").',
      );
      expect(mutating()).toEqual([
        "shell setprop persist.sys.locale 'fr-FR'",
        "shell stop; start",
        "shell setprop persist.sys.locale 'en-US'",
        "shell stop; start",
      ]);
    });

    it("clears the prop when no device-wide locale was set before", async () => {
      adb.setCommandResponseSequence(PROP, [result(""), result("und"), result("")]);

      const outcome = await adapter.setLocale("fr-FR", { broadcast: false, appId: APP });

      expect(outcome.error).toContain("Restored the previous device-wide locale (unset).");
      expect(mutating()).toContain("shell setprop persist.sys.locale ''");
    });

    it("names the persisted value the device is left with when the restore fails", async () => {
      adb.setCommandResponseSequence(PROP, [result("en-US"), result("und")]);

      const outcome = await adapter.setLocale("fr-FR", { broadcast: false, appId: APP });

      expect(outcome.success).toBe(false);
      expect(outcome.error).toContain(
        'Restoring the previous device-wide locale ("en-US") failed; persist.sys.locale is left as "und".',
      );
    });

    it("does not restore when the prop still holds the previous value", async () => {
      adb.setCommandResponseSequence(PROP, [result("en-US")]);

      const outcome = await adapter.setLocale("fr-FR", { broadcast: false, appId: APP });

      expect(outcome.error).toBe(
        'Read-back verification failed: expected persist.sys.locale "fr-FR" but got "en-US"',
      );
      expect(mutating()).toEqual(["shell setprop persist.sys.locale 'fr-FR'", "shell stop; start"]);
    });
  });
});
