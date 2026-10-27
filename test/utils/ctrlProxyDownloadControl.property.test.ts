import { describe, test } from "bun:test";
import fc from "fast-check";
import { isTruthyEnvText } from "../../src/config/env";
import {
  LEGACY_SKIP_ACCESSIBILITY_DOWNLOAD_FLAG,
  shouldSkipCtrlProxyDownload,
  SKIP_CTRL_PROXY_DOWNLOAD_ENV,
  SKIP_CTRL_PROXY_DOWNLOAD_FLAG,
} from "../../src/utils/ctrlProxyDownloadControl";

// Property-based tests. See Backoff.property.test.ts for the pinned-seed rationale.
const RUN_OPTIONS = { seed: 1_234_567, numRuns: 300 } as const;

const TRUTHY_TOKENS = ["1", "true", "yes", "on"] as const;

// A truthy token in an arbitrary mix of upper/lower case, padded with whitespace — exercises the
// case-insensitive and trimming branches.
const paddedMixedCaseTruthy = fc
  .tuple(
    fc.constantFrom(...TRUTHY_TOKENS),
    fc.array(fc.boolean(), { minLength: 4, maxLength: 4 }),
    fc.constantFrom("", " ", "\t"),
    fc.constantFrom("", " ", "\n"),
  )
  .map(
    ([token, bits, before, after]) =>
      before +
      token
        .split("")
        .map((ch, i) => (bits[i] ? ch.toUpperCase() : ch))
        .join("") +
      after,
  );

describe("isTruthyEnvText (property-based)", () => {
  test("is total and matches its exact definition for arbitrary strings", () => {
    fc.assert(
      fc.property(fc.option(fc.string({ maxLength: 8 }), { nil: undefined }), (value) => {
        const result = isTruthyEnvText(value);
        return (
          typeof result === "boolean" &&
          result ===
            (value !== undefined &&
              (TRUTHY_TOKENS as readonly string[]).includes(value.trim().toLowerCase()))
        );
      }),
      RUN_OPTIONS,
    );
  });

  test("accepts 1, true, yes and on in any casing, with surrounding whitespace", () => {
    fc.assert(
      fc.property(paddedMixedCaseTruthy, (variant) => isTruthyEnvText(variant)),
      RUN_OPTIONS,
    );
  });

  test("rejects undefined and unrelated tokens", () => {
    const notTruthy = fc.constantFrom("", "0", "false", "no", "off", "2", "enabled", "t rue");
    fc.assert(
      fc.property(
        notTruthy,
        (value) => isTruthyEnvText(value) === false && isTruthyEnvText(undefined) === false,
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
          return shouldSkipCtrlProxyDownload(args, env) === isTruthyEnvText(envValue);
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
