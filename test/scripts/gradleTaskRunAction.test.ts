import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "../..");
const actionPath = join(repoRoot, ".github/actions/gradle-task-run/action.yml");

describe("gradle-task-run action", () => {
  test("does not reference GitHub actions pinned to Node 20 runtimes", () => {
    const action = readFileSync(actionPath, "utf8");

    expect(action).not.toContain("pplanel/hash-calculator-action");
    expect(action).not.toContain("actions/cache/restore@v4");
    expect(action).not.toContain("actions/cache/save@v4");
    expect(action).not.toContain("actions/upload-artifact@v4.4.0");
    expect(action).not.toContain("gradle/actions/setup-gradle@v4");

    expect(action).toContain("gradle/actions/setup-gradle@v5.0.2");
    expect(action).toContain("actions/cache/restore@v5.1.0");
    expect(action).toContain("actions/cache/save@v5.1.0");
    expect(action).toContain("actions/upload-artifact@v7.0.1");
    expect(action).toContain('echo "digest=$digest" >> "$GITHUB_OUTPUT"');
    expect(action).toContain('echo "version=$(cat /tmp/gradle_version.txt)" >> "$GITHUB_OUTPUT"');
    expect(action).toContain('echo "version=${{ inputs.gradle-version }}" >> "$GITHUB_OUTPUT"');
  });
});
