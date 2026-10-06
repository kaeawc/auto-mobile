import { beforeEach, describe, expect, it } from "bun:test";
import { AndroidSystemConfigurationAdapter } from "../../../src/features/utility/system-configuration/AndroidSystemConfigurationAdapter";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../fakes/FakeTimer";
import type { BootedDevice, ExecResult } from "../../../src/models";
import {
  LOCALE_CAPTURE_APP_ID,
  LOCALE_CAPTURE_MISSING_APP_ID,
  readLocaleCapture,
  readMissingPackageCapture,
  type LocaleCaptureName,
} from "../../helpers/androidLocaleCapture";

/**
 * Issue #10155: a locale change that is reported as failed must not leave the
 * rejected locale applied on the device. Layer 1 rejects a tag that cannot be a
 * real locale before anything is sent; layer 2 restores the earlier locale when
 * a tag that passed validation does not read back.
 *
 * Device replies come from the API 36 captures in test/fixtures/android-locale/
 * (see test/helpers/androidLocaleCapture.ts), against the capture's own package.
 * The two places that still use a hand-built reply say so: the multi-locale list
 * and the ICU / tag-shape acceptance sweeps were never captured. The legacy
 * device-wide path keeps its own strings (`persist.sys.locale` was empty in every
 * capture, so that path was not exercised).
 */
