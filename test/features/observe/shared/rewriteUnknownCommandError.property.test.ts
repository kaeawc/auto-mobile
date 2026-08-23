import { describe, test } from "bun:test";
import fc from "fast-check";
import {
  rewriteUnknownCommandError,
  type CtrlProxyPlatform,
} from "../../../../src/features/observe/shared/rewriteUnknownCommandError";

// Property-based tests. See test/utils/Backoff.property.test.ts for the pinned-seed rationale.
const RUN_OPTIONS = { seed: 1_234_567, numRuns: 300 } as const;

const UNKNOWN_RE = /^Unknown command type: (.+)$/;
const platform = fc.constantFrom<CtrlProxyPlatform>("android", "ios");
// A command on a single line: the regex `.` never crosses a newline.
const isSingleLine = (s: string): boolean => s.indexOf("\n") === -1 && s.indexOf("\r") === -1;
const command = fc.string({ maxLength: 20 }).filter((s) => s.length > 0 && isSingleLine(s));

describe("rewriteUnknownCommandError (property-based)", () => {
  test("passes a non-matching error through unchanged", () => {
    const nonMatching = fc.string({ maxLength: 40 }).filter((s) => !UNKNOWN_RE.test(s));
    fc.assert(
      fc.property(
        nonMatching,
        platform,
        (error, p) => rewriteUnknownCommandError(error, p) === error,
      ),
      RUN_OPTIONS,
    );
  });

  test("rewrites a matching error into a platform-specific, command-carrying message", () => {
    fc.assert(
      fc.property(command, platform, (cmd, p) => {
        const rewritten = rewriteUnknownCommandError(`Unknown command type: ${cmd}`, p);
        const platformHint = p === "android" ? "APK" : "iOS CtrlProxy runner";
        return (
          rewritten !== `Unknown command type: ${cmd}` &&
          rewritten.includes(cmd) &&
          rewritten.includes(platformHint)
        );
      }),
      RUN_OPTIONS,
    );
  });

  test("is idempotent — the rewritten message no longer matches and passes through", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), platform, (error, p) => {
        const once = rewriteUnknownCommandError(error, p);
        return rewriteUnknownCommandError(once, p) === once;
      }),
      RUN_OPTIONS,
    );
  });
});
