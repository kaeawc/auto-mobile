import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { workingTreeFiles } from "../helpers/workingTreeFiles";

// Every `*.integration.test.ts` must be classified in test/integration-safe-tier.txt,
// so `scripts/prepush-integration-safe.sh` runs exactly the safe tier and a new
// integration test cannot land unclassified.

const root = join(import.meta.dir, "..", "..");
const TIER_FILE = "test/integration-safe-tier.txt";
const INTEGRATION_SUFFIX = ".integration.test.ts";

interface TierEntry {
  readonly path: string;
  readonly tier: string;
  readonly reason: string;
  readonly line: number;
}

function parseTierFile(text: string): { entries: TierEntry[]; malformed: string[] } {
  const entries: TierEntry[] = [];
  const malformed: string[] = [];
  text.split("\n").forEach((raw, index) => {
    if (raw.trim() === "" || raw.startsWith("#")) {
      return;
    }
    const parts = raw.split(" | ");
    const [path, tier, ...reasonParts] = parts;
    const reason = reasonParts.join(" | ").trim();
    if (parts.length < 3 || reason === "") {
      malformed.push(`line ${index + 1}: expected "path | safe|unsafe | reason": ${raw}`);
      return;
    }
    entries.push({ path: path.trim(), tier: tier.trim(), reason, line: index + 1 });
  });
  return { entries, malformed };
}

let tracked: string[];
let entries: TierEntry[];
let malformed: string[];

beforeAll(() => {
  // Includes untracked files: a new, not yet committed file (jj checkouts do not stage).
  tracked = workingTreeFiles(root, ["*" + INTEGRATION_SUFFIX]);
  ({ entries, malformed } = parseTierFile(readFileSync(join(root, TIER_FILE), "utf8")));
});

describe("integration safe-tier classification", () => {
  test("every line is well formed and uses a known tier", () => {
    const badTier = entries
      .filter((entry) => entry.tier !== "safe" && entry.tier !== "unsafe")
      .map((entry) => `line ${entry.line}: tier must be safe or unsafe: ${entry.path}`);
    expect([...malformed, ...badTier]).toEqual([]);
  });

  test("lists only integration test files, sorted, without duplicates", () => {
    const paths = entries.map((entry) => entry.path);
    const notIntegration = paths.filter((path) => !path.endsWith(INTEGRATION_SUFFIX));
    const duplicates = paths.filter((path, index) => paths.indexOf(path) !== index);
    const sorted = [...paths].sort();
    expect({ notIntegration, duplicates, sorted: paths.every((p, i) => p === sorted[i]) }).toEqual({
      notIntegration: [],
      duplicates: [],
      sorted: true,
    });
  });

  test("classifies every integration test file; add new ones to the list in the same PR", () => {
    const listed = new Set(entries.map((entry) => entry.path));
    const unclassified = tracked.filter((path) => !listed.has(path));
    expect(unclassified).toEqual([]);
  });

  test("names no file that no longer exists", () => {
    const existing = new Set(tracked);
    const stale = entries.map((entry) => entry.path).filter((path) => !existing.has(path));
    expect(stale).toEqual([]);
  });
});
