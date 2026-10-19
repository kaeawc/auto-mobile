import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { scanToolRegistryIsolation } from "./toolRegistryIsolation";
import { typeScriptFiles, relativePosix } from "./astGuard";

const ROOT = path.join(import.meta.dir, "../..");
const TREE_SCAN_HOOK_TIMEOUT_MS = 30_000;
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

describe("production tool registrations are isolated in tests", () => {
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
  }, TREE_SCAN_HOOK_TIMEOUT_MS);
  test("no test registers production tools without isolation", () => {
    if (callSites.length) {
      throw new Error(
        `Unisolated production tool registrations:\n${callSites.map((call) => `${call.file}:${call.line}`).join("\n")}\nFix: call isolateToolRegistry() from test/helpers/withTemporaryTool.ts`,
      );
    }
  });
});
