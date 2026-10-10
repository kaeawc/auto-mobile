import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  runCliCommand,
  setDaemonProxyFactoryForTesting,
  resetDaemonProxyFactoryForTesting,
} from "../../../src/cli";
import { isolateCliDataDir, type IsolatedCliDataDir } from "../../helpers/cliDataDirIsolation";

/**
 * `--session-uuid "$SESSION"` with an unset/empty variable names no session. The flag was given
 * explicitly, so the call must be refused rather than silently run sessionless: a sessionless
 * control call is anonymous and may act on (or acquire) a device the caller never meant to touch.
 */
describe("hunt: an explicit but empty --session-uuid is not silently dropped", () => {
  const calls: Array<{ toolName: string; params: Record<string, unknown> }> = [];
  let isolated: IsolatedCliDataDir;

  beforeEach(() => {
    isolated = isolateCliDataDir("cli-empty-session-uuid-");
    setDaemonProxyFactoryForTesting((): any => ({
      callTool: async (toolName: string, params: Record<string, unknown>): Promise<any> => {
        calls.push({ toolName, params });
        return toolName === "setToolEnabled"
          ? {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({ sessionUuid: "11111111-1111-4111-8111-111111111111" }),
                },
              ],
            }
          : { success: true };
      },
      adoptCliSessionLiveness: async (): Promise<string | undefined> => undefined,
      close: async (): Promise<void> => {},
    }));
  });

  afterEach(() => {
    calls.length = 0;
    resetDaemonProxyFactoryForTesting();
    isolated.restore();
  });

  test.each([[["--session-uuid", "", "tapOn", "--text", "OK"]], [["--session-uuid", "", "observe"]]])(
    "%j exits 1 and makes no tool call",
    async (args) => {
      const exits: unknown[] = [];
      const stop = new Error("fake exit");
      const exit = spyOn(process, "exit").mockImplementation((code) => {
        exits.push(code);
        throw stop;
      });
      const err = spyOn(console, "error").mockImplementation(() => {});
      const out = spyOn(console, "log").mockImplementation(() => {});
      try {
        await runCliCommand(args).catch((error: unknown) => {
          if (error !== stop) {
            throw error;
          }
        });
      } finally {
        exit.mockRestore();
        err.mockRestore();
        out.mockRestore();
      }
      expect(calls.filter((call) => call.toolName !== "setToolEnabled")).toEqual([]);
      expect(exits).toEqual([1]);
    },
  );
});
