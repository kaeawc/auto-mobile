import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  runCliCommand,
  setDaemonProxyFactoryForTesting,
  resetDaemonProxyFactoryForTesting,
} from "../../src/cli";
import { DAEMON_TOOL_UNAVAILABLE_CODE } from "../../src/daemon/types";
import { isolateCliDataDir, type IsolatedCliDataDir } from "../helpers/cliDataDirIsolation";

/**
 * #10179: the CLI appended "Try: auto-mobile --daemon restart" to every `Unknown tool` text,
 * which is wrong for a tool the daemon registers but gates (debug-only, embedded-SDK-only,
 * plan-only): a restart cannot lift a gate. The proxy marks that error with the gate code.
 */
describe("CLI daemon tool errors (#10179)", () => {
  let isolatedCliDataDir: IsolatedCliDataDir;

  beforeEach(() => {
    isolatedCliDataDir = isolateCliDataDir();
  });

  afterEach(() => {
    resetDaemonProxyFactoryForTesting();
    isolatedCliDataDir.restore();
  });

  const failWith = async (error: Error): Promise<string> => {
    setDaemonProxyFactoryForTesting((): any => ({
      callTool: async (name: string): Promise<any> => {
        if (name === "listDevices") {
          throw error;
        }
        return { success: true };
      },
      adoptCliSessionLiveness: async (): Promise<string | undefined> => undefined,
      close: async (): Promise<void> => {
        // no-op fake
      },
    }));
    const exitSpy = spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      await runCliCommand(["listDevices"]);
      return errorSpy.mock.calls.map((args) => args.join(" ")).join("\n");
    } finally {
      errorSpy.mockRestore();
      exitSpy.mockRestore();
    }
  };

  test("a gated tool surfaces the gate reason with no restart hint", async () => {
    const reason = "Unknown tool: listDevices. --debug is disabled; start the daemon with --debug";
    const message = await failWith(
      Object.assign(new Error(`Daemon rejection: ${reason}`), {
        code: DAEMON_TOOL_UNAVAILABLE_CODE,
      }),
    );

    expect(message).toContain(reason);
    expect(message).not.toContain("--daemon restart");
  });

  test("an unmarked unknown tool keeps the restart hint", async () => {
    const message = await failWith(new Error("MCP error -32603: Unknown tool: listDevices"));

    expect(message).toContain("Unknown tool: listDevices");
    expect(message).toContain("Try: auto-mobile --daemon restart");
  });
});
