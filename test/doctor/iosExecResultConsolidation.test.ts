import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Guard for issue #3200: src/doctor/checks/ios.ts must not re-implement the
// canonical `createExecResult` (src/utils/execResult.ts) nor re-inline the
// Buffer→string coercion the canonical factory now owns (as of #3197). One
// canonical primitive per concern (CLAUDE.md). ios.ts now routes generic host
// execution through the shared HostCommandExecutor seam, whose runExecSeam path
// owns the canonical createExecResult, so it neither imports the factory
// directly nor touches child_process itself.
describe("ios doctor createExecResult consolidation (#3200)", () => {
  const source = readFileSync(join(import.meta.dir, "../../src/doctor/checks/ios.ts"), "utf8");

  it("routes host execution through the canonical HostCommandExecutor seam", () => {
    // Delegating to the seam is what keeps exec-result coercion canonical
    // without ios.ts importing createExecResult or a raw child_process launcher.
    expect(source).toMatch(
      /import\s*\{[^}]*\bDefaultHostCommandExecutor\b[^}]*\}\s*from\s*["'][^"']*HostCommandExecutor["']/,
    );
    expect(source).not.toMatch(/from\s*["']node:child_process["']/);
  });

  it("declares no local createExecResult factory", () => {
    // Catch every local (re)declaration form, not just `const` — a `let`, `var`,
    // or `function createExecResult` would otherwise slip the guard.
    expect(source).not.toMatch(/\b(?:const|let|var)\s+createExecResult\s*=/);
    expect(source).not.toMatch(/\bfunction\s+createExecResult\s*\(/);
  });

  it("does not re-inline Buffer→string coercion for exec stdout/stderr", () => {
    expect(source).not.toMatch(/typeof\s+result\.(stdout|stderr)\s*===\s*["']string["']/);
  });
});
