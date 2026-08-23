import { describe, test } from "bun:test";
import fc from "fast-check";
import {
  buildAppleLanguages,
  iosSpawnCommand,
  parseAppleTimeFormatRaw,
} from "../../../../src/features/utility/system-configuration/iosHelpers";

// Property-based tests. See test/utils/Backoff.property.test.ts for the pinned-seed rationale.
const RUN_OPTIONS = { seed: 1_234_567, numRuns: 300 } as const;

// Realistic BCP-47-ish tags: 1-4 non-empty letter segments joined by "-".
const segment = fc.string({
  unit: fc.constantFrom("e", "n", "z", "H", "a", "C", "U", "S"),
  minLength: 1,
  maxLength: 4,
});
const languageTag = fc
  .array(segment, { minLength: 1, maxLength: 4 })
  .map((parts) => parts.join("-"));

describe("buildAppleLanguages (property-based)", () => {
  test("the first entry is always the full input tag", () => {
    fc.assert(
      fc.property(languageTag, (tag) => buildAppleLanguages(tag)[0] === tag),
      RUN_OPTIONS,
    );
  });

  test("contains no duplicate entries", () => {
    fc.assert(
      fc.property(languageTag, (tag) => {
        const chain = buildAppleLanguages(tag);
        return new Set(chain).size === chain.length;
      }),
      RUN_OPTIONS,
    );
  });

  test("every entry is a hyphen-segment prefix of the tag", () => {
    fc.assert(
      fc.property(languageTag, (tag) => {
        const parts = tag.split("-");
        const prefixes = new Set(parts.map((_, i) => parts.slice(0, i + 1).join("-")));
        return buildAppleLanguages(tag).every(
          (entry) => prefixes.has(entry) && tag.startsWith(entry),
        );
      }),
      RUN_OPTIONS,
    );
  });

  test("entries strictly narrow — segment count decreases down the chain", () => {
    fc.assert(
      fc.property(languageTag, (tag) => {
        const counts = buildAppleLanguages(tag).map((e) => e.split("-").length);
        return counts.every((c, i) => i === 0 || counts[i - 1] > c);
      }),
      RUN_OPTIONS,
    );
  });

  test("a fully-distinct-segment tag yields one entry per segment", () => {
    fc.assert(
      fc.property(languageTag, (tag) => buildAppleLanguages(tag).length === tag.split("-").length),
      RUN_OPTIONS,
    );
  });
});

describe("parseAppleTimeFormatRaw (property-based)", () => {
  test('maps "1"->"24" and "0"->"12"', () => {
    fc.assert(
      fc.property(
        fc.constant(null),
        () => parseAppleTimeFormatRaw("1") === "24" && parseAppleTimeFormatRaw("0") === "12",
      ),
      RUN_OPTIONS,
    );
  });

  test("passes any other value (including null) through unchanged", () => {
    const other = fc.option(
      fc.string({ maxLength: 6 }).filter((s) => s !== "1" && s !== "0"),
      { nil: null },
    );
    fc.assert(
      fc.property(other, (raw) => parseAppleTimeFormatRaw(raw) === raw),
      RUN_OPTIONS,
    );
  });

  test("is idempotent", () => {
    const anyRaw = fc.option(fc.string({ maxLength: 6 }), { nil: null });
    fc.assert(
      fc.property(
        anyRaw,
        (raw) =>
          parseAppleTimeFormatRaw(parseAppleTimeFormatRaw(raw)) === parseAppleTimeFormatRaw(raw),
      ),
      RUN_OPTIONS,
    );
  });
});

describe("iosSpawnCommand (property-based)", () => {
  test("composes `xcrun simctl spawn <udid> <command>` verbatim", () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 40 }),
        fc.string({ maxLength: 40 }),
        (deviceId, command) => {
          const line = iosSpawnCommand(deviceId, command);
          return (
            line === `xcrun simctl spawn ${deviceId} ${command}` &&
            line.startsWith("xcrun simctl spawn ")
          );
        },
      ),
      RUN_OPTIONS,
    );
  });
});
