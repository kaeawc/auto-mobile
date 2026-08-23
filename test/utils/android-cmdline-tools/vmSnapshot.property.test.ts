import { describe, test } from "bun:test";
import fc from "fast-check";
import type { ExecResult } from "../../../src/models";
import {
  buildVmSnapshotCommand,
  evaluateVmSnapshotResult,
  formatVmSnapshotExecutionError,
} from "../../../src/utils/android-cmdline-tools/vmSnapshot";

// Property-based tests. See test/utils/Backoff.property.test.ts for the pinned-seed rationale.
const RUN_OPTIONS = { seed: 1_234_567, numRuns: 300 } as const;

const action = fc.constantFrom<"save" | "load">("save", "load");
const snapshotName = fc.string({ unit: fc.constantFrom("a", "b", "1", "_", "-"), maxLength: 12 });
// evaluate only reads .stdout/.stderr off the ExecResult.
const asResult = (stdout: string, stderr: string): ExecResult =>
  ({ stdout, stderr }) as unknown as ExecResult;

// Output lines biased toward the OK/KO tokens (and near-misses like OKAY/BOOK).
const line = fc.oneof(
  fc.constantFrom(
    "OK",
    "KO",
    "ok",
    "ko",
    "OKAY",
    "BOOK",
    "KO: failed",
    "snapshot OK",
    "done",
    "error",
    "",
  ),
  fc.string({ unit: fc.constantFrom("O", "K", "A", "B", " ", "x"), maxLength: 8 }),
);

// Independent oracle for the OK/KO decision on the combined, upper-cased output.
const evalOracleOk = (stdout: string, stderr: string): boolean => {
  const combined = [stdout, stderr]
    .filter((p) => p && p.trim().length > 0)
    .join("\n")
    .trim()
    .toUpperCase();
  if (/\bKO\b/.test(combined)) {
    return false;
  }
  return /\bOK\b/.test(combined);
};

describe("buildVmSnapshotCommand (property-based)", () => {
  test("composes `emu avd snapshot <action> <name>` verbatim", () => {
    fc.assert(
      fc.property(action, snapshotName, (a, name) => {
        const cmd = buildVmSnapshotCommand(a, name);
        return cmd === `emu avd snapshot ${a} ${name}` && cmd.startsWith(`emu avd snapshot ${a} `);
      }),
      RUN_OPTIONS,
    );
  });
});

describe("evaluateVmSnapshotResult (property-based)", () => {
  test("ok is true exactly when OK is present and KO is absent (word-boundary)", () => {
    fc.assert(
      fc.property(action, snapshotName, line, line, (a, name, stdout, stderr) => {
        return (
          evaluateVmSnapshotResult(a, name, asResult(stdout, stderr)).ok ===
          evalOracleOk(stdout, stderr)
        );
      }),
      RUN_OPTIONS,
    );
  });

  test("KO takes precedence over OK", () => {
    fc.assert(
      fc.property(action, snapshotName, (a, name) => {
        return (
          evaluateVmSnapshotResult(a, name, asResult("OK", "KO")).ok === false &&
          evaluateVmSnapshotResult(a, name, asResult("OK KO", "")).ok === false
        );
      }),
      RUN_OPTIONS,
    );
  });

  test("success carries no errorMessage; failure carries a base-prefixed one", () => {
    fc.assert(
      fc.property(action, snapshotName, line, line, (a, name, stdout, stderr) => {
        const r = evaluateVmSnapshotResult(a, name, asResult(stdout, stderr));
        const base = `VM snapshot ${a} failed for '${name}'`;
        return r.ok
          ? r.errorMessage === undefined
          : typeof r.errorMessage === "string" && r.errorMessage.startsWith(base);
      }),
      RUN_OPTIONS,
    );
  });
});

describe("formatVmSnapshotExecutionError (property-based)", () => {
  test("always opens with the failed-snapshot base line", () => {
    fc.assert(
      fc.property(
        action,
        snapshotName,
        fc.oneof(
          fc.string({ maxLength: 20 }),
          fc.string().map((m) => new Error(m)),
        ),
        (a, name, error) => {
          return formatVmSnapshotExecutionError(a, name, error).startsWith(
            `VM snapshot ${a} failed for '${name}'`,
          );
        },
      ),
      RUN_OPTIONS,
    );
  });

  test("classifies known failure categories from the error detail", () => {
    const cases = fc.constantFrom(
      { keyword: "timed out", phrase: "command timed out" },
      { keyword: "device offline", phrase: "emulator is offline or not responding" },
      { keyword: "no emulators", phrase: "emulator not found" },
      { keyword: "unknown command", phrase: "emulator does not support snapshot commands" },
      { keyword: "snapshot does not exist", phrase: "snapshot not found" },
    );
    fc.assert(
      fc.property(action, snapshotName, cases, (a, name, { keyword, phrase }) => {
        return formatVmSnapshotExecutionError(a, name, new Error(keyword)).includes(phrase);
      }),
      RUN_OPTIONS,
    );
  });
});
