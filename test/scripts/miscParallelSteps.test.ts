import { describe, expect, test } from "bun:test";
import { indexOfNamed, indexOfWaitOn, loadJobSteps, stepNamed } from "../helpers/workflowSteps";

// Guards issue #4130: the remaining parallel-steps wins.
//
//  7d The two cache restores in `mcp-build-and-test` and `ts-code-coverage` hit
//     disjoint paths (~/.bun/install/cache + node_modules vs .turbo), so they
//     overlap each other. The barrier MUST precede `Setup Auto Mobile`: that
//     composite runs `turbo run build`, which reads and writes the same .turbo
//     directory the cache restores — racing them would miss or corrupt it.
//  7e hadolint pulls a Docker image and has no consumer, so it is hoisted to
//     just after checkout and joined at the end of the job. A failure then
//     surfaces at the barrier instead of vanishing.
//  7b/7c In deploy-docs, Setup Python and Install uv are mutually independent
//     (uv ships a standalone binary), and the two badge downloads are distinct
//     artifacts. The badge downloads must stay AFTER `Build documentation` —
//     mkdocs regenerates/cleans site/, which would delete a badge landing early.

const PR_WORKFLOW = ".github/workflows/pull_request.yml";
const DOCS_WORKFLOW = ".github/workflows/docs.yml";

for (const jobId of ["mcp-build-and-test", "ts-code-coverage"]) {
  describe(`#4130 cache fan-out (${jobId})`, () => {
    const steps = loadJobSteps(PR_WORKFLOW, jobId);

    test("the job exists and has steps", () => {
      expect(steps.length).toBeGreaterThan(0);
    });

    test("both cache restores are backgrounded with ids", () => {
      const bun = stepNamed(steps, "Cache Bun dependencies");
      expect(bun?.background).toBe(true);
      expect(bun?.id).toBe("cache-bun");

      const turbo = stepNamed(steps, "Cache Turborepo");
      expect(turbo?.background).toBe(true);
      expect(turbo?.id).toBe("cache-turbo");
    });

    test("one barrier covers both and precedes Setup Auto Mobile", () => {
      // Load-bearing: the composite runs `turbo run build` against .turbo.
      const waitBun = indexOfWaitOn(steps, "cache-bun");
      const waitTurbo = indexOfWaitOn(steps, "cache-turbo");
      const setupIndex = indexOfNamed(steps, "Setup Auto Mobile");

      expect(waitBun).toBeGreaterThanOrEqual(0);
      expect(waitBun).toBe(waitTurbo);
      expect(setupIndex).toBeGreaterThanOrEqual(0);
      expect(waitBun).toBeLessThan(setupIndex);
    });
  });
}

describe("#4130 hadolint hoist (fast-validation)", () => {
  const steps = loadJobSteps(PR_WORKFLOW, "fast-validation");

  test("the job exists and has steps", () => {
    expect(steps.length).toBeGreaterThan(0);
  });

  test("hadolint is backgrounded with an id and hoisted above the real work", () => {
    const hadolint = stepNamed(steps, "Run hadolint");
    expect(hadolint?.background).toBe(true);
    expect(hadolint?.id).toBe("hadolint");

    // Hoisted so its image pull overlaps the whole job.
    const hadolintIndex = indexOfNamed(steps, "Run hadolint");
    const checksIndex = indexOfNamed(steps, "Run fast validation checks");
    expect(hadolintIndex).toBeLessThan(checksIndex);
  });

  test("the hadolint barrier comes after the job's real work, so a failure still surfaces", () => {
    const waitIndex = indexOfWaitOn(steps, "hadolint");
    const checksIndex = indexOfNamed(steps, "Run fast validation checks");
    const batsIndex = indexOfNamed(steps, "Run BATS Tests (Ubuntu)");

    expect(waitIndex).toBeGreaterThanOrEqual(0);
    expect(waitIndex).toBeGreaterThan(checksIndex);
    expect(waitIndex).toBeGreaterThan(batsIndex);
  });

  test("the documentation lock validation toolchain is ready before fast checks", () => {
    const python = stepNamed(steps, "Setup Python for documentation lock validation");
    const uv = stepNamed(steps, "Install uv for documentation lock validation");
    const waitIndex = indexOfWaitOn(steps, "setup-python-lock");
    const checks = stepNamed(steps, "Run fast validation checks");

    expect(python?.background).toBe(true);
    expect(python?.id).toBe("setup-python-lock");
    expect(uv?.background).toBe(true);
    expect(uv?.id).toBe("setup-uv-lock");
    expect(waitIndex).toBeGreaterThanOrEqual(0);
    expect(waitIndex).toBe(indexOfWaitOn(steps, "setup-uv-lock"));
    expect(waitIndex).toBeLessThan(indexOfNamed(steps, "Run fast validation checks"));
    expect(checks?.run).toContain("github-python-lock");
  });
});

describe("#4130 deploy-docs fan-outs (docs.yml)", () => {
  const steps = loadJobSteps(DOCS_WORKFLOW, "deploy-docs");

  test("the job exists and has steps", () => {
    expect(steps.length).toBeGreaterThan(0);
  });

  test("Python and uv setups are backgrounded and joined before uv sync", () => {
    expect(stepNamed(steps, "Setup Python")?.background).toBe(true);
    expect(stepNamed(steps, "Setup Python")?.id).toBe("setup-python");
    expect(stepNamed(steps, "Install uv")?.background).toBe(true);
    expect(stepNamed(steps, "Install uv")?.id).toBe("setup-uv");

    const waitPython = indexOfWaitOn(steps, "setup-python");
    const waitUv = indexOfWaitOn(steps, "setup-uv");
    const mkdocsIndex = indexOfNamed(steps, "Install MkDocs and dependencies");

    expect(waitPython).toBeGreaterThanOrEqual(0);
    expect(waitPython).toBe(waitUv);
    expect(waitPython).toBeLessThan(mkdocsIndex);
  });

  test("the documentation install enforces the committed lockfile", () => {
    expect(stepNamed(steps, "Install MkDocs and dependencies")?.run).toBe("uv sync --locked");
  });

  test("the badge downloads are backgrounded and joined before Setup Pages", () => {
    expect(stepNamed(steps, "Download Kotlin Coverage Badge")?.background).toBe(true);
    expect(stepNamed(steps, "Download Swift Coverage Badge")?.background).toBe(true);

    const waitKotlin = indexOfWaitOn(steps, "dl-kotlin-badge");
    const waitSwift = indexOfWaitOn(steps, "dl-swift-badge");
    const pagesIndex = indexOfNamed(steps, "Setup Pages");

    expect(waitKotlin).toBeGreaterThanOrEqual(0);
    expect(waitKotlin).toBe(waitSwift);
    expect(waitKotlin).toBeLessThan(pagesIndex);
  });

  test("the badge downloads stay AFTER Build documentation", () => {
    // mkdocs regenerates/cleans site/, so a badge landing earlier is deleted.
    const buildIndex = indexOfNamed(steps, "Build documentation");
    const kotlinIndex = indexOfNamed(steps, "Download Kotlin Coverage Badge");
    const swiftIndex = indexOfNamed(steps, "Download Swift Coverage Badge");

    expect(buildIndex).toBeGreaterThanOrEqual(0);
    expect(kotlinIndex).toBeGreaterThan(buildIndex);
    expect(swiftIndex).toBeGreaterThan(buildIndex);
  });
});
