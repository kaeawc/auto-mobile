import { afterEach, describe, expect, test } from "bun:test";
import {
  runCliCommand,
  setDaemonProxyFactoryForTesting,
  resetDaemonProxyFactoryForTesting,
  type CliOutput,
} from "../../src/cli";
import { DEVICE_SESSION_ACQUISITION_TOOLS } from "../../src/server/deviceSessionResult";

/**
 * `--session-uuid` is advertised as a universal CLI option, but the acquisition
 * tools MINT a session rather than joining one and their schemas are
 * `.strict()`, so folding the flag into their params made every
 * `--session-uuid ... getAndroid` invocation fail with
 * `Unrecognized key: "sessionUuid"`. The CLI must not route a session into a
 * tool that mints one.
 */
describe("CLI --session-uuid with device-session acquisition tools", () => {
  const calls: Array<{ toolName: string; params: Record<string, unknown> }> = [];

  afterEach(() => {
    calls.length = 0;
    resetDaemonProxyFactoryForTesting();
  });

  const installFakeProxy = (): void => {
    setDaemonProxyFactoryForTesting((): any => ({
      callTool: async (toolName: string, params: Record<string, unknown>): Promise<any> => {
        calls.push({ toolName, params });
        return { success: true };
      },
      close: async (): Promise<void> => {
        // no-op fake
      },
    }));
  };

  test.each(DEVICE_SESSION_ACQUISITION_TOOLS)(
    "does not inject sessionUuid into %s params",
    async (toolName) => {
      installFakeProxy();
      await runCliCommand(["--session-uuid", "session-abc", toolName]);
      expect(calls).toHaveLength(1);
      expect(calls[0].toolName).toBe(toolName);
      expect(calls[0].params).not.toHaveProperty("sessionUuid");
    },
  );

  test("still injects sessionUuid for a non-acquisition tool", async () => {
    installFakeProxy();
    await runCliCommand(["--session-uuid", "session-abc", "observe"]);
    expect(calls).toHaveLength(1);
    expect(calls[0].params.sessionUuid).toBe("session-abc");
  });

  test("help says acquisition tools mint their own session", async () => {
    const lines: string[] = [];
    const output: CliOutput = { log: (message) => lines.push(message), error: () => {} };
    await runCliCommand(["help"], undefined, output);
    const help = lines.join("\n");
    expect(help).toContain("mint their own session");
  });
});
