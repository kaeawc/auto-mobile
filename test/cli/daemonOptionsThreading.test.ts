import { afterEach, describe, expect, mock, test } from "bun:test";
import type { DaemonOptions } from "../../src/daemon/types";

/**
 * Regression test for issue #4247: the CLI parses `--embedded-sdk` and
 * `--network-mockable`, but they were dropped before reaching the daemon that
 * `--cli` starts or reuses, so SDK- and network-gated tools were unreachable.
 *
 * `runCliCommand` routes tool execution through `DaemonMcpProxy`, constructing it
 * with the `daemonOptions` it receives. This test replaces the proxy with a fake
 * that records the options it is constructed with, then asserts both flags are
 * forwarded end to end from `runCliCommand` — no real daemon involved.
 */
describe("runCliCommand daemon-option threading (issue #4247)", () => {
  const constructedWith: Array<DaemonOptions | undefined> = [];

  afterEach(() => {
    constructedWith.length = 0;
    mock.restore();
  });

  test("forwards embeddedSdk and networkMockable into the DaemonMcpProxy", async () => {
    mock.module("../../src/daemon/daemonMcpProxy", () => ({
      DaemonMcpProxy: class {
        constructor(config: { daemonOptions?: DaemonOptions }) {
          constructedWith.push(config.daemonOptions);
        }
        async callTool(): Promise<any> {
          return { success: true };
        }
        async close(): Promise<void> {
          // no-op fake
        }
      },
    }));

    const { runCliCommand } = await import("../../src/cli");

    await runCliCommand(["listApps", "--platform", "android"], {
      safeAreaWarnings: false,
      embeddedSdk: true,
      networkMockable: true,
    });

    expect(constructedWith).toHaveLength(1);
    expect(constructedWith[0]?.embeddedSdk).toBe(true);
    expect(constructedWith[0]?.networkMockable).toBe(true);
  });
});
