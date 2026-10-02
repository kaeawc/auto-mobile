import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadWorkflow, type WorkflowDefinition } from "../helpers/workflowSteps";

interface DependabotWorkflow extends WorkflowDefinition {
  on?: Record<string, { types?: string[]; paths?: string[] }>;
}

const workflow = loadWorkflow(
  ".github/workflows/dependabot-runtime-pins.yml",
) as DependabotWorkflow;
const regenerate = workflow.jobs?.regenerate;
const push = workflow.jobs?.push;
const regenerateSteps = regenerate?.steps ?? [];
const pushSteps = push?.steps ?? [];
const allSteps = [...regenerateSteps, ...pushSteps];
const commit = pushSteps.find((step) => step.name === "Commit and push runtime pins");
const upload = regenerateSteps.find((step) => step.uses?.startsWith("actions/upload-artifact@"));
const download = pushSteps.find((step) => step.uses?.startsWith("actions/download-artifact@"));
const script = readFileSync(
  join(import.meta.dir, "../../scripts/ci/commit-runtime-pins.sh"),
  "utf8",
);
const guard =
  "github.actor == 'dependabot[bot]' && github.event.pull_request.head.repo.full_name == github.repository";
const artifactName =
  "runtime-pins-${{ github.event.pull_request.number }}-${{ github.run_id }}-${{ github.run_attempt }}";

