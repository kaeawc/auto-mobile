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

  function registerProbe(
    handler = async (): Promise<{ success: boolean }> => ({ success: true }),
  ): void {
    ToolRegistry.registerDeviceAware(
      "postTimeoutProbe",
      "Resolves with success regardless of caller state",
      z.object({}),
      handler,
      { shouldEnsureDevice: () => false, nonDeviceHandler: handler },
    );
  }

  test("warns (not infos) when the caller's request already timed out", async () => {
    let resolveHandler: (() => void) | undefined;
    let markHandlerStarted: (() => void) | undefined;
    const handlerStarted = new Promise<void>((resolve) => {
      markHandlerStarted = resolve;
    });
    registerProbe(async () => {
      markHandlerStarted?.();
      await new Promise<void>((resolve) => {
        resolveHandler = resolve;
      });
      return { success: true };
    });
    const infoSpy = spyOn(logger, "info").mockImplementation(() => {});
    const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});

    try {
      const tool = ToolRegistry.getTool("postTimeoutProbe");
      expect(tool).toBeDefined();

      const request = new AbortController();
      const responsePromise = tool!.handler({}, undefined, request.signal);
      await handlerStarted;
      request.abort();
      resolveHandler?.();
      const response = await responsePromise;

      // The handler still returns its result (work already completed).
      expect(response).toEqual({ success: true });

      const resultWarn = warnSpy.mock.calls.find(
        ([msg]) => typeof msg === "string" && msg.includes("postTimeoutProbe result"),
      );
      expect(resultWarn).toBeDefined();
      expect(String(resultWarn![0])).toMatch(/timed out/i);

      const resultInfo = infoSpy.mock.calls.find(
        ([msg]) => typeof msg === "string" && msg.includes("postTimeoutProbe result"),
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
        ([msg]) => typeof msg === "string" && msg.includes("postTimeoutProbe result: success=true"),
      );
      expect(resultInfo).toBeDefined();

      const resultWarn = warnSpy.mock.calls.find(
        ([msg]) => typeof msg === "string" && msg.includes("postTimeoutProbe result"),
      );
      expect(resultWarn).toBeUndefined();
    } finally {
      infoSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });
});
