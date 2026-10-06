import { describe, expect, it } from "bun:test";
import {
  localeTagsEquivalent,
  parseAppLocalesReply,
  parseLocaleList,
  validateLocaleTag,
} from "../../../src/features/utility/system-configuration/parsing";
import {
  LOCALE_CAPTURE_APP_ID,
  LOCALE_CAPTURE_MISSING_APP_ID,
  parseLocaleCapture,
  readLocaleCapture,
  readMissingPackageCapture,
  type LocaleCaptureName,
} from "../../helpers/androidLocaleCapture";

/**
 * What the device printed (API 36 emulator, test/fixtures/android-locale/) versus what the
 * adapter's parser and canonical comparison assume. Every device string here is loaded verbatim
 * from a capture file. The captures cover the app-locale path only: `persist.sys.locale` is empty
 * in all of them, so nothing here says anything about the legacy device-wide path.
 */
describe("Android app-locale captures", () => {
  // [capture, list inside the brackets]. The step name is the request sent just before the capture;
  // the malformed / over-long / x-private / und requests were rejected before sending, so the
  // device still reports the previous app locale.
  const lists: ReadonlyArray<readonly [LocaleCaptureName, string]> = [
    ["0-initial", ""],
    ["1-he", "he"],
    ["2-iw", "he"],
    ["3-zz-ZZ", "zz-ZZ"],
    ["4-malformed-not_a_locale", "zz-ZZ"],
    ["5-malformed-double-hyphen", "zz-ZZ"],
    ["6-he-IL", "he-IL"],
    ["7-fr-FR", "fr-FR"],
    ["8-overlong-subtags", "fr-FR"],
    ["9-x-private", "fr-FR"],
    ["10-und", "fr-FR"],
    ["11-in-ID", "id-ID"],
    ["12-restored", ""],
  ];

  describe("get-app-locales line format", () => {
    for (const [capture, list] of lists) {
      it(`${capture}: parses to [${list}] with and without --user 0`, () => {
        const { appLocales, appLocalesUser0 } = readLocaleCapture(capture);

        expect(appLocalesUser0).toBe(
          `Locales for ${LOCALE_CAPTURE_APP_ID} for user 0 are [${list}]\n`,
        );
        expect(appLocales).toBe(appLocalesUser0);
        expect(parseAppLocalesReply(appLocalesUser0)).toEqual({ kind: "list", list });
      });
    }

    it("reads an override-free app as an empty list, which has no first locale", () => {
      const reply = parseAppLocalesReply(readLocaleCapture("0-initial").appLocalesUser0);

      expect(reply).toEqual({ kind: "list", list: "" });
      expect(parseLocaleList("")).toBeNull();
    });

    it("reads the first locale of a captured list", () => {
      expect(parseLocaleList("he-IL")).toBe("he-IL");
    });

    it("does not print a device-wide locale in any capture (the legacy path was not exercised)", () => {
      for (const [capture] of lists) {
        expect(readLocaleCapture(capture).persistSysLocale.trim()).toBe("");
      }
    });
  });

  describe("an app that is not installed", () => {
    const missing = readMissingPackageCapture();

    it("is the same Unknown package line for get, set and get --user 0, with exit code 0", () => {
      for (const reply of [
        missing.getAppLocales,
        missing.setAppLocales,
        missing.getAppLocalesUser0,
      ]) {
        expect(reply.output).toBe(
          `Unknown package ${LOCALE_CAPTURE_MISSING_APP_ID} for userId 0\n`,
        );
        expect(reply.exitCode).toBe(0);
        expect(parseAppLocalesReply(reply.output)).toEqual({ kind: "notInstalled" });
        expect(parseAppLocalesReply("", reply.output)).toEqual({ kind: "notInstalled" });
      }
    });

    it("keeps the command text apart from the device output when parsing a transcript", () => {
      const commands = parseLocaleCapture(
        "$ adb -s emulator-5600 shell cmd locale get-app-locales a.b; echo exit=$?\nUnknown package a.b for userId 0\nexit=0\n",
      );

      expect(commands).toEqual([
        {
          command: "cmd locale get-app-locales a.b",
          output: "Unknown package a.b for userId 0\n",
          exitCode: 0,
        },
      ]);
    });

    it("classifies an empty reply as unreadable, not as not installed", () => {
      expect(parseAppLocalesReply("")).toEqual({ kind: "unreadable" });
      expect(parseAppLocalesReply("", "")).toEqual({ kind: "unreadable" });
    });
  });

  describe("localeTagsEquivalent against the captured read-backs", () => {
    // [requested, capture taken after sending it, equivalent]. The first locale of the capture's list
    // is what the adapter compares.
    const applied: ReadonlyArray<readonly [string, LocaleCaptureName]> = [
      ["he", "1-he"],
      // The legacy spelling `iw` is stored and read back as `he`.
      ["iw", "2-iw"],
      ["zz-ZZ", "3-zz-ZZ"],
      ["he-IL", "6-he-IL"],
      ["fr-FR", "7-fr-FR"],
      // The old Indonesian code `in` is read back as `id`.
      ["in-ID", "11-in-ID"],
    ];
    for (const [requested, capture] of applied) {
      it(`${requested} sent, ${capture} read back: equivalent`, () => {
        const list = readLocaleCapture(capture).appLocalesUser0;
        const reply = parseAppLocalesReply(list);
        expect(reply.kind).toBe("list");
        const reported = reply.kind === "list" ? parseLocaleList(reply.list) : null;

        expect(localeTagsEquivalent(reported, requested)).toBe(true);
      });
    }

    // The device kept the earlier value, so a read-back of it must not satisfy the new request.
    const notApplied: ReadonlyArray<readonly [string, LocaleCaptureName]> = [
      ["fr-FR", "3-zz-ZZ"],
      ["he-IL", "1-he"],
      ["not_a_locale!!", "4-malformed-not_a_locale"],
      ["en--US", "5-malformed-double-hyphen"],
      ["x-foo", "9-x-private"],
      ["und", "10-und"],
      ["fr-FR", "11-in-ID"],
      ["fr-FR", "0-initial"],
      ["fr-FR", "12-restored"],
    ];
    for (const [requested, capture] of notApplied) {
      it(`${requested} sent, ${capture} read back: not equivalent`, () => {
        const reply = parseAppLocalesReply(readLocaleCapture(capture).appLocalesUser0);
        const reported = reply.kind === "list" ? parseLocaleList(reply.list) : null;

        expect(localeTagsEquivalent(reported, requested)).toBe(false);
      });
    }
  });

  describe("validateLocaleTag on the requests the manual test sent", () => {
    // The five rejected requests, with the error text the tool returned on the device.
    const rejected: ReadonlyArray<readonly [string, string]> = [
      [
        "not_a_locale!!",
        'Invalid locale "not_a_locale!!": not a well-formed BCP 47 language tag (e.g. "fr-FR", "sr-Latn-RS" or "zh-Hant-TW").',
      ],
      [
        "en--US",
        'Invalid locale "en--US": not a well-formed BCP 47 language tag (e.g. "fr-FR", "sr-Latn-RS" or "zh-Hant-TW").',
      ],
      [
        "zz-ZZZZZZZZZ-123456789",
        'Invalid locale "zz-ZZZZZZZZZ-123456789": not a well-formed BCP 47 language tag (e.g. "fr-FR", "sr-Latn-RS" or "zh-Hant-TW").',
      ],
      [
        "x-foo",
        'Invalid locale "x-foo": not a well-formed BCP 47 language tag (e.g. "fr-FR", "sr-Latn-RS" or "zh-Hant-TW").',
      ],
      [
        "und",
        'Invalid locale "und": "und" (undetermined) is not a real locale; use a language such as "fr-FR".',
      ],
    ];
    for (const [tag, error] of rejected) {
      it(`rejects ${tag} with the message the device run printed`, () => {
        expect(validateLocaleTag(tag)).toBe(error);
      });
    }

    // Sent, applied and read back by the device.
    for (const tag of ["he", "iw", "zz-ZZ", "he-IL", "fr-FR", "in-ID"]) {
      it(`accepts ${tag}`, () => {
        expect(validateLocaleTag(tag)).toBeNull();
      });
    }
  });
});