describe("Dependabot runtime pin refresh contract", () => {
  test("two guarded jobs handle only same-repository Dependabot dependency PRs", () => {
    expect(Object.keys(workflow.on ?? {})).toEqual(["pull_request"]);
    expect(workflow.on?.pull_request?.types).toEqual(["opened", "synchronize", "reopened"]);
    expect(workflow.on?.pull_request?.paths).toEqual(["package.json", "bun.lock"]);
    expect(Object.keys(workflow.jobs ?? {})).toEqual(["regenerate", "push"]);
    expect(push?.needs).toBe("regenerate");
    for (const job of [regenerate, push]) {
      // No always(): the default success() condition prevents a failed check
      // from uploading data or allowing the dependent push job to run.
      expect(job?.if).toBe(guard);
      expect(job?.["timeout-minutes"]).toBeGreaterThan(0);
      expect(job?.["runs-on"]).toBe("ubuntu-latest");
      expect(job?.permissions).toEqual({ contents: "read" });
      expect(job?.env).toBeUndefined();
    }
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow).not.toHaveProperty("env");
    expect(workflow.concurrency?.group).toBe(
      "dependabot-runtime-pins-${{ github.event.pull_request.number }}",
    );
    expect(workflow.concurrency?.["cancel-in-progress"]).toBe(true);
  });

  test("regeneration receives no secrets and all actions use exact SHA pins", () => {
    expect(JSON.stringify(regenerate)).not.toContain("secrets.");
    expect(JSON.stringify(regenerate)).not.toContain("AUTO_MOBILE_PR_TOKEN");
    for (const step of allSteps) {
      if (step.uses) {
        expect(step.uses).toMatch(/@[0-9a-f]{40}$/);
      }
    }
    expect(allSteps.filter((step) => step.uses).map((step) => step.uses)).toEqual([
      "actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803",
      "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6",
      "actions/upload-artifact@b7c566a772e6b6bfb58ed0dc250532a479d7789f",
      "actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803",
      "actions/download-artifact@37930b1c2abaa49bbe596cd826c3c89aef350131",
    ]);
    const checkout = regenerateSteps.find((step) => step.uses?.startsWith("actions/checkout@"));
    expect(checkout?.with?.ref).toBe("${{ github.event.pull_request.head.sha }}");
    for (const checkoutStep of allSteps.filter((step) =>
      step.uses?.startsWith("actions/checkout@"),
    )) {
      expect(checkoutStep.with?.["persist-credentials"]).toBe(false);
      expect(checkoutStep.with?.lfs).toBe(false);
      expect(checkoutStep.with).not.toHaveProperty("token");
    }
  });

  test("the push runner obtains only the trusted script and executes no PR code or caches", () => {
    expect(pushSteps).toHaveLength(3);
    const checkout = pushSteps.find((step) => step.uses?.startsWith("actions/checkout@"));
    expect(checkout?.with?.ref).toBe("${{ github.event.repository.default_branch }}");
    expect(checkout?.with?.["sparse-checkout"]).toBe("scripts/ci/commit-runtime-pins.sh");
    expect(checkout?.with?.["sparse-checkout-cone-mode"]).toBe(false);
    expect(checkout?.with?.path).toBe("trusted");
    expect(commit?.run).toBe("bash trusted/scripts/ci/commit-runtime-pins.sh");
    for (const step of pushSteps) {
      expect(step.uses ?? "").not.toMatch(
        /oven-sh\/setup-bun|actions\/cache|setup-auto-mobile-npm-package/,
      );
      expect(step.run ?? "").not.toMatch(/\b(?:bun|node|npm|install|build)\b/);
    }
    for (const step of allSteps) {
      expect(step.run ?? "").not.toMatch(
        /\$\{\{[^}]*github\.(?:head_ref|event\.pull_request\.head\.(?:ref|sha))/,
      );
    }
  });

  test("only one push step env receives the token", () => {
    expect(commit).toBeDefined();
    expect(pushSteps.at(-1)).toBe(commit);
    expect(allSteps.filter((step) => JSON.stringify(step).includes("secrets."))).toEqual([commit!]);
    expect(commit?.env).toEqual({
      TOKEN: "${{ secrets.AUTO_MOBILE_PR_TOKEN }}",
      HEAD_REF: "${{ github.event.pull_request.head.ref }}",
      HEAD_SHA: "${{ github.event.pull_request.head.sha }}",
      GITHUB_REPOSITORY: "${{ github.repository }}",
      PINS_DIR: "${{ github.workspace }}/runtime-pins",
    });
    const { env, ...rest } = commit!;
    expect(env?.TOKEN).toBe("${{ secrets.AUTO_MOBILE_PR_TOKEN }}");
    expect(JSON.stringify(rest)).not.toContain("secrets.");
    expect(JSON.stringify(workflow).match(/secrets\.AUTO_MOBILE_PR_TOKEN/g)).toHaveLength(1);
  });

  test("checks the regenerated graph before uploading exactly three files", () => {
    const write = regenerateSteps.find((step) => step.name === "Regenerate runtime pins");
    expect(write?.run?.trim().split("\n")).toEqual([
      "bun install",
      "bun run build",
      "bun scripts/release/pin-runtime-deps.ts --write",
      "bun install",
      "bun run format",
    ]);
    const check = regenerateSteps.find((step) => step.name === "Check runtime pins");
    expect(check?.run).toBe("bun scripts/release/pin-runtime-deps.ts --check");
    expect(regenerateSteps.indexOf(check!)).toBeGreaterThan(regenerateSteps.indexOf(write!));
    expect(regenerateSteps.indexOf(upload!)).toBeGreaterThan(regenerateSteps.indexOf(check!));
    expect(check?.if).toBeUndefined();
    expect(upload?.if).toBeUndefined();
    expect(upload?.with?.path).toBe("package.json\nbun.lock\nscripts/release/runtime-graph.json\n");
    expect(upload?.with?.["if-no-files-found"]).toBe("error");
    expect(upload?.with?.["retention-days"]).toBe(1);
    expect(upload?.with?.name).toBe(artifactName);
    expect(download?.with).toEqual({ name: artifactName, path: "runtime-pins" });
  });

  test("trusted git operations use isolated config and env-only auth without force or skip-ci", () => {
    expect(JSON.stringify(workflow) + script).not.toMatch(/--force|\+refs|\[skip ci\]/);
    expect(script).toContain('run_git push "$push_url" HEAD:refs/heads/"$HEAD_REF"');
    expect(script).toContain("git -c core.hooksPath=/dev/null -c core.fsmonitor=false");
    expect(script).toContain("-c protocol.ext.allow=never -c credential.helper=");
    expect(script).toContain("GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null");
    expect(script).toContain("GIT_TERMINAL_PROMPT=0");
    expect(script).toContain("export GIT_CONFIG_COUNT=1");
    expect(script).toContain("export GIT_CONFIG_KEY_0=http.https://github.com/.extraheader");
    expect(script).toContain('export GIT_CONFIG_VALUE_0="AUTHORIZATION: basic $auth"');
    expect(script).not.toContain("https://x-access-token:");
    expect(script).toContain("run_git init --quiet --template=");
    expect(script).toContain('run_git reset --quiet --mixed "$HEAD_SHA"');
    expect(script).not.toMatch(/run_git (?:checkout|config|add)/);
    expect(script).toContain('run_git hash-object -w --no-filters -- "$file"');
    expect(script).toContain('run_git update-index --add --cacheinfo "100644,$blob,$file"');
    // Every git operation goes through the single hardened invocation.
    expect(script.match(/^\s*git\s/gm)).toHaveLength(1);
  });
});
