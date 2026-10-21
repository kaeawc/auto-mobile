import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseGuardSource } from "../lint/astGuard";
import { collectSourceFacts } from "../lint/sourceFacts";

// Guard for issue #3200: src/doctor/checks/iosDoctorDependencies.ts must not re-implement the
// canonical `createExecResult` (src/utils/execResult.ts) nor re-inline the
// Buffer→string coercion the canonical factory now owns (as of #3197). One
// canonical primitive per concern (CLAUDE.md). iosDoctorDependencies.ts now routes generic host
// execution through the shared HostCommandExecutor seam, whose runExecSeam path
// owns the canonical createExecResult, so it neither imports the factory
// directly nor touches child_process itself.
//
// Asserted over the parsed module (oxc AST), not source text, so comments,
// strings and formatting can neither satisfy nor trip the guard (#11867).
describe("ios doctor createExecResult consolidation (#3200)", () => {
  const file = join(import.meta.dir, "../../src/doctor/checks/iosDoctorDependencies.ts");
  const facts = collectSourceFacts(parseGuardSource(file, readFileSync(file, "utf8")));

  it("routes host execution through the canonical HostCommandExecutor seam", () => {
    // Delegating to the seam is what keeps exec-result coercion canonical
    // without iosDoctorDependencies.ts importing createExecResult or a raw child_process launcher.
    expect(
      facts.importedNames.some((name) =>
        /^DefaultHostCommandExecutor@.*HostCommandExecutor$/.test(name),
      ),
    ).toBe(true);
    expect(facts.moduleSpecifiers).not.toContain("node:child_process");
  });

  it("declares no local createExecResult factory", () => {
    // Every declaration form (const/let/var/function/class) at any depth.
    expect(facts.declaredNames).not.toContain("createExecResult");
  });

  it("does not re-inline Buffer→string coercion for exec stdout/stderr", () => {
    expect(facts.typeofComparisons).not.toContain("result.stdout===string");
    expect(facts.typeofComparisons).not.toContain("result.stderr===string");
  });
});
