import { describe, test } from "bun:test";
import fc from "fast-check";
import {
  buildAsciiKeyEventPlan,
  type KeyEventPlan,
} from "../../../src/features/action/asciiKeyEvents";

// Property-based tests. See test/utils/Backoff.property.test.ts for the pinned-seed rationale.
const RUN_OPTIONS = { seed: 1_234_567, numRuns: 300 } as const;

// Oracle copies of the module's private tables (char -> base keycode).
const DIRECT_CODES: Record<string, string> = {
  " ": "KEYCODE_SPACE",
  "-": "KEYCODE_MINUS",
  "=": "KEYCODE_EQUALS",
  "[": "KEYCODE_LEFT_BRACKET",
  "]": "KEYCODE_RIGHT_BRACKET",
  "\\": "KEYCODE_BACKSLASH",
  ";": "KEYCODE_SEMICOLON",
  "'": "KEYCODE_APOSTROPHE",
  ",": "KEYCODE_COMMA",
  ".": "KEYCODE_PERIOD",
  "/": "KEYCODE_SLASH",
  "`": "KEYCODE_GRAVE",
  "@": "KEYCODE_AT",
};
const SHIFTED_CODES: Record<string, string> = {
  "!": "KEYCODE_1",
  "#": "KEYCODE_3",
  $: "KEYCODE_4",
  "%": "KEYCODE_5",
  "^": "KEYCODE_6",
  "&": "KEYCODE_7",
  "*": "KEYCODE_8",
  "(": "KEYCODE_9",
  ")": "KEYCODE_0",
  _: "KEYCODE_MINUS",
  "+": "KEYCODE_EQUALS",
  "{": "KEYCODE_LEFT_BRACKET",
  "}": "KEYCODE_RIGHT_BRACKET",
  "|": "KEYCODE_BACKSLASH",
  ":": "KEYCODE_SEMICOLON",
  '"': "KEYCODE_APOSTROPHE",
  "<": "KEYCODE_COMMA",
  ">": "KEYCODE_PERIOD",
  "?": "KEYCODE_SLASH",
  "~": "KEYCODE_GRAVE",
};

const fromRange = (lo: number, hi: number): fc.Arbitrary<string> =>
  fc.integer({ min: lo, max: hi }).map((c) => String.fromCharCode(c));
const lower = fromRange(0x61, 0x7a);
const upper = fromRange(0x41, 0x5a);
const digit = fromRange(0x30, 0x39);
const directSym = fc.constantFrom(...Object.keys(DIRECT_CODES));
const shiftedSym = fc.constantFrom(...Object.keys(SHIFTED_CODES));
const shiftRequiring = fc.oneof(upper, shiftedSym);
const nonShift = fc.oneof(lower, digit, directSym);
// Untypeable inputs: control chars, BMP non-ASCII, and astral code points
// (U+10000+). Real callers pass astral chars as two-code-unit strings via
// Array.from(text); fromCharCode makes only single units, so generate the
// astral range separately with String.fromCodePoint.
const astral = fc.integer({ min: 0x10000, max: 0x10ffff }).map((cp) => String.fromCodePoint(cp));
const untypeable = fc.oneof(
  fromRange(0x00, 0x1f),
  fc.constant(""),
  fromRange(0x0080, 0xffff),
  astral,
);
const anyChar = fc.oneof(nonShift, shiftRequiring, untypeable, fromRange(0, 0xffff));

const eqPlan = (a: KeyEventPlan | null, b: KeyEventPlan | null): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

describe("buildAsciiKeyEventPlan (property-based)", () => {
  test("lowercase maps to a capability-independent uppercase keyevent", () => {
    fc.assert(
      fc.property(lower, fc.boolean(), (c, supports) =>
        eqPlan(buildAsciiKeyEventPlan(c, supports), {
          commands: [`shell input keyevent KEYCODE_${c.toUpperCase()}`],
        }),
      ),
      RUN_OPTIONS,
    );
  });

  test("digits map to a capability-independent keyevent", () => {
    fc.assert(
      fc.property(digit, fc.boolean(), (c, supports) =>
        eqPlan(buildAsciiKeyEventPlan(c, supports), {
          commands: [`shell input keyevent KEYCODE_${c}`],
        }),
      ),
      RUN_OPTIONS,
    );
  });

  test("direct symbols map to their keyevent, independent of capability", () => {
    fc.assert(
      fc.property(directSym, fc.boolean(), (c, supports) =>
        eqPlan(buildAsciiKeyEventPlan(c, supports), {
          commands: [`shell input keyevent ${DIRECT_CODES[c]}`],
        }),
      ),
      RUN_OPTIONS,
    );
  });

  test("uppercase needs a SHIFT chord — a plan iff keycombination is supported", () => {
    fc.assert(
      fc.property(upper, (c) => {
        return (
          eqPlan(buildAsciiKeyEventPlan(c, true), {
            commands: [`shell input keycombination KEYCODE_SHIFT_LEFT KEYCODE_${c}`],
          }) && buildAsciiKeyEventPlan(c, false) === null
        );
      }),
      RUN_OPTIONS,
    );
  });

  test("shifted symbols need a SHIFT chord — a plan iff keycombination is supported", () => {
    fc.assert(
      fc.property(shiftedSym, (c) => {
        return (
          eqPlan(buildAsciiKeyEventPlan(c, true), {
            commands: [`shell input keycombination KEYCODE_SHIFT_LEFT ${SHIFTED_CODES[c]}`],
          }) && buildAsciiKeyEventPlan(c, false) === null
        );
      }),
      RUN_OPTIONS,
    );
  });

  test("enabling keycombination is monotonic — it never drops or alters an existing plan", () => {
    fc.assert(
      fc.property(anyChar, (c) => {
        const without = buildAsciiKeyEventPlan(c, false);
        return without === null || eqPlan(buildAsciiKeyEventPlan(c, true), without);
      }),
      RUN_OPTIONS,
    );
  });

  test("a plan is gated by capability exactly for shift-requiring characters", () => {
    fc.assert(
      fc.property(
        shiftRequiring,
        (c) =>
          buildAsciiKeyEventPlan(c, false) === null && buildAsciiKeyEventPlan(c, true) !== null,
      ),
      RUN_OPTIONS,
    );
  });

  test("is total — null or a single well-formed `shell input ...` command", () => {
    fc.assert(
      fc.property(anyChar, fc.boolean(), (c, supports) => {
        const plan = buildAsciiKeyEventPlan(c, supports);
        return (
          plan === null ||
          (plan.commands.length === 1 && plan.commands[0].startsWith("shell input "))
        );
      }),
      RUN_OPTIONS,
    );
  });

  test("untypeable characters (control / non-ASCII) always yield null", () => {
    fc.assert(
      fc.property(
        untypeable,
        fc.boolean(),
        (c, supports) => buildAsciiKeyEventPlan(c, supports) === null,
      ),
      RUN_OPTIONS,
    );
  });
});
