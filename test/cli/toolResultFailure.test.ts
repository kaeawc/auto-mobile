import { afterEach, describe, expect, test } from "bun:test";
import {
  isCliToolFailure,
  resetDaemonProxyFactoryForTesting,
  runCliCommand,
  setDaemonProxyFactoryForTesting,
} from "../../src/cli";

describe("isCliToolFailure (issue #6017)", () => {
  const originalProcessExit = process.exit;
  const originalConsoleError = console.error;

  afterEach(() => {
    process.exit = originalProcessExit;
    console.error = originalConsoleError;
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

  test("prints an MCP error without executePlan diagnostics and exits non-zero", async () => {
    const exitCodes: number[] = [];
    const errorMessages: unknown[][] = [];
    process.exit = ((code?: number) => {
      exitCodes.push(code ?? 0);
    }) as typeof process.exit;
    console.error = ((...args: unknown[]) => {
      errorMessages.push(args);
    }) as typeof console.error;
    setDaemonProxyFactoryForTesting((): any => ({
      callTool: async () => ({
        content: [{ type: "text", text: "MCP error -32001: Request timed out" }],
        isError: true,
      }),
      close: async (): Promise<void> => {
        // no-op fake
      },
    }));

    await runCliCommand(["executePlan"]);

    expect(exitCodes).toEqual([1]);
    expect(errorMessages).toEqual([["MCP error -32001: Request timed out"]]);
  });
});