describe("Android changeLocalization rejected locale (#10155)", () => {
  const device: BootedDevice = { deviceId: "emulator-5554", name: "Pixel 7", platform: "android" };
  const APP = LOCALE_CAPTURE_APP_ID;
  const GET_APP = `cmd locale get-app-locales '${APP}' --user 0`;
  const SET_APP = `cmd locale set-app-locales '${APP}' --user 0`;

  const result = (stdout: string): ExecResult => ({
    stdout,
    stderr: "",
    toString: () => stdout,
    trim: () => stdout.trim(),
    includes: (s: string) => stdout.includes(s),
  });
  /** What the device printed for `get-app-locales <pkg> --user 0` in a capture. */
  const captured = (name: LocaleCaptureName): ExecResult =>
    result(readLocaleCapture(name).appLocalesUser0);
  // Not captured: the comma-joined multi-locale list. Android's LocaleList joins with a comma, but
  // no capture holds a two-locale app override, so this reply is hand-built.
  const uncapturedMultiLocale = (list: string): ExecResult =>
    result(`Locales for ${APP} for user 0 are [${list}]\n`);
  // A reply with nothing to parse: the case where the read-back cannot be understood.
  const emptyReply = (): ExecResult => result("");

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
      adb.setCommandResponseSequence(GET_APP, [
        captured("0-initial"),
        captured("3-zz-ZZ"),
        captured("12-restored"),
      ]);

      const outcome = await adapter.setLocale("fr-FR", { broadcast: false, appId: APP });

      expect(outcome.success).toBe(false);
      expect(outcome.error).toBe(
        `Read-back verification failed for ${APP}: expected "fr-FR" but got "zz-ZZ". Restored the app's previous locale (unset).`,
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
        uncapturedMultiLocale("en-US,de-DE"),
        captured("3-zz-ZZ"),
        uncapturedMultiLocale("en-US,de-DE"),
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
      adb.setCommandResponseSequence(GET_APP, [captured("6-he-IL"), captured("3-zz-ZZ")]);
      adb.setCommandError(`--locales 'he-IL'`, new Error("device offline"));

      const outcome = await adapter.setLocale("fr-FR", { broadcast: false, appId: APP });

      expect(outcome.success).toBe(false);
      expect(outcome.error).toBe(
        `Read-back verification failed for ${APP}: expected "fr-FR" but got "zz-ZZ". ` +
          `Restoring the app's previous locale ("he-IL") failed (device offline); the app's locale is left as "zz-ZZ".`,
      );
    });

    it("names the left-over state when the restore does not read back", async () => {
      adb.setCommandResponseSequence(GET_APP, [captured("6-he-IL"), captured("3-zz-ZZ")]);

      const outcome = await adapter.setLocale("fr-FR", { broadcast: false, appId: APP });

      expect(outcome.success).toBe(false);
      expect(outcome.error).toContain(
        `Restoring the app's previous locale ("he-IL") failed; the app's locale is left as "zz-ZZ".`,
      );
      expect(setCommands()).toHaveLength(2);
    });

    it("does not restore when the device still reports the previous locale", async () => {
      adb.setCommandResponseSequence(GET_APP, [captured("6-he-IL")]);

      const outcome = await adapter.setLocale("fr-FR", { broadcast: false, appId: APP });

      expect(outcome.success).toBe(false);
      expect(outcome.error).toBe(
        `Read-back verification failed for ${APP}: expected "fr-FR" but got "he-IL"`,
      );
      expect(setCommands()).toEqual([`shell ${SET_APP} --locales 'fr-FR'`]);
    });

    it("does not guess a restore when the previous locale could not be read", async () => {
      adb.setCommandResponseSequence(GET_APP, [emptyReply(), captured("3-zz-ZZ")]);

      const outcome = await adapter.setLocale("fr-FR", { broadcast: false, appId: APP });

      expect(outcome.success).toBe(false);
      expect(outcome.error).toContain(
        `previous locale could not be read before the change, so it was not restored; the app's locale is now "zz-ZZ".`,
      );
      expect(setCommands()).toEqual([`shell ${SET_APP} --locales 'fr-FR'`]);
    });
  });

  describe("unreadable read-back is indeterminate, not a failed apply", () => {
    it("does not restore the app locale when the read-back cannot be parsed", async () => {
      adb.setCommandResponseSequence(GET_APP, [captured("6-he-IL"), emptyReply()]);

      const outcome = await adapter.setLocale("fr-FR", { broadcast: false, appId: APP });

      expect(outcome.success).toBe(false);
      expect(outcome.error).toContain("Locale change outcome is indeterminate");
      expect(outcome.error).toContain(`"fr-FR" was sent`);
      expect(outcome.error).toContain('previously "he-IL"');
      expect(outcome.error).toContain("Do not retry automatically");
      expect(setCommands()).toEqual([`shell ${SET_APP} --locales 'fr-FR'`]);
      expect(adb.wasCommandExecuted("am broadcast")).toBe(false);
    });

    it("treats a readable but different app locale as not applied and restores", async () => {
      adb.setCommandResponseSequence(GET_APP, [
        captured("6-he-IL"),
        captured("3-zz-ZZ"),
        captured("6-he-IL"),
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
    // [requested, capture taken after sending it]: the device's own read-back.
    const capturedCases: ReadonlyArray<readonly [string, LocaleCaptureName]> = [
      ["he", "1-he"],
      ["iw", "2-iw"],
      ["zz-ZZ", "3-zz-ZZ"],
      ["he-IL", "6-he-IL"],
      ["fr-FR", "7-fr-FR"],
      ["in-ID", "11-in-ID"],
    ];
    for (const [requested, capture] of capturedCases) {
      it(`app path: request ${requested} read back as the device printed it (${capture}) is applied`, async () => {
        adb.setCommandResponseSequence(GET_APP, [captured("0-initial"), captured(capture)]);

        const outcome = await adapter.setLocale(requested, { broadcast: false, appId: APP });

        expect(outcome.success).toBe(true);
        expect(setCommands()).toEqual([`shell ${SET_APP} --locales '${requested}'`]);
      });
    }

    // Legacy device-wide path: `persist.sys.locale` was empty in every capture, so these pairs are
    // not device-observed and keep their original strings.
    const legacyCases: ReadonlyArray<readonly [requested: string, reported: string]> = [
      ["iw", "he"],
      ["in-ID", "id-ID"],
      ["ji", "yi"],
      ["he", "he-IL"],
      ["zh-TW", "zh-Hant-TW"],
      ["fr-FR", "fr-fr"],
    ];
    for (const [requested, reported] of legacyCases) {
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

    it("restores when the device keeps only the language of a request that named a region", async () => {
      // The device printed [he] after a he request; a he-IL request that reads back [he]
      // dropped the region and is not applied.
      adb.setCommandResponseSequence(GET_APP, [
        captured("0-initial"),
        captured("1-he"),
        captured("0-initial"),
      ]);

      const outcome = await adapter.setLocale("he-IL", { broadcast: false, appId: APP });

      expect(outcome.success).toBe(false);
      expect(outcome.error).toContain("Restored the app's previous locale (unset)");
    });
  });

  describe("an app that is not installed (#10211)", () => {
    const missing = readMissingPackageCapture();
    const MISSING = LOCALE_CAPTURE_MISSING_APP_ID;
    const GET_MISSING = `cmd locale get-app-locales '${MISSING}' --user 0`;
    const SET_MISSING = `cmd locale set-app-locales '${MISSING}' --user 0`;
    const notInstalled = (): ExecResult => result(missing.getAppLocalesUser0.output);
    const NOT_INSTALLED_ERROR = `Cannot change the locale: app ${MISSING} is not installed for user 0; nothing was changed. Check the appId, or install the app first.`;

    it("the captured replies are the Unknown package line, and the command exits 0", () => {
      for (const reply of [
        missing.getAppLocales,
        missing.setAppLocales,
        missing.getAppLocalesUser0,
      ]) {
        expect(reply.output).toBe(`Unknown package ${MISSING} for userId 0\n`);
        expect(reply.exitCode).toBe(0);
      }
    });

    it("fails definitively on the read before the write and sends nothing", async () => {
      adb.setCommandResponse(GET_MISSING, notInstalled());

      const outcome = await adapter.setLocale("fr-FR", { broadcast: false, appId: MISSING });

      expect(outcome.success).toBe(false);
      expect(outcome.error).toBe(NOT_INSTALLED_ERROR);
      expect(outcome.error).not.toContain("indeterminate");
      expect(outcome.error).not.toContain("may have changed");
      expect(outcome.previousLanguageTag).toBeNull();
      expect(setCommands()).toEqual([]);
      expect(adb.wasCommandExecuted("am broadcast")).toBe(false);
      // One read, no retry, no restore probe.
      expect(adb.getExecutedCommands().filter((c) => c.includes("get-app-locales"))).toEqual([
        `shell ${GET_MISSING}`,
      ]);
    });

    it("fails definitively when only the set reports the unknown package", async () => {
      // The pre-write read could not be understood, then the set itself names the package unknown.
      adb.setCommandResponse(GET_MISSING, emptyReply());
      adb.setCommandResponse(SET_MISSING, result(missing.setAppLocales.output));

      const outcome = await adapter.setLocale("fr-FR", { broadcast: false, appId: MISSING });

      expect(outcome.success).toBe(false);
      expect(outcome.error).toBe(NOT_INSTALLED_ERROR);
      expect(setCommands()).toEqual([`shell ${SET_MISSING} --locales 'fr-FR'`]);
      expect(adb.wasCommandExecuted("am broadcast")).toBe(false);
    });

    it("fails definitively, without a restore, when only the read-back reports the unknown package", async () => {
      adb.setCommandResponseSequence(GET_MISSING, [captured("6-he-IL"), notInstalled()]);

      const outcome = await adapter.setLocale("fr-FR", { broadcast: false, appId: MISSING });

      expect(outcome.success).toBe(false);
      expect(outcome.error).toBe(NOT_INSTALLED_ERROR);
      expect(setCommands()).toEqual([`shell ${SET_MISSING} --locales 'fr-FR'`]);
    });

    it("classifies the unknown package from stderr as well as stdout", async () => {
      adb.setCommandResponse(GET_MISSING, {
        ...result(""),
        stderr: missing.getAppLocalesUser0.output,
      });

      const outcome = await adapter.setLocale("fr-FR", { broadcast: false, appId: MISSING });

      expect(outcome.error).toBe(NOT_INSTALLED_ERROR);
      expect(setCommands()).toEqual([]);
    });

    it("keeps an installed app's success path at exactly one read, one write and one read-back", async () => {
      adb.setCommandResponseSequence(GET_APP, [captured("0-initial"), captured("7-fr-FR")]);

      const outcome = await adapter.setLocale("fr-FR", { broadcast: false, appId: APP });

      expect(outcome.success).toBe(true);
      expect(adb.getExecutedCommands().filter((c) => /locale/.test(c))).toEqual([
        `shell ${GET_APP}`,
        `shell ${SET_APP} --locales 'fr-FR'`,
        `shell ${GET_APP}`,
      ]);
    });
  });

  describe("success path", () => {
    it("sends exactly the same commands as before", async () => {
      adb.setCommandResponseSequence(GET_APP, [captured("0-initial"), captured("7-fr-FR")]);

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

    // The two sweeps below assert that validation lets a tag through and what is sent. Their
    // read-back echoes the tag because no capture holds a device reply for these tags (not
    // device-observed); the replies are hand-built.
    const echoed = (tag: string): ExecResult =>
      result(`Locales for ${APP} for user 0 are [${tag}]\n`);

    it("sends real languages the runtime's ICU has no display name for and lets the device judge", async () => {
      for (const tag of ["apc-SY", "lld-IT", "mhn-IT", "skr-PK"]) {
        adb.clearHistory();
        adb.setCommandResponseSequence(GET_APP, [captured("0-initial"), echoed(tag)]);

        const outcome = await adapter.setLocale(tag, { broadcast: false, appId: APP });

        expect(outcome.success).toBe(true);
        expect(setCommands()).toEqual([`shell ${SET_APP} --locales '${tag}'`]);
      }
    });

    it("accepts the tag shapes the issue calls out", async () => {
      for (const tag of ["fr-FR", "sr-Latn-RS", "zh-Hant-TW", "en_US", "fil"]) {
        adb.clearHistory();
        adb.setCommandResponseSequence(GET_APP, [captured("0-initial"), echoed(tag)]);

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
