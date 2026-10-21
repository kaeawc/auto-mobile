import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

const repoRoot = join(import.meta.dir, "../..");
const agentDocs = ["CLAUDE.md", "AGENTS.md"] as const;

function read(name: string): string {
  return readFileSync(join(repoRoot, name), "utf8");
}

describe("CLAUDE.md / AGENTS.md durable content (#11875)", () => {
  test("point at the generated tool schema instead of hand-copying tool names", () => {
    expect(existsSync(join(repoRoot, "schemas/tool-definitions.json"))).toBe(true);
    for (const doc of agentDocs) {
      expect(read(doc), `${doc} must point at schemas/tool-definitions.json`).toContain(
        "schemas/tool-definitions.json",
      );
    }
  });

  test("contain no relative-date wording or calendar dates", () => {
    for (const doc of agentDocs) {
      const text = read(doc);
      expect(text, `${doc} has "this week" wording`).not.toMatch(/this week/i);
      expect(text, `${doc} has a calendar date`).not.toMatch(/\b20\d{2}-\d{2}(-\d{2})?\b/);
    }
  });
});
