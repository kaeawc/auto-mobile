import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import {
  classifyDatabaseFailure,
  classifySqliteError,
} from "../../src/db/databaseFailureClassification";

// Property-based tests. See test/utils/Backoff.property.test.ts for the pinned-seed rationale.
const RUN_OPTIONS = { seed: 1_234_567, numRuns: 300 } as const;

// A `.code` value that is NOT a string, exercising the "non-string code is
// ignored" branch in both classifiers (readStringCode / the haystack check).
const nonStringCodeValue = fc.oneof(
  fc.integer(),
  fc.double({ noNaN: true }),
  fc.boolean(),
  fc.constant(null),
  fc.array(fc.string({ maxLength: 5 }), { maxLength: 3 }),
  fc.object({ maxDepth: 1 }),
);
const arbitraryCodeValue = fc.oneof(fc.string({ maxLength: 20 }), nonStringCodeValue);

// A shallow object shape suitable for use as `.cause` — one level deep, never
// self-referential, matching the "not truly circular" instruction. Includes
// fast-check's default mix of null-prototype and normal-prototype records:
// `classifyDatabaseFailure` must survive both (see `stringifyErrorLike` in
// the source, added after this suite caught a `TypeError` on null-prototype
// input — a null-prototype object has no `.toString`, and the bare
// `String(error ?? "")` it used to call throws on it).
const shallowCauseLike = fc.record(
  {
    code: fc.option(arbitraryCodeValue, { nil: undefined }),
    message: fc.option(fc.string({ maxLength: 30 }), { nil: undefined }),
  },
  { requiredKeys: [] },
);

// Plain object "error-like" values — no Error prototype at all.
const plainObjectErrorLike = fc.record(
  {
    code: fc.option(arbitraryCodeValue, { nil: undefined }),
    message: fc.option(fc.string({ maxLength: 30 }), { nil: undefined }),
    cause: fc.option(fc.oneof(shallowCauseLike, fc.string({ maxLength: 20 })), { nil: undefined }),
  },
  { requiredKeys: [] },
);

// Real Error instances with a random message and optionally a `.code` and/or
// `.cause`, mirroring how the dialect actually throws.
const errorInstanceLike = fc
  .tuple(
    fc.string({ maxLength: 30 }),
    fc.option(arbitraryCodeValue, { nil: undefined }),
    fc.option(shallowCauseLike, { nil: undefined }),
  )
  .map(([message, code, cause]) => {
    const error = new Error(message);
    if (code !== undefined) {
      Object.assign(error, { code });
    }
    if (cause !== undefined) {
      Object.assign(error, { cause });
    }
    return error;
  });

const primitive = fc.oneof(
  fc.string(),
  fc.integer(),
  fc.double({ noNaN: true }),
  fc.boolean(),
  fc.constant(null),
  fc.constant(undefined),
);

// The full space of `unknown` inputs the classifiers must survive: Errors,
// plain objects, primitives (incl. null/undefined), and arrays.
const anyErrorLikeInput = fc.oneof(
  primitive,
  errorInstanceLike,
  plainObjectErrorLike,
  fc.array(primitive, { maxLength: 5 }),
);

// Prefixes that classifySqliteError treats as retryable vs constraint. Suffixes
// are arbitrary strings so extended codes (SQLITE_BUSY_SNAPSHOT, ...) are covered.
const retryablePrefix = fc.constantFrom("SQLITE_BUSY", "SQLITE_LOCKED");
const constraintPrefix = fc.constant("SQLITE_CONSTRAINT");
const codeSuffix = fc.string({ maxLength: 20 });

// A message that may or may not contain a transient trigger substring, used to
// prove structured codes take precedence over whatever the message says.
const arbitraryMessage = fc.string({ maxLength: 60 });

// Builds an error carrying `code` either directly on itself or one level down
// via `.cause.code` — both are honored identically by extractSqliteCode.
const withCode = (code: string, message: string, viaCause: boolean): Error =>
  viaCause
    ? new Error(message, { cause: Object.assign(new Error("inner"), { code }) })
    : Object.assign(new Error(message), { code });

