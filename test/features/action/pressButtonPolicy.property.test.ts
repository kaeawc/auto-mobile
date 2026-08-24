import { describe, test } from "bun:test";
import fc from "fast-check";
import {
  isInPlacePressButton,
  isNavigationPressButton,
  resolveAndroidKeyCode,
} from "../../../src/features/action/pressButtonPolicy";

// Property-based tests. See test/utils/Backoff.property.test.ts for the pinned-seed rationale.
const RUN_OPTIONS = { seed: 1_234_567, numRuns: 300 } as const;

const NAV_BUTTONS = ["back", "home", "recent", "power"] as const;
const IN_PLACE_BUTTONS = ["menu", "volume_up", "volume_down"] as const;
const ALL_BUTTONS = [...NAV_BUTTONS, ...IN_PLACE_BUTTONS];
const KEY_CODES = new Set([3, 4, 82, 26, 24, 25, 187]);
// EVERY Object.prototype member a naive `{}` map could leak (issue #4187) —
// derived from the runtime so a future normal-object + denylist regression that
// omits one (e.g. __defineGetter__) can't slip past a hand-picked subset.
const PROTO_KEYS = Object.getOwnPropertyNames(Object.prototype);

const mixedCase = (word: string): fc.Arbitrary<string> =>
  fc.array(fc.boolean(), { minLength: word.length, maxLength: word.length }).map((bits) =>
    word
      .split("")
      .map((ch, i) => (bits[i] ? ch.toUpperCase() : ch))
      .join(""),
  );

const knownButton = fc.constantFrom(...ALL_BUTTONS);
// A grab-bag exercising every branch: known buttons, prototype keys, randoms.
const anyButtonName = fc.oneof(
  knownButton,
  fc.constantFrom(...PROTO_KEYS),
  fc.string({ maxLength: 12 }),
);

describe("isNavigationPressButton / isInPlacePressButton (property-based)", () => {
  test("both are total (boolean) and false for any non-string", () => {
    fc.assert(
      fc.property(fc.anything(), (value) => {
        const nav = isNavigationPressButton(value);
        const inPlace = isInPlacePressButton(value);
        const nonStringIsFalse = typeof value === "string" || (!nav && !inPlace);
        return typeof nav === "boolean" && typeof inPlace === "boolean" && nonStringIsFalse;
      }),
      RUN_OPTIONS,
    );
  });

  test("the two categories are disjoint for any input", () => {
    fc.assert(
      fc.property(
        anyButtonName,
        (value) => !(isNavigationPressButton(value) && isInPlacePressButton(value)),
      ),
      RUN_OPTIONS,
    );
  });

  test("classify their own members case-insensitively", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...NAV_BUTTONS).chain(mixedCase),
        (b) => isNavigationPressButton(b) && !isInPlacePressButton(b),
      ),
      RUN_OPTIONS,
    );
    fc.assert(
      fc.property(
        fc.constantFrom(...IN_PLACE_BUTTONS).chain(mixedCase),
        (b) => isInPlacePressButton(b) && !isNavigationPressButton(b),
      ),
      RUN_OPTIONS,
    );
  });
});

describe("resolveAndroidKeyCode (property-based)", () => {
  test("returns a known key code for a supported button (any casing), else undefined", () => {
    fc.assert(
      fc.property(anyButtonName, (button) => {
        const code = resolveAndroidKeyCode(button);
        return code === undefined || KEY_CODES.has(code);
      }),
      RUN_OPTIONS,
    );
  });

  test("is defined exactly for navigation or in-place buttons (cross-invariant)", () => {
    fc.assert(
      fc.property(anyButtonName, (button) => {
        const defined = resolveAndroidKeyCode(button) !== undefined;
        return defined === (isNavigationPressButton(button) || isInPlacePressButton(button));
      }),
      RUN_OPTIONS,
    );
  });

  test("never leaks an Object.prototype member (issue #4187)", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...PROTO_KEYS),
        (key) => resolveAndroidKeyCode(key) === undefined,
      ),
      RUN_OPTIONS,
    );
  });

  test("is case-insensitive", () => {
    fc.assert(
      fc.property(
        knownButton.chain(mixedCase),
        (button) => resolveAndroidKeyCode(button) === resolveAndroidKeyCode(button.toLowerCase()),
      ),
      RUN_OPTIONS,
    );
  });
});
