import { describe, test } from "bun:test";
import fc from "fast-check";
import {
  EVENT_ALL_MARKERS_ENV,
  EVENT_ALL_MARKERS_FLAG,
  hasEventAllMarkersCliOverride,
  parseEventAllMarkersConfig,
  splitMarkers,
} from "../../src/utils/eventAllMarkers";

// Property-based tests. See Backoff.property.test.ts for the pinned-seed rationale.
const RUN_OPTIONS = { seed: 1_234_567, numRuns: 300 } as const;

// A marker payload: comma/space separated tokens drawn from realistic marker
// characters, so trimming and empty-dropping are actually exercised.
const markerChar = fc.constantFrom("@", "/", "#", "!", "a", "b", "1", " ", ",");
const markerString = fc.string({ unit: markerChar, maxLength: 30 });

describe("splitMarkers (property-based)", () => {
  test("every entry is non-empty and fully trimmed", () => {
    fc.assert(
      fc.property(markerString, (v) =>
        splitMarkers(v).every((m) => m.length > 0 && m === m.trim()),
      ),
      RUN_OPTIONS,
    );
  });

  test("is idempotent through a comma re-join", () => {
    fc.assert(
      fc.property(markerString, (v) => {
        const once = splitMarkers(v);
        const twice = splitMarkers(once.join(","));
        return once.length === twice.length && once.every((m, i) => m === twice[i]);
      }),
      RUN_OPTIONS,
    );
  });

  test("is insensitive to whitespace around separators", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom("@", "/", "#", "ab"), { minLength: 1, maxLength: 6 }),
        (tokens) => {
          const tight = tokens.join(",");
          const loose = tokens.join(" , ");
          const a = splitMarkers(tight);
          const b = splitMarkers(loose);
          return a.length === b.length && a.every((m, i) => m === b[i]);
        },
      ),
      RUN_OPTIONS,
    );
  });
});

const flag = EVENT_ALL_MARKERS_FLAG;
const nonFlagValue = fc.string({ minLength: 1, maxLength: 12 }).filter((v) => !v.startsWith("--"));

describe("hasEventAllMarkersCliOverride (property-based)", () => {
  test("never throws and returns a boolean for arbitrary argv", () => {
    fc.assert(
      fc.property(
        fc.array(fc.string()),
        (args) => typeof hasEventAllMarkersCliOverride(args) === "boolean",
      ),
      RUN_OPTIONS,
    );
  });

  test("the inline form is detected for any (even empty) value", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 12 }), (value) =>
        hasEventAllMarkersCliOverride([`${flag}=${value}`]),
      ),
      RUN_OPTIONS,
    );
  });

  test("the space-separated form is detected only with a non-flag value", () => {
    fc.assert(
      fc.property(nonFlagValue, (value) => {
        const present = hasEventAllMarkersCliOverride([flag, value]);
        const loneAtEnd = hasEventAllMarkersCliOverride([flag]) === false;
        const followedByFlag = hasEventAllMarkersCliOverride([flag, "--other"]) === false;
        return present && loneAtEnd && followedByFlag;
      }),
      RUN_OPTIONS,
    );
  });

  test("argv without the flag is never an override", () => {
    const positionals = fc.array(
      fc.string({ maxLength: 10 }).map((t) => `p${t}`),
      { maxLength: 8 },
    );
    fc.assert(
      fc.property(positionals, (args) => hasEventAllMarkersCliOverride(args) === false),
      RUN_OPTIONS,
    );
  });
});

describe("parseEventAllMarkersConfig (property-based)", () => {
  test("an unset flag and env resolve to the empty list", () => {
    const positionals = fc.array(
      fc.string({ maxLength: 8 }).map((t) => `p${t}`),
      { maxLength: 6 },
    );
    fc.assert(
      fc.property(positionals, (args) => parseEventAllMarkersConfig(args, {}).length === 0),
      RUN_OPTIONS,
    );
  });

  test("a CLI value wins over the environment and equals splitMarkers", () => {
    fc.assert(
      fc.property(nonFlagValue, markerString, (cliRaw, envRaw) => {
        const result = parseEventAllMarkersConfig([`${flag}=${cliRaw}`], {
          [EVENT_ALL_MARKERS_ENV]: envRaw,
        });
        const expected = splitMarkers(cliRaw);
        return result.length === expected.length && result.every((m, i) => m === expected[i]);
      }),
      RUN_OPTIONS,
    );
  });

  test("with no CLI flag, the env value is used", () => {
    fc.assert(
      fc.property(markerString, (envRaw) => {
        const result = parseEventAllMarkersConfig([], { [EVENT_ALL_MARKERS_ENV]: envRaw });
        const expected = splitMarkers(envRaw);
        return result.length === expected.length && result.every((m, i) => m === expected[i]);
      }),
      RUN_OPTIONS,
    );
  });
});