// Trigger substrings recognized by TRANSIENT_PATTERNS, mixed with random noise
// so generated messages both do and don't match, in arbitrary combinations.
const triggerSubstring = fc.constantFrom(
  "database is locked",
  "database table is locked",
  "EBUSY",
  "EAGAIN",
  "resource busy",
  "resource temporarily unavailable",
  "sqlite_busy",
);
const noiseSubstring = fc.string({ maxLength: 20 });
const messagePart = fc.oneof(noiseSubstring, triggerSubstring);
const codelessMessage = fc
  .array(messagePart, { minLength: 0, maxLength: 4 })
  .map((parts) => parts.join(" "));

// Error-like values with NO string `.code` reachable (own or one level of
// `.cause`), so classification must fall back to message-pattern matching.
// classifyDatabaseFailure only reads `.message` off real Error instances (any
// other value is stringified whole), so plain objects are deliberately
// excluded here — a raw string and an Error both flow `codelessMessage`
// through unmodified.
const codelessErrorLike = fc.oneof(
  codelessMessage.map((message) => new Error(message)),
  codelessMessage.map((message) => new Error(message, { cause: new Error("wrapped, no code") })),
  codelessMessage,
);

describe("databaseFailureClassification (property-based)", () => {
  test("classifyDatabaseFailure and classifySqliteError never throw and always return a declared literal", () => {
    fc.assert(
      fc.property(anyErrorLikeInput, (input) => {
        const dbResult = classifyDatabaseFailure(input);
        const sqliteResult = classifySqliteError(input);
        return (
          (dbResult === "transient" || dbResult === "permanent") &&
          (sqliteResult === "retryable" ||
            sqliteResult === "constraint" ||
            sqliteResult === "fatal")
        );
      }),
      RUN_OPTIONS,
    );
  });

  test("a null-prototype error-like object classifies as permanent/fatal instead of throwing", () => {
    const nullProtoError = Object.assign(Object.create(null), { message: "whatever" });
    expect(classifyDatabaseFailure(nullProtoError)).toBe("permanent");
    expect(classifySqliteError(nullProtoError)).toBe("fatal");
  });

  test("a SQLITE_BUSY*/SQLITE_LOCKED* code is always retryable, regardless of the message", () => {
    fc.assert(
      fc.property(
        retryablePrefix,
        codeSuffix,
        arbitraryMessage,
        fc.boolean(),
        (prefix, suffix, message, viaCause) =>
          classifySqliteError(withCode(`${prefix}${suffix}`, message, viaCause)) === "retryable",
      ),
      RUN_OPTIONS,
    );
  });

  test("a SQLITE_CONSTRAINT* code is always constraint, regardless of the message", () => {
    fc.assert(
      fc.property(
        constraintPrefix,
        codeSuffix,
        arbitraryMessage,
        fc.boolean(),
        (prefix, suffix, message, viaCause) =>
          classifySqliteError(withCode(`${prefix}${suffix}`, message, viaCause)) === "constraint",
      ),
      RUN_OPTIONS,
    );
  });

  test("a code found on .cause.code classifies identically to the same code found on the error itself", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          retryablePrefix,
          constraintPrefix,
          fc.constantFrom("SQLITE_ERROR", "SQLITE_MISUSE"),
        ),
        codeSuffix,
        arbitraryMessage,
        (prefix, suffix, message) => {
          const code = `${prefix}${suffix}`;
          const own = classifySqliteError(withCode(code, message, false));
          const viaCause = classifySqliteError(withCode(code, message, true));
          return own === viaCause;
        },
      ),
      RUN_OPTIONS,
    );
  });

  test("with no string code anywhere, classifySqliteError agrees with classifyDatabaseFailure (retryable iff transient, else fatal)", () => {
    fc.assert(
      fc.property(codelessErrorLike, (error) => {
        const dbResult = classifyDatabaseFailure(error);
        const sqliteResult = classifySqliteError(error);
        return dbResult === "transient" ? sqliteResult === "retryable" : sqliteResult === "fatal";
      }),
      RUN_OPTIONS,
    );
  });
});
