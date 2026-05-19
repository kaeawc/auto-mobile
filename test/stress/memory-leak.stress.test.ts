import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  createStressHarness,
  runStressOperations
} from "../../scripts/memory/stress-harness";
import { serverConfig } from "../../src/utils/ServerConfig";

const supportsGc = typeof global.gc === "function";
const memoryLimitBytes = 20 * 1024 * 1024;

describe("MCP Server Memory Leak Tests", () => {
  // The audit defaults to enabled; in the stress loop it runs a full DB-backed
  // performance audit per observe, which is orthogonal to what this test is
  // measuring (memory growth of the observe + interaction path) and pushes the
  // 200-iteration loop past the test timeout on slower CI runners.
  let originalUiPerfMode = true;

  beforeEach(() => {
    originalUiPerfMode = serverConfig.isUiPerfModeEnabled();
    serverConfig.setUiPerfMode(false);
  });

  afterEach(() => {
    serverConfig.setUiPerfMode(originalUiPerfMode);
  });

  test("should not leak during high-frequency observe and interaction cycles", async () => {
    const harness = await createStressHarness();

    try {
      if (supportsGc) {
        global.gc();
      }
      const startUsage = process.memoryUsage().heapUsed;

      await runStressOperations(harness, {
        iterations: 200,
        opsPerSecond: 0,
        operations: ["observe", "tapOn", "swipeOn", "inputText"],
        gcEvery: 0
      });

      if (supportsGc) {
        global.gc();
      }
      const endUsage = process.memoryUsage().heapUsed;

      if (supportsGc) {
        expect(endUsage - startUsage).toBeLessThan(memoryLimitBytes);
      }
    } finally {
      await harness.cleanup();
    }
  });
});
