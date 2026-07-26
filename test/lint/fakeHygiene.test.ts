import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Source-scan ratchet: a test double under test/fakes must not reach for the
 * real clock (`defaultTimer`, `Date.now()`) or real randomness (`Math.random()`,
 * `randomUUID()`). Those are exactly the non-determinism the fake seam exists to
 * remove, so a fake that uses them silently reintroduces flake (issue #4186).
 *
 * `Math.random(`/`randomUUID(` are HARD-banned (zero occurrences allowed). The
 * pre-existing `defaultTimer`/`Date.now(` uses are recorded PER OCCURRENCE below
 * (keyed by trimmed source line, with multiplicity) so the scan is green today
 * yet fails on any NEW occurrence — and, crucially, a per-occurrence key means a
 * sanctioned `?? Date.now()` line does not whitelist a sibling raw `Date.now()`
 * in the same file. Prefer removing an entry (inject a Timer/FakeTimer) over
 * growing the allowlist.
 */

const FAKES_DIR = path.join(import.meta.dir, "..", "fakes");

const FORBIDDEN_TOKENS = ["defaultTimer", "Date.now(", "Math.random(", "randomUUID("];

// relative filename -> trimmed source lines that are allowed to contain a
// forbidden token (duplicates listed once per occurrence).
const ALLOWLIST: Record<string, string[]> = {
  "FakeIOSCtrlProxy.ts": [
    'import { defaultTimer } from "../../src/utils/SystemTimer";',
    "await defaultTimer.sleep(delay);",
    "timestamp: Date.now()",
  ],
  "FakeWebSocket.ts": [
    'import { defaultTimer } from "../../src/utils/SystemTimer";',
    'constructor(url: string, failureMode: "instant" | "timeout" | "none" = "none", connectTimeoutMs: number = 0, timer: Timer = defaultTimer) {',
  ],
  "FakeCtrlProxy.ts": [
    'import { defaultTimer } from "../../src/utils/SystemTimer";',
    "await defaultTimer.sleep(delay);",
    "timestamp: Date.now()",
  ],
  "FakeObserveCacheStore.ts": [
    'import { Timer, defaultTimer } from "../../src/utils/SystemTimer";',
    "constructor(timer: Timer = defaultTimer) {",
  ],
  "FakeChildProcess.ts": [
    'import { defaultTimer } from "../../src/utils/SystemTimer";',
    "defaultTimer.setTimeout(() => {",
    "defaultTimer.setTimeout(() => {",
  ],
  "FakeNavigationGraphManager.ts": ["timestamp: Date.now(),"],
  "FakeAdbExecutor.ts": ["return this.deviceTimestampMs ?? Date.now();"],
  "FakeAdbClientFactory.ts": ["timestamp: Date.now(),"],
  "FakeSetUIStateDependencies.ts": ["updatedAt: Date.now(),"],
  "FakeSimctl.ts": ["pid: Date.now(),"],
  "ResultFaker.ts": ["const updatedAt = overrides.updatedAt ?? Date.now();"],
  "FakeFailureRecorder.ts": [
    "timestamp: Date.now(),",
    "timestamp: Date.now(),",
    "timestamp: Date.now(),",
    "timestamp: Date.now(),",
  ],
  "FakeAwaitIdle.ts": ["const now = Date.now();"],
};

function lineHasForbiddenToken(line: string): boolean {
  // Ignore comment-only mentions: a token inside a `//` or `*` comment is not a
  // real clock/randomness reach.
  const trimmed = line.trim();
  if (trimmed.startsWith("//") || trimmed.startsWith("*")) {
    return false;
  }
  return FORBIDDEN_TOKENS.some(token => line.includes(token));
}

function forbiddenLinesIn(source: string): string[] {
  return source
    .split("\n")
    .filter(lineHasForbiddenToken)
    .map(line => line.trim());
}

function sortedMultiset(values: string[]): string[] {
  return [...values].sort();
}

describe("fake hygiene source scan (#4186)", () => {
  const fakeFiles = readdirSync(FAKES_DIR).filter(
    name => name.endsWith(".ts") && !name.endsWith(".test.ts")
  );

  test("scans a non-trivial number of fakes", () => {
    // Guards against a glob/path regression silently scanning nothing.
    expect(fakeFiles.length).toBeGreaterThan(50);
  });

  for (const fileName of fakeFiles) {
    test(`${fileName} introduces no new real-clock / real-randomness use`, () => {
      const source = readFileSync(path.join(FAKES_DIR, fileName), "utf8");
      const found = forbiddenLinesIn(source);
      const allowed = ALLOWLIST[fileName] ?? [];

      expect(sortedMultiset(found)).toEqual(sortedMultiset(allowed));
    });
  }
});
