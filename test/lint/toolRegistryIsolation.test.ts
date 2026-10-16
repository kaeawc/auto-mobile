import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { scanToolRegistryIsolation } from "./toolRegistryIsolation";
import { typeScriptFiles, relativePosix } from "./astGuard";

const ROOT = path.join(import.meta.dir, "../..");
const BASELINE_FILE = path.join(import.meta.dir, "tool-registry-isolation-baseline.txt");
const BASELINE_CEILING = 94;
const TREE_SCAN_HOOK_TIMEOUT_MS = 30_000;
const UPDATE_COMMAND =
  "UPDATE_TOOL_REGISTRY_ISOLATION_BASELINE=1 bun test test/lint/toolRegistryIsolation.test.ts";
const FILE = "test/server/fixture.test.ts";
const IMPORT = 'import { registerObserveTools } from "../../src/server/observeTools";';

describe("production tool registry isolation scanner", () => {
  test.each([
    `${IMPORT}\nregisterObserveTools();`,
    'import { registerDeviceTools as register } from "../../src/server/deviceTools";\nregister();',
    `${IMPORT}\nbeforeAll(() => { registerObserveTools(); });`,
    'import { registerBarrierTools } from "../../src/server/barrierTools";\nregisterBarrierTools();',
    'import { registerExampleTool } from "../../src/server/exampleTool";\nregisterExampleTool();',
  ])("reports a called production registration: %s", (source) => {
    expect(scanToolRegistryIsolation(FILE, source)).toEqual([{ line: 2 }]);
  });
  test.each(["isolateToolRegistry", "isolateEmptyToolRegistry", "preserveToolRegistry"])(
    "accepts %s",
    (helper) => {
      expect(
        scanToolRegistryIsolation(
          FILE,
          `${IMPORT}\nimport { ${helper} as isolate } from "../helpers/withTemporaryTool";\nisolate(); registerObserveTools();`,
        ),
      ).toEqual([]);
    },
  );
  test.each([
    "function registerObserveTools() {} registerObserveTools();",
    `${IMPORT}\nconst unused = 1;`,
    'import type { registerObserveTools } from "../../src/server/observeTools";',
    'import { type registerObserveTools } from "../../src/server/observeTools";',
    'import { ToolRegistry } from "../../src/server/toolRegistry"; ToolRegistry.register("local");',
  ])("ignores local tools and non-calls: %s", (source) => {
    expect(scanToolRegistryIsolation(FILE, source)).toEqual([]);
  });
  test("resolves namespace imports and ignores called type-only imports", () => {
    expect(
      scanToolRegistryIsolation(
        FILE,
        'import * as tools from "../../src/server/observeTools";\ntools.registerObserveTools();',
      ),
    ).toEqual([{ line: 2 }]);
    expect(
      scanToolRegistryIsolation(
        FILE,
        'import type { registerObserveTools } from "../../src/server/observeTools"; registerObserveTools();',
      ),
    ).toEqual([]);
  });
  test("local shadows do not count as imported registration or isolation", () => {
    expect(
      scanToolRegistryIsolation(
        FILE,
        `${IMPORT}\nfunction run(registerObserveTools: F) { registerObserveTools(); }`,
      ),
    ).toEqual([]);
    expect(
      scanToolRegistryIsolation(
        FILE,
        `${IMPORT}\nimport { isolateToolRegistry } from "../helpers/withTemporaryTool";\nfunction run(isolateToolRegistry: F) { isolateToolRegistry(); registerObserveTools(); }`,
      ),
    ).toEqual([{ line: 3 }]);
  });
  test("an unused or local isolator does not exempt a file", () => {
    expect(
      scanToolRegistryIsolation(
        FILE,
        `${IMPORT}\nimport { isolateToolRegistry } from "../helpers/withTemporaryTool";\nregisterObserveTools();`,
      ),
    ).toEqual([{ line: 3 }]);
    expect(
      scanToolRegistryIsolation(
        FILE,
        `${IMPORT}\nfunction isolateToolRegistry() {} isolateToolRegistry(); registerObserveTools();`,
      ),
    ).toEqual([{ line: 2 }]);
  });
  test("fails on syntax errors", () => {
    expect(() => scanToolRegistryIsolation("broken.ts", "const =")).toThrow("broken.ts:");
  });
});

describe("production registrations stay within the isolation baseline", () => {
  let baseline: string[] = [];
  let found: string[] = [];
  let callSites: { file: string; line: number }[] = [];
  beforeAll(() => {
    callSites = typeScriptFiles(path.join(ROOT, "test"))
      .filter((file) => file.endsWith(".test.ts"))
      .flatMap((file) => {
        const relative = relativePosix(ROOT, file);
        return scanToolRegistryIsolation(relative, readFileSync(file, "utf8")).map((finding) => ({
          file: relative,
          ...finding,
        }));
      });
    found = [...new Set(callSites.map((call) => call.file))].sort();
    baseline = readFileSync(BASELINE_FILE, "utf8").split(/\r?\n/).filter(Boolean);
    if (process.env.UPDATE_TOOL_REGISTRY_ISOLATION_BASELINE === "1") {
      if (found.length > BASELINE_CEILING || found.some((file) => !baseline.includes(file))) {
        throw new Error(
          "Baseline updates may only shrink. Fix new offenders: call isolateToolRegistry() from test/helpers/withTemporaryTool.ts",
        );
      }
      writeFileSync(BASELINE_FILE, found.map((file) => `${file}\n`).join(""));
      const self = fileURLToPath(import.meta.url);
      writeFileSync(
        self,
        readFileSync(self, "utf8").replace(
          /BASELINE_CEILING = \d+;/,
          `BASELINE_CEILING = ${found.length};`,
        ),
      );
    }
    baseline = readFileSync(BASELINE_FILE, "utf8").split(/\r?\n/).filter(Boolean);
  }, TREE_SCAN_HOOK_TIMEOUT_MS);
  test("no new test registers production tools without isolation", () => {
    const added = callSites.filter((call) => !baseline.includes(call.file));
    if (added.length) {
      throw new Error(
        `Unisolated production tool registrations:\n${added.map((call) => `${call.file}:${call.line}`).join("\n")}\nFix: call isolateToolRegistry() from test/helpers/withTemporaryTool.ts`,
      );
    }
  });
  test("the baseline only shrinks and lists still-offending files", () => {
    const stale = baseline.filter((file) => !found.includes(file));
    if (stale.length) {
      throw new Error(`Stale isolation baseline:\n${stale.join("\n")}\nRun: ${UPDATE_COMMAND}`);
    }
    expect(baseline.length).toBe(BASELINE_CEILING);
    expect(found.length).toBeLessThanOrEqual(BASELINE_CEILING);
  });
  test("the baseline is sorted, unique and uses repo-relative POSIX paths", () => {
    expect(baseline).toEqual([...new Set(baseline)].sort());
    expect(
      baseline.filter(
        (file) => !file.startsWith("test/") || file.includes("\\") || !file.endsWith(".test.ts"),
      ),
    ).toEqual([]);
  });
});
