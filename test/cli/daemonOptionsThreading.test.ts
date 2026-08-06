import { afterEach, describe, expect, test } from "bun:test";
import type { DaemonOptions } from "../../src/daemon/types";
import {
  runCliCommand,
  setDaemonProxyFactoryForTesting,
  resetDaemonProxyFactoryForTesting,
} from "../../src/cli";

/**
 * Regression test for issue #4247: the CLI parses `--embedded-sdk` and
 * `--network-mockable`, but they were dropped before reaching the daemon that
 * `--cli` starts or reuses, so SDK- and network-gated tools were unreachable.
 *
 * `runCliCommand` routes tool execution through `DaemonMcpProxy`, constructing it
 * with the `daemonOptions` it receives. This test injects a fake proxy via the
 * `setDaemonProxyFactoryForTesting` seam — deliberately NOT `mock.module`, which
 * is global in Bun and would replace the real DaemonMcpProxy module for every
 * other suite in the run (breaking daemonMcpProxy.test.ts's import of the real
 * error classes). The fake records the options it is constructed with, then the
 * test asserts both flags are forwarded end to end.
 */
describe("runCliCommand daemon-option threading (issue #4247)", () => {
  const constructedWith: Array<DaemonOptions | undefined> = [];

  afterEach(() => {
    constructedWith.length = 0;
    resetDaemonProxyFactoryForTesting();
  });

  test("forwards embeddedSdk and networkMockable into the DaemonMcpProxy", async () => {
    setDaemonProxyFactoryForTesting((config): any => {
      constructedWith.push(config.daemonOptions);
      return {
        callTool: async (): Promise<any> => ({ success: true }),
        close: async (): Promise<void> => {
          // no-op fake
        },
      };
    });

    await runCliCommand(["listApps", "--platform", "android"], {
      embeddedSdk: true,
      networkMockable: true,
    });

    expect(constructedWith).toHaveLength(1);
    expect(constructedWith[0]?.embeddedSdk).toBe(true);
    expect(constructedWith[0]?.networkMockable).toBe(true);
  });
});
