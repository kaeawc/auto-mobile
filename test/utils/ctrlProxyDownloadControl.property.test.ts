import { describe, test } from "bun:test";
import fc from "fast-check";
import {
  isTruthyEnvValue,
  LEGACY_SKIP_ACCESSIBILITY_DOWNLOAD_FLAG,
  shouldSkipCtrlProxyDownload,
  SKIP_CTRL_PROXY_DOWNLOAD_ENV,
  SKIP_CTRL_PROXY_DOWNLOAD_FLAG,
} from "../../src/utils/ctrlProxyDownloadControl";

// Property-based tests. See Backoff.property.test.ts for the pinned-seed rationale.
const RUN_OPTIONS = { seed: 1_234_567, numRuns: 300 } as const;

// "true" in an arbitrary mix of upper/lower case — exercises the case-insensitive branch.
const mixedCaseTrue = fc.array(fc.boolean(), { minLength: 4, maxLength: 4 }).map((bits) =>
  "true"
    .split("")
    .map((ch, i) => (bits[i] ? ch.toUpperCase() : ch))
    .join(""),
);

describe("isTruthyEnvValue (property-based)", () => {
  test("is total and matches its exact definition for arbitrary strings", () => {
    fc.assert(
      fc.property(fc.option(fc.string({ maxLength: 8 }), { nil: undefined }), (value) => {
        const result = isTruthyEnvValue(value);
        return (
          typeof result === "boolean" &&
          result === (value === "1" || value?.toLowerCase() === "true")
        );
      }),
      RUN_OPTIONS,
    );
  });

  test('accepts "1" and any casing of "true"', () => {
    fc.assert(
      fc.property(mixedCaseTrue, (variant) => isTruthyEnvValue("1") && isTruthyEnvValue(variant)),
      RUN_OPTIONS,
    );
  });

  test("rejects undefined and unrelated tokens", () => {
    const notTruthy = fc
      .constantFrom("", "0", "false", "yes", "2", "on", "enabled", " true", "true ")
      .filter((v) => v !== "1" && v.toLowerCase() !== "true");
    fc.assert(
      fc.property(
        notTruthy,
        (value) => isTruthyEnvValue(value) === false && isTruthyEnvValue(undefined) === false,
      ),
      RUN_OPTIONS,
    );
  });
});

describe("shouldSkipCtrlProxyDownload (property-based)", () => {
  test("is total (boolean) for arbitrary argv and env", () => {
    const envRecord = fc.dictionary(fc.string({ maxLength: 8 }), fc.string({ maxLength: 8 }));
    fc.assert(
      fc.property(fc.array(fc.string({ maxLength: 8 })), envRecord, (args, env) => {
        return typeof shouldSkipCtrlProxyDownload(args, env) === "boolean";
      }),
      RUN_OPTIONS,
    );
  });

  test("either skip flag forces skip, regardless of env", () => {
    const anyEnvValue = fc.dictionary(fc.string(), fc.string());
    const flag = fc.constantFrom(
      SKIP_CTRL_PROXY_DOWNLOAD_FLAG,
      LEGACY_SKIP_ACCESSIBILITY_DOWNLOAD_FLAG,
    );
    fc.assert(
      fc.property(fc.array(fc.string({ maxLength: 6 })), flag, anyEnvValue, (rest, f, env) => {
        return shouldSkipCtrlProxyDownload([...rest, f], env) === true;
      }),
      RUN_OPTIONS,
    );
  });

  test("without a flag, the result tracks the env value's truthiness", () => {
    const positionals = fc.array(
      fc.string({ maxLength: 6 }).map((t) => `p${t}`),
      { maxLength: 6 },
    );
    fc.assert(
      fc.property(
        positionals,
        fc.option(fc.string({ maxLength: 8 }), { nil: undefined }),
        (args, envValue) => {
          const env = { [SKIP_CTRL_PROXY_DOWNLOAD_ENV]: envValue };
          return shouldSkipCtrlProxyDownload(args, env) === isTruthyEnvValue(envValue);
        },
      ),
      RUN_OPTIONS,
    );
  });

  test("adding a skip flag is monotonic — it never flips skip off", () => {
    const envRecord = fc.dictionary(fc.string(), fc.string());
    fc.assert(
      fc.property(fc.array(fc.string({ maxLength: 6 })), envRecord, (args, env) => {
        const before = shouldSkipCtrlProxyDownload(args, env);
        const after = shouldSkipCtrlProxyDownload([...args, SKIP_CTRL_PROXY_DOWNLOAD_FLAG], env);
        return !before || after;
      }),
      RUN_OPTIONS,
    );
  });
});
