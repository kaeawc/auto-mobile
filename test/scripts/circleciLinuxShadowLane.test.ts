import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { load } from "js-yaml";

interface CircleConfig {
  jobs?: Record<
    string,
    { executor?: string | { name: string }; docker?: { image: string }[]; resource_class?: string }
  >;
  workflows?: Record<string, { when?: string; jobs?: unknown[] }>;
}

const invokedJobs = (jobs: unknown[] = []) =>
  jobs.map((entry) => (typeof entry === "string" ? entry : Object.keys(entry as object)[0]!));

const read = (file: string) => readFileSync(resolve(import.meta.dir, "../..", file), "utf8");
const continued = load(read(".circleci/continue_config.yml")) as CircleConfig;
const linuxJobs = Object.keys(continued.jobs ?? {}).filter((name) => name.startsWith("linux-"));

test("Linux shadow jobs run in the run-linux workflow on the linux executor", () => {
  expect(linuxJobs.length).toBeGreaterThan(0);
  const workflow = continued.workflows?.["linux-pr"];
  expect(workflow?.when).toBe("<< pipeline.parameters.run-linux >>");
  const notPr = new Set(["linux-benchmark-context-thresholds", "linux-nightly-node"]);
  expect(invokedJobs(workflow?.jobs).sort()).toEqual(
    linuxJobs.filter((name) => !notPr.has(name)).sort(),
  );
  for (const name of linuxJobs) {
    const job = continued.jobs?.[name];
    if (job?.docker) {
      // A job-level image override (e.g. the -browsers variant) keeps the JDK line and size.
      expect(job.docker[0]?.image).toMatch(/^cimg\/openjdk:21\.0-/);
      expect(job.resource_class).toBe("large");
      continue;
    }
    const executor = job?.executor;
    expect(typeof executor === "string" ? executor : executor?.name).toBe("linux");
  }
});

test("the setup pipeline sets run-linux for any changed file", () => {
  expect(read(".circleci/config.yml")).toMatch(/^\s+\.\* run-linux true$/m);
});

test("Linux shadow jobs use no secrets or contexts", () => {
  const config = read(".circleci/continue_config.yml");
  expect(config).not.toMatch(/^\s+context:/m);
});

test("post-merge Linux jobs run in main-linux, gated and coalesced on main", () => {
  const workflow = continued.workflows?.["main-linux"];
  expect(workflow?.when).toBe("<< pipeline.parameters.run-main-linux >>");
  expect(invokedJobs(workflow?.jobs).sort()).toEqual([
    "linux-benchmark-context-thresholds",
    "linux-fast-validation",
    "linux-node-checks",
    "linux-node-host-integration-tests",
  ]);
  const mapping = read(".circleci/main-macos-paths.txt");
  expect(mapping).toContain("src/.* run-main-linux true");
  expect(mapping).toContain("\\.circleci/.* run-main-linux true");
});

test("the nightly Linux workflow is selected by its own setup job and parameter", () => {
  const workflow = continued.workflows?.["nightly-linux"];
  expect(workflow?.when).toBe("<< pipeline.parameters.run-nightly-linux >>");
  expect(invokedJobs(workflow?.jobs)).toEqual(["linux-nightly-node"]);
  const setup = read(".circleci/config.yml");
  expect(setup).toContain(`echo '{"run-nightly-linux":true}'`);
  expect(setup).toContain("<< pipeline.parameters.run-nightly-linux >>");
});
