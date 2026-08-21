import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { z } from "zod/v4";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { logger } from "../../src/utils/logger";

/**
 * Issue #2723: when a slow tool (e.g. openLink) resolves after the caller's
 * request already timed out, the result must not be logged as a bare
 * contradictory `success=true`. The registry inspects the request AbortSignal
 * and routes the late result through logger.warn instead.
 */
describe("ToolRegistry post-timeout result logging", () => {
  beforeEach(() => {
    ToolRegistry.clearTools();
  });

  afterEach(() => {
    ToolRegistry.clearTools();
  });

  function registerProbe(): void {
    ToolRegistry.registerDeviceAware("postTimeoutProbe", "Resolves with success regardless of caller state", z.object({}), async () => ({ success: true }), { shouldEnsureDevice: () => false,
      nonDeviceHandler: async () => ({ success: true }), });
  }

  test("warns (not infos) when the caller's request already timed out", async () => {
    registerProbe();
    const infoSpy = spyOn(logger, "info").mockImplementation(() => {});
    const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});

    try {
      const tool = ToolRegistry.getTool("postTimeoutProbe");
      expect(tool).toBeDefined();

      const response = await tool!.handler({}, undefined, AbortSignal.abort());

      // The handler still returns its result (work already completed).
      expect(response).toEqual({ success: true });

      const resultWarn = warnSpy.mock.calls.find(
        ([msg]) => typeof msg === "string" && msg.includes("postTimeoutProbe result")
      );
      expect(resultWarn).toBeDefined();
      expect(String(resultWarn![0])).toMatch(/timed out/i);

      const resultInfo = infoSpy.mock.calls.find(
        ([msg]) => typeof msg === "string" && msg.includes("postTimeoutProbe result")
      );
      expect(resultInfo).toBeUndefined();
    } finally {
      infoSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  test("infos as usual when the caller is still waiting", async () => {
    registerProbe();
    const infoSpy = spyOn(logger, "info").mockImplementation(() => {});
    const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});

    try {
      const tool = ToolRegistry.getTool("postTimeoutProbe");
      const response = await tool!.handler({}, undefined, new AbortController().signal);

      expect(response).toEqual({ success: true });

      const resultInfo = infoSpy.mock.calls.find(
        ([msg]) => typeof msg === "string" && msg.includes("postTimeoutProbe result: success=true")
      );
      expect(resultInfo).toBeDefined();

      const resultWarn = warnSpy.mock.calls.find(
        ([msg]) => typeof msg === "string" && msg.includes("postTimeoutProbe result")
      );
      expect(resultWarn).toBeUndefined();
    } finally {
      infoSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });
});
