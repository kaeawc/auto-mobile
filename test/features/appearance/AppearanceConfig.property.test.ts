import { describe, test } from "bun:test";
import fc from "fast-check";
import type { AppearanceConfig, AppearanceConfigInput } from "../../../src/models";
import {
  DEFAULT_APPEARANCE_CONFIG,
  parseAppearanceConfig,
} from "../../../src/features/appearance/AppearanceConfig";

// Property-based tests. See test/utils/Backoff.property.test.ts for the pinned-seed rationale.
const RUN_OPTIONS = { seed: 1_234_567, numRuns: 300 } as const;

const MODES = ["light", "dark", "auto"] as const;
const eq = (a: AppearanceConfig, b: AppearanceConfig): boolean =>
  a.syncWithHost === b.syncWithHost &&
  a.defaultMode === b.defaultMode &&
  a.applyOnConnect === b.applyOnConnect;

const modeInput = fc.option(fc.oneof(fc.constantFrom(...MODES), fc.string({ maxLength: 6 })), {
  nil: undefined,
});
const boolInput = fc.option(fc.boolean(), { nil: undefined });
const appearanceInput: fc.Arbitrary<AppearanceConfigInput> = fc.record(
  { defaultMode: modeInput, syncWithHost: boolInput, applyOnConnect: boolInput },
  { requiredKeys: [] },
);

describe("parseAppearanceConfig (property-based)", () => {
  test("always returns a full config with a valid mode and boolean flags", () => {
    fc.assert(
      fc.property(appearanceInput, (input) => {
        const c = parseAppearanceConfig(input);
        return (
          (MODES as readonly string[]).includes(c.defaultMode) &&
          typeof c.syncWithHost === "boolean" &&
          typeof c.applyOnConnect === "boolean"
        );
      }),
      RUN_OPTIONS,
    );
  });

  test("nullish input falls back to the default config", () => {
    fc.assert(
      fc.property(fc.constantFrom(null, undefined), (input) =>
        eq(parseAppearanceConfig(input), DEFAULT_APPEARANCE_CONFIG),
      ),
      RUN_OPTIONS,
    );
  });

  test("a valid mode is accepted under any casing and surrounding whitespace", () => {
    const ws = fc.string({ unit: fc.constantFrom(" ", "\t", "\n", "\r"), maxLength: 3 });
    const mixedCase = (w: string): fc.Arbitrary<string> =>
      fc.array(fc.boolean(), { minLength: w.length, maxLength: w.length }).map((bits) =>
        w
          .split("")
          .map((ch, i) => (bits[i] ? ch.toUpperCase() : ch))
          .join(""),
      );
    // Arbitrary casing (e.g. "LiGhT") wrapped in arbitrary trimmable whitespace.
    const cased = fc.constantFrom(...MODES).chain((m) =>
      fc.record({
        expected: fc.constant(m),
        value: fc.tuple(ws, mixedCase(m), ws).map(([a, b, c]) => `${a}${b}${c}`),
      }),
    );
    fc.assert(
      fc.property(
        cased,
        ({ expected, value }) =>
          parseAppearanceConfig({ defaultMode: value }).defaultMode === expected,
      ),
      RUN_OPTIONS,
    );
  });

  test("an unrecognized mode string falls back to the default mode", () => {
    const invalid = fc
      .string({ maxLength: 8 })
      .filter((s) => !(MODES as readonly string[]).includes(s.trim().toLowerCase()));
    fc.assert(
      fc.property(
        invalid,
        (s) =>
          parseAppearanceConfig({ defaultMode: s }).defaultMode ===
          DEFAULT_APPEARANCE_CONFIG.defaultMode,
      ),
      RUN_OPTIONS,
    );
  });

  test("boolean flags pass through, and an absent flag takes the default", () => {
    fc.assert(
      fc.property(fc.boolean(), fc.boolean(), (sync, apply) => {
        const provided = parseAppearanceConfig({ syncWithHost: sync, applyOnConnect: apply });
        const absent = parseAppearanceConfig({});
        return (
          provided.syncWithHost === sync &&
          provided.applyOnConnect === apply &&
          absent.syncWithHost === DEFAULT_APPEARANCE_CONFIG.syncWithHost &&
          absent.applyOnConnect === DEFAULT_APPEARANCE_CONFIG.applyOnConnect
        );
      }),
      RUN_OPTIONS,
    );
  });

  test("is idempotent — re-parsing a parsed config is a fixed point", () => {
    fc.assert(
      fc.property(appearanceInput, (input) => {
        const once = parseAppearanceConfig(input);
        return eq(parseAppearanceConfig(once), once);
      }),
      RUN_OPTIONS,
    );
  });
});
