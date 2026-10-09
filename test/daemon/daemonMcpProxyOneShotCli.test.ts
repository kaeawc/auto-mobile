import { describe, expect, spyOn, test } from "bun:test";
import { DaemonMcpProxy } from "../../src/daemon/daemonMcpProxy";
import { DaemonClient } from "../../src/daemon/client";
import { DAEMON_ONE_SHOT_CLI_PARAM, DAEMON_VERSION } from "../../src/daemon/constants";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { FakeTimer } from "../fakes/FakeTimer";

async function forwardedParams(
  oneShotCli: boolean | undefined,
  args: Record<string, unknown>,
): Promise<Record<string, unknown> | undefined> {
  const client = new FakeDaemonClient({ toolResult: { content: [] } });
  const manager = new FakeDaemonManager();
  manager.statusResult = { ...manager.statusResult, version: DAEMON_VERSION };
  const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
  const proxy = new DaemonMcpProxy({
    clientFactory: () => client,
    daemonManager: manager,
    autoStartDaemon: false,
    timer: new FakeTimer(),
    ...(oneShotCli === undefined ? {} : { oneShotCli }),
  });
  try {
    await proxy.callTool("getAndroid", args);
    return client.callToolCalls.at(-1)?.params as Record<string, unknown> | undefined;
  } finally {
    isAvailableSpy.mockRestore();
    await proxy.close();
  }
}

describe("DaemonMcpProxy one-shot CLI marker (#11096)", () => {
  test("a one-shot CLI proxy marks every tool call", async () => {
    expect(await forwardedParams(true, { deviceId: "emulator-5554" })).toEqual({
      deviceId: "emulator-5554",
      [DAEMON_ONE_SHOT_CLI_PARAM]: true,
    });
  });

  test.each([undefined, false])(
    "a long-lived proxy (oneShotCli=%p) never forwards the marker, even a caller-supplied one",
    async (oneShotCli) => {
      expect(
        await forwardedParams(oneShotCli, {
          deviceId: "emulator-5554",
          [DAEMON_ONE_SHOT_CLI_PARAM]: true,
        }),
      ).toEqual({ deviceId: "emulator-5554" });
    },
  );
});
