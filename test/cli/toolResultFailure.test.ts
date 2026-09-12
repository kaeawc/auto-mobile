import { afterEach, describe, expect, test } from "bun:test";
import { DaemonVersionMismatchError } from "../../src/daemon/daemonMcpProxy";
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

  test("reports version skew as preflight rather than an interrupted tool", async () => {
    const messages: string[] = [];
    process.exit = (() => {}) as typeof process.exit;
    console.error = (...args: unknown[]) => {
      messages.push(args.join(" "));
    };
    setDaemonProxyFactoryForTesting((): any => ({
      callTool: async () => {
        throw new DaemonVersionMismatchError({
          clientVersion: "0.0.70",
          daemonVersion: "0.0.68",
          reason: "autoStartDisabled",
          detail: "auto-start is disabled",
        });
      },
      close: async () => {},
    }));
    await runCliCommand(["listDevices"]);
    expect(messages.join("\n")).toContain("Daemon preflight failed; no device operation started");
    expect(messages.join("\n")).toContain("daemon=0.0.68, client=0.0.70");
    expect(messages.join("\n")).not.toContain("became unavailable during tool execution");
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

describe("handleToolResult null/non-object payload guard (issue #6086)", () => {
  const originalProcessExit = process.exit;
  const originalConsoleError = console.error;
  const originalConsoleLog = console.log;

  afterEach(() => {
    process.exit = originalProcessExit;
    console.error = originalConsoleError;
    console.log = originalConsoleLog;
    resetDaemonProxyFactoryForTesting();
  });

  function runWithEnvelope(envelope: unknown): {
    exitCodes: number[];
    errorMessages: unknown[][];
  } {
    const exitCodes: number[] = [];
    const errorMessages: unknown[][] = [];
    process.exit = ((code?: number) => {
      exitCodes.push(code ?? 0);
    }) as typeof process.exit;
    console.error = ((...args: unknown[]) => {
      errorMessages.push(args);
    }) as typeof console.error;
    console.log = (() => {
      // silence structured stdout dump
    }) as typeof console.log;
    setDaemonProxyFactoryForTesting((): any => ({
      callTool: async () => envelope,
      close: async (): Promise<void> => {
        // no-op fake
      },
    }));
    return { exitCodes, errorMessages };
  }

  test("isError envelope with JSON-null payload surfaces the payload, not a TypeError", async () => {
    const { exitCodes, errorMessages } = runWithEnvelope({
      content: [{ type: "text", text: "null" }],
      isError: true,
    });

    await runCliCommand(["someTool"]);

    expect(exitCodes).toEqual([1]);
    expect(errorMessages).toEqual([["null"]]);
  });

  test("isError envelope with a JSON-primitive payload does not crash and exits non-zero", async () => {
    const { exitCodes, errorMessages } = runWithEnvelope({
      content: [{ type: "text", text: "42" }],
      isError: true,
    });

    await runCliCommand(["someTool"]);

    expect(exitCodes).toEqual([1]);
    expect(errorMessages).toEqual([["42"]]);
  });

  test("isError envelope with a missing content payload exits non-zero without throwing", async () => {
    const { exitCodes, errorMessages } = runWithEnvelope({ isError: true });

    await runCliCommand(["someTool"]);

    expect(exitCodes).toEqual([1]);
    expect(errorMessages).toEqual([]);
  });
});
