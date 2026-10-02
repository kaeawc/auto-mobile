import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const lines = readFileSync(resolve(root, "scripts/unit-test-device-spawn-allowlist.txt"), "utf8")
  .replace(/\r?\n$/, "")
  .split(/\r?\n/);
const entries = lines.slice(1);

test("device-spawn allow-list has a header and sorted unique entries without blank lines", () => {
  expect(lines[0]?.startsWith("# ")).toBe(true);
  expect(entries).toEqual(
    [...new Set(entries)].sort((left, right) =>
      Buffer.compare(Buffer.from(left), Buffer.from(right)),
    ),
  );
  expect(entries.every((entry) => entry.length > 0)).toBe(true);
});

test("device-spawn allow-list only contains existing repo-relative unit test files", () => {
  for (const entry of entries) {
    expect(entry.startsWith("test/")).toBe(true);
    expect(entry.endsWith(".test.ts")).toBe(true);
    expect(entry.endsWith(".integration.test.ts")).toBe(false);
    expect(entry.startsWith("test/stress/")).toBe(false);
    expect(entry.split("/").some((part) => ["", ".", ".."].includes(part))).toBe(false);
    expect(entry.includes("\\")).toBe(false);
    expect(existsSync(resolve(root, entry))).toBe(true);
  }
});

// Frozen at the initial guard rollout: removals are welcome, additions need fakes.
const initialAllowList = [
  "test/plan/planExecutorInternalNoDiffE2E.test.ts",
  "test/server/deviceTools.killDevice.test.ts",
  "test/server/deviceTools.provisionDevice.test.ts",
  "test/server/index.progress.test.ts",
  "test/server/initialization.test.ts",
  "test/server/internalTimeoutParamProvenance.test.ts",
  "test/server/navigationBuildLensResources.test.ts",
  "test/server/nonFiniteReviveHandler.test.ts",
  "test/server/ping.test.ts",
  "test/server/planExecutionLock.test.ts",
  "test/server/prompts/list.test.ts",
  "test/server/resources/bootedDevices.test.ts",
  "test/server/resources/list.test.ts",
  "test/server/resources/navigationGraph.test.ts",
  "test/server/templates/list.test.ts",
  "test/server/toolCallDispatchParity.test.ts",
  "test/server/toolSchemaStrictness.test.ts",
  "test/server/tools/anthropicInputSchemaSubset.test.ts",
  "test/server/tools/registry.test.ts",
  "test/server/tools/structuredContentGating.test.ts",
] as const;

function addedEntries(entries: readonly string[], snapshot: readonly string[]): string[] {
  const allowed = new Set(snapshot);
  return entries.filter((entry) => !allowed.has(entry));
}

test("device-spawn allow-list may only shrink from its initial snapshot", () => {
  expect(
    addedEntries(entries, initialAllowList),
    "Inject FakeProcessExecutor / fake adb executor instead of extending the device-spawn allow-list",
  ).toEqual([]);
});

test("allow-list ratchet detects an extra entry", () => {
  expect(
    addedEntries([...initialAllowList, "test/new-device-spawner.test.ts"], initialAllowList),
  ).toEqual(["test/new-device-spawner.test.ts"]);
});

test("allow-list ratchet accepts a removed entry", () => {
  expect(addedEntries(initialAllowList.slice(1), initialAllowList)).toEqual([]);
});
