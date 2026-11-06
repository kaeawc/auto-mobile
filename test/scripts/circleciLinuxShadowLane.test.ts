import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { load } from "js-yaml";

interface CircleConfig {
  jobs?: Record<string, { executor?: string | { name: string } }>;
  workflows?: Record<string, { when?: string; jobs?: unknown[] }>;
}

const read = (file: string) => readFileSync(resolve(import.meta.dir, "../..", file), "utf8");
const continued = load(read(".circleci/continue_config.yml")) as CircleConfig;
const linuxJobs = Object.keys(continued.jobs ?? {}).filter((name) => name.startsWith("linux-"));

test("Linux shadow jobs run in the run-linux workflow on the linux executor", () => {
  expect(linuxJobs.length).toBeGreaterThan(0);
  const workflow = continued.workflows?.["linux-pr"];
  expect(workflow?.when).toBe("<< pipeline.parameters.run-linux >>");
  const invoked = (workflow?.jobs ?? []).map((entry) =>
    typeof entry === "string" ? entry : Object.keys(entry as object)[0],
  );
  expect(invoked.sort()).toEqual([...linuxJobs].sort());
  for (const name of linuxJobs) {
    const executor = continued.jobs?.[name]?.executor;
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
