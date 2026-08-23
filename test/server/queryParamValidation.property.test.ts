import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import {
  optionalBoolean,
  optionalEnum,
  optionalInteger,
  optionalString,
  queryParamsToRecord,
} from "../../src/server/queryParamValidation";

// Property-based tests. See test/utils/Backoff.property.test.ts for the pinned-seed rationale.
const RUN_OPTIONS = { seed: 1_234_567, numRuns: 300 } as const;

const optString = fc.option(fc.string({ maxLength: 16 }), { nil: undefined });
const blank = fc.oneof(
  fc.constant(undefined),
  fc.string({ unit: fc.constantFrom(" ", "\t", "\n"), maxLength: 4 }),
);

describe("optionalString (property-based)", () => {
  test("returns undefined or a non-empty trimmed string (totality)", () => {
    fc.assert(
      fc.property(optString, (v) => {
        const r = optionalString(v);
        return r === undefined || (r.length > 0 && r === r.trim());
      }),
      RUN_OPTIONS,
    );
  });

  test("blank/undefined input yields undefined", () => {
    fc.assert(
      fc.property(blank, (v) => optionalString(v) === undefined),
      RUN_OPTIONS,
    );
  });

  test("is idempotent", () => {
    fc.assert(
      fc.property(optString, (v) => optionalString(optionalString(v)) === optionalString(v)),
      RUN_OPTIONS,
    );
  });
});

describe("optionalInteger (property-based)", () => {
  test("round-trips an in-range integer", () => {
    const inRange = fc
      .tuple(fc.integer({ min: -1000, max: 1000 }), fc.integer({ min: 0, max: 2000 }))
      .chain(([min, span]) =>
        fc.record({
          min: fc.constant(min),
          max: fc.constant(min + span),
          n: fc.integer({ min, max: min + span }),
        }),
      );
    fc.assert(
      fc.property(inRange, ({ min, max, n }) => optionalInteger(`${n}`, "p", { min, max }) === n),
      RUN_OPTIONS,
    );
  });

  test("blank/undefined yields undefined", () => {
    fc.assert(
      fc.property(blank, (v) => optionalInteger(v, "p") === undefined),
      RUN_OPTIONS,
    );
  });

  test("throws below min (default 0) or above max", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1000 }),
        fc.integer({ min: 1, max: 500 }),
        (n, delta) => {
          expect(() => optionalInteger(`${n}`, "p", { min: n + delta })).toThrow(/Invalid/);
          expect(() => optionalInteger(`${n + delta}`, "p", { max: n })).toThrow(/Invalid/);
          return true;
        },
      ),
      RUN_OPTIONS,
    );
  });

  test("throws on non-integer and non-numeric input", () => {
    // NB: `Number("0x10") === 16`, so hex/octal/binary literal strings are
    // ACCEPTED by the Number()-based parser and are deliberately excluded here.
    const bad = fc.oneof(
      fc
        .double({ min: 0.01, max: 999.99, noNaN: true })
        .filter((x) => !Number.isInteger(x))
        .map(String),
      fc.constantFrom("abc", "1e5x", "NaN", "Infinity", "--3", "12abc"),
    );
    fc.assert(
      fc.property(bad, (s) => {
        expect(() => optionalInteger(s, "p", { min: 0, max: 1_000_000 })).toThrow(/Invalid/);
        return true;
      }),
      RUN_OPTIONS,
    );
  });
});

describe("optionalEnum (property-based)", () => {
  const allowed = ["alpha", "beta", "gamma", "delta"] as const;
  test("round-trips an allowed value and yields undefined for blanks", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...allowed),
        blank,
        (member, b) =>
          optionalEnum(member, "p", allowed) === member &&
          optionalEnum(b, "p", allowed) === undefined,
      ),
      RUN_OPTIONS,
    );
  });

  test("throws for a non-member", () => {
    const nonMember = fc
      .string({ minLength: 1, maxLength: 8 })
      .filter(
        (s) => s.trim().length > 0 && !allowed.includes(s.trim() as (typeof allowed)[number]),
      );
    fc.assert(
      fc.property(nonMember, (s) => {
        expect(() => optionalEnum(s, "p", allowed)).toThrow(/Invalid/);
        return true;
      }),
      RUN_OPTIONS,
    );
  });
});

describe("optionalBoolean (property-based)", () => {
  const mixedCase = (word: string): fc.Arbitrary<string> =>
    fc.array(fc.boolean(), { minLength: word.length, maxLength: word.length }).map((bits) =>
      word
        .split("")
        .map((ch, i) => (bits[i] ? ch.toUpperCase() : ch))
        .join(""),
    );

  test("only ever returns true, false, or undefined", () => {
    const anyToken = fc.oneof(optString, blank, fc.constantFrom("true", "false", "1", "0"));
    fc.assert(
      fc.property(anyToken, (v) => {
        try {
          const r = optionalBoolean(v, "p");
          return r === true || r === false || r === undefined;
        } catch {
          return true; // an unrecognized token throws by contract
        }
      }),
      RUN_OPTIONS,
    );
  });

  test("parses true/1 -> true and false/0 -> false, case-insensitively", () => {
    fc.assert(
      fc.property(
        fc.oneof(mixedCase("true"), fc.constant("1")),
        fc.oneof(mixedCase("false"), fc.constant("0")),
        (t, f) =>
          optionalBoolean(` ${t} `, "p") === true && optionalBoolean(` ${f} `, "p") === false,
      ),
      RUN_OPTIONS,
    );
  });

  test("throws for unrecognized tokens", () => {
    const other = fc.constantFrom("yes", "no", "2", "t", "f", "enabled");
    fc.assert(
      fc.property(other, (v) => {
        expect(() => optionalBoolean(v, "p")).toThrow(/Invalid/);
        return true;
      }),
      RUN_OPTIONS,
    );
  });
});

describe("queryParamsToRecord (property-based)", () => {
  const key = fc.string({
    unit: fc.constantFrom("a", "b", "c", "k", "x", "y"),
    minLength: 1,
    maxLength: 4,
  });
  const val = fc.string({ unit: fc.constantFrom("1", "2", "v", "w", "z"), maxLength: 4 });

  test("round-trips a unique-key record through URLSearchParams", () => {
    fc.assert(
      fc.property(fc.dictionary(key, val, { maxKeys: 6 }), (record) => {
        const query = new URLSearchParams(record).toString();
        const parsed = queryParamsToRecord(query);
        const keys = Object.keys(record);
        return (
          keys.length === Object.keys(parsed).length && keys.every((k) => parsed[k] === record[k])
        );
      }),
      RUN_OPTIONS,
    );
  });

  test("throws on a duplicated key", () => {
    fc.assert(
      fc.property(key, val, val, (k, a, b) => {
        expect(() => queryParamsToRecord(`${k}=${a}&${k}=${b}`)).toThrow(/Duplicate/);
        return true;
      }),
      RUN_OPTIONS,
    );
  });

  test("accepts an Object.prototype-named param on first occurrence (issue #4187)", () => {
    const protoKey = fc.constantFrom(...Object.getOwnPropertyNames(Object.prototype));
    fc.assert(
      fc.property(protoKey, val, (k, v) => {
        const parsed = queryParamsToRecord(`${encodeURIComponent(k)}=${v}`);
        return parsed[k] === v && Object.getPrototypeOf(parsed) === null;
      }),
      RUN_OPTIONS,
    );
  });
});
