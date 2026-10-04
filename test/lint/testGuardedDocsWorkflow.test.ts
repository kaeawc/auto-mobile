import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { load } from "js-yaml";

interface Workflow {
  jobs: Record<
    string,
    {
      if?: string;
      steps: { id?: string; with?: { script?: string } }[];
    }
  >;
}

const workflow = load(
  readFileSync(join(import.meta.dir, "../../.github/workflows/pull_request.yml"), "utf8"),
) as Workflow;
const guardedDoc = "docs/using/screen-control.md";

async function classify(
  stepId: string,
  filenames: string[],
  scriptOverride?: string,
): Promise<Record<string, string>> {
  const script =
    scriptOverride ??
    workflow.jobs["detect-changes"].steps.find((step) => step.id === stepId)?.with?.script;
  if (!script) {
    throw new Error(`Missing classifier script ${stepId}`);
  }
  const files = filenames.map((filename) => ({ filename }));
  const pr = {
    title: "chore: update docs",
    head: { ref: "auto-update/docs", repo: { full_name: "kaeawc/auto-mobile" } },
  };
  // Execute the YAML-owned scripts with fake GitHub data: no network or Actions runner.
  const github = {
    rest: {
      pulls: {
        listFiles: async () => ({ data: files }),
        get: async () => ({ data: pr }),
      },
    },
    paginate: async () => files,
  };
  const context = {
    issue: { number: 1 },
    repo: { owner: "kaeawc", repo: "auto-mobile" },
    payload: { pull_request: { labels: [{ name: "automated" }, { name: "documentation" }] } },
  };
  const outputs: Record<string, string> = {};
  const core = {
    setOutput: (key: string, value: string) => {
      outputs[key] = value;
    },
  };
  const run = new Function(
    "github",
    "context",
    "core",
    "console",
    `return (async () => {\n${script}\n})();`,
  );
  await run(github, context, core, { log: () => {} });
  return outputs;
}

describe("contract-bearing docs keep their Node test guard in CI", () => {
  for (const [step, output] of [
    ["filter", "docs_only"],
    ["check-auto-chore", "auto_chore"],
  ]) {
    test(`${step} runs code gates for the guarded page alone or with ordinary docs`, async () => {
      expect((await classify(step, [guardedDoc]))[output]).toBe("false");
      expect((await classify(step, ["docs/using/overview.md", guardedDoc]))[output]).toBe("false");
    });
    test(`${step} preserves ordinary docs-only and empty-change classification`, async () => {
      expect((await classify(step, ["docs/using/overview.md", "README.md"]))[output]).toBe("true");
      expect((await classify(step, []))[output]).toBe("false");
      expect((await classify(step, ["src/daemon/socketServer.ts"]))[output]).toBe("false");
    });
    test(`${step} negative control would skip the page without its exemption`, async () => {
      const script = workflow.jobs["detect-changes"].steps.find((item) => item.id === step)?.with
        ?.script;
      if (!script) {
        throw new Error(`Missing classifier script ${step}`);
      }
      // Remove just the known path, then prove the broken script skips the guard.
      expect(script).toContain(JSON.stringify(guardedDoc));
      const broken = script.replace(JSON.stringify(guardedDoc), '"docs/unused.md"');
      expect((await classify(step, [guardedDoc], broken))[output]).toBe("true");
    });
  }

  test("Node unit test skip still depends on the guarded docs-only output", () => {
    expect(workflow.jobs["node-unit-tests"].if).toContain(
      "needs.detect-changes.outputs.docs_only != 'true'",
    );
  });
});
