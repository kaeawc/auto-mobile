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

  const clientCases = [
    {
      name: "plain text",
      response: { content: [{ type: "text", text: "plain success" }] },
      logged: undefined,
    },
    {
      name: "malformed JSON",
      response: { content: [{ type: "text", text: '{"success":tr' }] },
      logged: undefined,
    },
    {
      name: "image only",
      response: { content: [{ type: "image", data: "synthetic", mimeType: "image/png" }] },
      logged: undefined,
    },
    {
      name: "JSON without success",
      response: { content: [{ type: "text", text: '{"enabled":true}' }] },
      logged: undefined,
    },
    {
      name: "structured without success",
      response: { structuredContent: { updatedAt: 0 } },
      logged: undefined,
    },
    {
      name: "JSON success",
      response: { content: [{ type: "text", text: '{"success":true}' }] },
      logged: "success=true",
    },
    {
      name: "JSON failure",
      response: {
        content: [{ type: "text", text: '{"success":false,"error":"original failure"}' }],
      },
      logged: "success=false",
    },
    {
      name: "isError plain text",
      response: { isError: true, content: [{ type: "text", text: "Error: original failure" }] },
      logged: undefined,
    },
    {
      name: "isError failure payload",
      response: {
        isError: true,
        content: [{ type: "text", text: '{"success":false,"error":"original failure"}' }],
      },
      logged: "success=false",
    },
    {
      name: "structured success",
      response: { structuredContent: { success: true } },
      logged: "success=true",
    },
    {
      name: "structured failure",
      response: { structuredContent: { success: false, error: "original failure" } },
      logged: "success=false",
    },
  ];
  for (const fixture of clientCases) {
    test(`client logging preserves ${fixture.name}`, async () => {
      const handler = async () => fixture.response;
      ToolRegistry.registerDeviceAware(
        "postTimeoutProbe",
        "synthetic envelope",
        z.object({}),
        handler,
        {
          shouldEnsureDevice: () => false,
          nonDeviceHandler: handler,
        },
      );
      const info = spyOn(logger, "info").mockImplementation(() => {});
      const warn = spyOn(logger, "warn").mockImplementation(() => {});
      const error = spyOn(logger, "error").mockImplementation(() => {});
      try {
        const response = await ToolRegistry.getTool("postTimeoutProbe")!.handler({});
        expect(response).toEqual(fixture.response);
        const resultLogs = [...info.mock.calls, ...warn.mock.calls, ...error.mock.calls]
          .map(([message]) => String(message))
          .filter((message) => message.includes("postTimeoutProbe result:"));
        if (fixture.logged) {
          expect(resultLogs).toHaveLength(1);
          expect(resultLogs[0]).toContain(fixture.logged);
          if (fixture.logged === "success=false") {
            expect(resultLogs[0]).toContain("original failure");
          }
        } else {
          expect(resultLogs).toEqual([]);
        }
      } finally {
        info.mockRestore();
        warn.mockRestore();
        error.mockRestore();
      }
    });
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
