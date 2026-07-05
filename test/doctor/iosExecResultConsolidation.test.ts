import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Guard for issue #3200: src/doctor/checks/ios.ts must not re-implement the
// canonical `createExecResult` (src/utils/execResult.ts) nor re-inline the
// Buffer→string coercion the canonical factory now owns (as of #3197). One
// canonical primitive per concern (CLAUDE.md).
describe("ios doctor createExecResult consolidation (#3200)", () => {
  const source = readFileSync(
    join(import.meta.dir, "../../src/doctor/checks/ios.ts"),
    "utf8"
  );

  it("imports the canonical createExecResult from utils/execResult", () => {
    expect(source).toMatch(
      /import\s*\{[^}]*\bcreateExecResult\b[^}]*\}\s*from\s*["'][^"']*utils\/execResult["']/
    );
  });

  it("declares no local createExecResult factory", () => {
    expect(source).not.toMatch(/\bconst\s+createExecResult\s*=/);
  });

  it("does not re-inline Buffer→string coercion for exec stdout/stderr", () => {
    expect(source).not.toMatch(/typeof\s+result\.(stdout|stderr)\s*===\s*["']string["']/);
  });
});
