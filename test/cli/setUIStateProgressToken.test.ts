import { afterEach, describe, expect, test } from "bun:test";
import {
  runCliCommand,
  setDaemonProxyFactoryForTesting,
  resetDaemonProxyFactoryForTesting,
} from "../../src/cli";

/**
 * Root-cause regression for issue #6222's reopen. PR #6237 made a
 * progress-emitting `tools/call` extend the daemon's request deadline via
 * `notifications/progress`, keyed by MCP's `_meta.progressToken`. That
 * plumbing depends entirely on the caller asking for progress relay --
 * `DaemonMcpProxy.callTool(name, args, progressToken, onProgress)` only
 * forwards a token, and `UnixSocketServer`/`DaemonClient` only arm
 * `ProgressExtendableDeadline` extension, when one is present (see
 * `test/daemon/socketServerProgressDeadlineExtension.test.ts`,
 * "a tools/call with no progressToken never touches ... the deadline").
 *
 * `runToolViaDaemon` (the direct CLI->daemon path exercised by
 * `runCliCommand`, as opposed to the MCP-server proxy in
 * `src/server/proxyServer.ts` which always echoes the calling MCP client's
 * own token) calls `proxy.callTool(toolName, params)` with NEITHER argument.
 * So on this transport #6237's fix is entirely inert: a multi-field
 * `setUIState` that keeps applying fields successfully still hits the
 * daemon's un-extended, fixed timeout and has its accumulated per-field
 * results discarded by a bare `-32001` timeout -- exactly what was
 * reproduced against a real emulator in the reopen comment on #6222.
 *
 * This test pins the CLI-side half of that gap: it never even attempts to
 * request progress relay, regardless of tool or field count.
 */
describe("runCliCommand never requests progress relay (issue #6222 reopen)", () => {
  afterEach(() => {
    resetDaemonProxyFactoryForTesting();
  });

  test("setUIState is forwarded with no progressToken and no onProgress callback", async () => {
    const calls: unknown[][] = [];
    setDaemonProxyFactoryForTesting((): any => ({
      callTool: async (...args: unknown[]): Promise<any> => {
        calls.push(args);
        return { success: true, fields: [], totalAttempts: 0 };
      },
      close: async (): Promise<void> => {
        // no-op fake
      },
    }));

    await runCliCommand([
      "setUIState",
      "--fields",
      JSON.stringify([
        { selector: { text: "First name" }, value: "Grace" },
        { selector: { text: "Last name" }, value: "Hopper" },
        { selector: { text: "Phone" }, value: "5125550199" },
      ]),
    ]);

    expect(calls).toHaveLength(1);
    const [toolName, , progressToken, onProgress] = calls[0];
    expect(toolName).toBe("setUIState");
    // The bug: neither of these is ever populated on this transport, so the
    // daemon has nothing to extend its deadline on no matter how long the
    // fields take or how many of them there are.
    expect(progressToken).toBeUndefined();
    expect(onProgress).toBeUndefined();
  });
});
