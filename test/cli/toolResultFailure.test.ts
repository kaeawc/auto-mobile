import { afterEach, describe, expect, test } from "bun:test";
import {
  isCliToolFailure,
  resetDaemonProxyFactoryForTesting,
  runCliCommand,
  setDaemonProxyFactoryForTesting,
} from "../../src/cli";

describe("isCliToolFailure (issue #6017)", () => {
  const originalProcessExit = process.exit;

  afterEach(() => {
    process.exit = originalProcessExit;
    resetDaemonProxyFactoryForTesting();
  });

  test("recognizes an in-band session ownership error envelope", () => {
    expect(
      isCliToolFailure({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: {
                code: "session_ownership_lost",
                message: "Session ownership lost for session-123: heartbeat-timeout",
              },
            }),
          },
        ],
        isError: true,
      }),
    ).toBe(true);
  });

  test("recognizes an MCP protocol error response", () => {
    expect(
      isCliToolFailure({
        content: [{ type: "text", text: "MCP error -32001: Request timed out" }],
        isError: true,
      }),
    ).toBe(true);
  });

  test("keeps successful responses successful", () => {
    expect(
      isCliToolFailure({
        content: [{ type: "text", text: JSON.stringify({ success: true }) }],
      }),
    ).toBe(false);
  });

  test("preserves legacy success false response detection", () => {
    expect(
      isCliToolFailure({
        content: [{ type: "text", text: JSON.stringify({ success: false }) }],
      }),
    ).toBe(true);
  });

  test("exits non-zero for an MCP error response", async () => {
    const exitCodes: number[] = [];
    process.exit = ((code?: number) => {
      exitCodes.push(code ?? 0);
    }) as typeof process.exit;
    setDaemonProxyFactoryForTesting((): any => ({
      callTool: async () => ({
        content: [{ type: "text", text: "MCP error -32001: Request timed out" }],
        isError: true,
      }),
      close: async (): Promise<void> => {
        // no-op fake
      },
    }));

    await runCliCommand(["observe"]);

    expect(exitCodes).toEqual([1]);
  });
});
