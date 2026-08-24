import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { formatCommandError, wrapCommandError } from "../../src/utils/CommandError";

// Property-based tests. See Backoff.property.test.ts for the pinned-seed rationale.
const RUN_OPTIONS = { seed: 1_234_567, numRuns: 300 } as const;

const MAX = 4000;
// Newline-free tokens so the structured, line-per-field output stays parseable.
const safe = fc.string({
  unit: fc.constantFrom("a", "b", "/", ".", "-", "_", " ", "1"),
  maxLength: 12,
});
const options = fc.record(
  {
    command: safe,
    args: fc.array(safe, { maxLength: 3 }),
    cwd: fc.option(
      safe.filter((s) => s.length > 0),
      { nil: undefined },
    ),
    stdout: fc.option(fc.string({ maxLength: 40 }), { nil: undefined }),
    stderr: fc.option(fc.string({ maxLength: 40 }), { nil: undefined }),
  },
  { requiredKeys: ["command"] },
);

// The full caught-error domain: Error objects, primitives, plain objects, and
// null/undefined. formatCommandError null-guards the error cast, so it is total
// across all of these (regression coverage for the null-error crash fixed here).
const errorValue = fc.anything();

const excerpt = (v: string): string => {
  const t = v.trim();
  return t.length <= MAX ? t : `...${t.slice(-MAX)}`;
};

describe("formatCommandError (property-based)", () => {
  test("is total and opens with the failed command line", () => {
    fc.assert(
      fc.property(errorValue, options, (error, opts) => {
        const out = formatCommandError(error, opts);
        const commandLine = [opts.command, ...(opts.args ?? [])].join(" ");
        return typeof out === "string" && out.startsWith(`Command failed: ${commandLine}`);
      }),
      RUN_OPTIONS,
    );
  });

  test("always includes a raw-error line", () => {
    fc.assert(
      fc.property(errorValue, options, (error, opts) =>
        formatCommandError(error, opts).includes("raw error:"),
      ),
      RUN_OPTIONS,
    );
  });

  test("includes a cwd line exactly when cwd is provided", () => {
    fc.assert(
      fc.property(errorValue, options, (error, opts) => {
        const hasCwdLine = formatCommandError(error, opts).split("\n").includes(`cwd: ${opts.cwd}`);
        return hasCwdLine === (opts.cwd !== undefined);
      }),
      RUN_OPTIONS,
    );
  });

  test("renders numeric err.code as an exit code and string err.code as an error code", () => {
    const code = fc.oneof(fc.integer(), fc.string({ maxLength: 6 }), fc.constant(undefined));
    fc.assert(
      fc.property(fc.string({ maxLength: 10 }), code, options, (message, c, opts) => {
        const err = new Error(message) as Error & { code?: unknown };
        if (c !== undefined) {
          err.code = c;
        }
        const lines = formatCommandError(err, opts).split("\n");
        if (typeof c === "number") {
          return (
            lines.includes(`exit code: ${c}`) && !lines.some((l) => l.startsWith("error code:"))
          );
        }
        if (typeof c === "string") {
          return (
            lines.includes(`error code: ${c}`) && !lines.some((l) => l.startsWith("exit code:"))
          );
        }
        return !lines.some((l) => l.startsWith("exit code:") || l.startsWith("error code:"));
      }),
      RUN_OPTIONS,
    );
  });

  test("includes an stdout section exactly when the stdout has non-whitespace content", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), options, (stdout, opts) => {
        const out = formatCommandError(new Error("x"), { ...opts, stdout, stderr: undefined });
        const hasSection = out.includes("stdout: (last");
        return hasSection === stdout.trim().length > 0;
      }),
      RUN_OPTIONS,
    );
  });

  test("bounds each output excerpt to at most MAX+3 chars and reproduces the excerpt oracle", () => {
    const maybeLong = fc.string({ maxLength: 4300 });
    fc.assert(
      fc.property(maybeLong, (opts) => {
        const out = formatCommandError(new Error("x"), { command: "cmd", stdout: opts });
        const ex = excerpt(opts);
        return ex.length <= MAX + 3 && (ex.length === 0 || out.includes(ex));
      }),
      RUN_OPTIONS,
    );
  });

  // Regression for the null-error crash: formatCommandError used to dereference
  // err.stdout before null-checking, throwing on a null/undefined caught error
  // when options.stdout was falsy. It must now be total and still render the
  // raw-error line carrying String(error).
  test("does not throw and still renders the raw-error line for null/undefined errors", () => {
    for (const error of [undefined, null]) {
      const out = formatCommandError(error, { command: "x" });
      expect(out.startsWith("Command failed: x")).toBe(true);
      expect(out).toContain(`raw error: (last ${MAX} chars) ${String(error)}`);
    }
  });
});

describe("wrapCommandError (property-based)", () => {
  test("wraps into an Error whose message is the formatted string", () => {
    fc.assert(
      fc.property(errorValue, options, (error, opts) => {
        const wrapped = wrapCommandError(error, opts);
        return wrapped instanceof Error && wrapped.message === formatCommandError(error, opts);
      }),
      RUN_OPTIONS,
    );
  });

  test("preserves the original error's name when the input is an Error", () => {
    const named = fc.string({ maxLength: 12 }).map((n) => {
      const e = new Error("boom");
      e.name = n || "Error";
      return e;
    });
    fc.assert(
      fc.property(
        named,
        options,
        (error, opts) => wrapCommandError(error, opts).name === error.name,
      ),
      RUN_OPTIONS,
    );
  });
});
