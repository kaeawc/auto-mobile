import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CtrlProxyHierarchy } from "../../src/features/observe/ios";
import { CtrlProxyHierarchy as CtrlProxyHierarchyDelegate } from "../../src/features/observe/ios/CtrlProxyHierarchy";

const baselinePath = join(import.meta.dir, "../../scripts/typecheck-baseline.txt");

describe("typecheck baseline burndown", () => {
  test("issue #3195 TS2300 and TS2305 clusters stay out of the baseline", () => {
    const baseline = readFileSync(baselinePath, "utf8");
    const forbiddenSignatures = [
      "src/features/observe/ios/IOSCtrlProxyClient.ts: error TS2300: Duplicate identifier 'CtrlProxyHierarchy'.",
      "src/features/observe/ios/index.ts: error TS2300: Duplicate identifier 'CtrlProxyHierarchy'.",
      "src/features/observe/android/index.ts: error TS2305: Module '\"./types\"' has no exported member 'AndroidHitTestResult'.",
      "src/features/observe/ios/CtrlProxyHierarchy.ts: error TS2305: Module '\"./types\"' has no exported member 'CachedHierarchy'.",
      "src/features/observe/ios/CtrlProxyHierarchy.ts: error TS2305: Module '\"./types\"' has no exported member 'XCTestHierarchy'.",
      "src/server/index.ts: error TS2305: Module '\"zod\"' has no exported member 'ZodError'.",
      "src/server/index.ts: error TS2305: Module '\"zod\"' has no exported member 'ZodIssue'.",
      "src/server/resourceRegistry.ts: error TS2305: Module '\"@modelcontextprotocol/sdk/types.js\"' has no exported member 'Resource'.",
      "src/server/resourceRegistry.ts: error TS2305: Module '\"@modelcontextprotocol/sdk/types.js\"' has no exported member 'ResourceTemplate'.",
      "src/server/resourceRegistry.ts: error TS2305: Module '\"@modelcontextprotocol/sdk/types.js\"' has no exported member 'SubscribeRequestSchema'.",
      "src/server/resourceRegistry.ts: error TS2305: Module '\"@modelcontextprotocol/sdk/types.js\"' has no exported member 'UnsubscribeRequestSchema'.",
      "src/server/toolRegistry.ts: error TS2305: Module '\"zod\"' has no exported member 'toJSONSchema'.",
      "src/utils/plan/PlanExecutor.ts: error TS2305: Module '\"zod\"' has no exported member 'ZodError'.",
    ];
    const filesExpectedClean = [
      "src/features/observe/android/index.ts:",
      "src/features/observe/ios/CtrlProxyHierarchy.ts:",
      "src/features/observe/ios/IOSCtrlProxyClient.ts:",
      "src/features/observe/ios/index.ts:",
      "src/server/index.ts:",
      "src/server/resourceRegistry.ts:",
      "src/server/toolRegistry.ts:",
      "src/utils/plan/PlanExecutor.ts:",
    ];

    expect(forbiddenSignatures.filter((signature) => baseline.includes(signature))).toEqual([]);
    expect(filesExpectedClean.filter((filePrefix) => baseline.includes(filePrefix))).toEqual([]);
  });

  test("iOS barrel keeps the CtrlProxyHierarchy delegate runtime export", () => {
    expect(CtrlProxyHierarchy).toBe(CtrlProxyHierarchyDelegate);
  });
});
