import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { FakeTimer } from "../fakes/FakeTimer";

describe("ToolRegistry tool call duration recording", () => {
  let originalTimer: unknown;
  let originalToolCallRepository: unknown;
  let timer: FakeTimer;
  let records: any[];

  beforeEach(() => {
    ToolRegistry.clearTools();
    timer = new FakeTimer();
    originalTimer = (ToolRegistry as any).timer;
    originalToolCallRepository = (ToolRegistry as any).toolCallRepository;
    (ToolRegistry as any).timer = timer;
    records = [];
    (ToolRegistry as any).toolCallRepository = {
      async recordToolCall(record: any): Promise<void> {
        records.push(record);
      },
    };
  });

  afterEach(() => {
    (ToolRegistry as any).timer = originalTimer;
    (ToolRegistry as any).toolCallRepository = originalToolCallRepository;
    ToolRegistry.clearTools();
  });

  test("records elapsed duration for a completed tool call", async () => {
    ToolRegistry.registerDeviceAware(
      "durationProbe",
      "Measures tool call duration",
      z.object({
        sessionUuid: z.string().optional(),
      }),
      async () => ({ success: true }),
      false,
      false,
      {
        shouldEnsureDevice: () => false,
        nonDeviceHandler: async () => {
          timer.advanceTime(37);
          return { success: true };
        },
      }
    );

    const tool = ToolRegistry.getTool("durationProbe");
    expect(tool).toBeDefined();

    const response = await tool!.handler({ sessionUuid: "session-1" });

    expect(response).toEqual({ success: true });
    expect(records).toEqual([
      expect.objectContaining({
        toolName: "durationProbe",
        sessionUuid: "session-1",
        durationMs: 37,
      }),
    ]);
  });

  test("records elapsed duration when a tool call throws", async () => {
    ToolRegistry.registerDeviceAware(
      "durationFailureProbe",
      "Measures failed tool call duration",
      z.object({}),
      async () => ({ success: true }),
      false,
      false,
      {
        shouldEnsureDevice: () => false,
        nonDeviceHandler: async () => {
          timer.advanceTime(19);
          throw new Error("probe failed");
        },
      }
    );

    const tool = ToolRegistry.getTool("durationFailureProbe");
    expect(tool).toBeDefined();

    await expect(tool!.handler({})).rejects.toThrow("Failed to execute tool durationFailureProbe");
    expect(records).toEqual([
      expect.objectContaining({
        toolName: "durationFailureProbe",
        durationMs: 19,
      }),
    ]);
  });
});
