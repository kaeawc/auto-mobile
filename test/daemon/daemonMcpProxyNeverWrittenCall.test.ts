import { describe, expect, test, spyOn } from "bun:test";
import { DaemonMcpProxy } from "../../src/daemon/daemonMcpProxy";
import { DaemonClient } from "../../src/daemon/client";
import { DAEMON_VERSION } from "../../src/daemon/constants";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { FakeTimer } from "../fakes/FakeTimer";

function matchingDaemonManager(): FakeDaemonManager {
  const manager = new FakeDaemonManager();
  manager.statusResult = { ...manager.statusResult, version: DAEMON_VERSION };
  return manager;
}

// Holds the notification opt-in RPC at the end of doConnect open so the test
// can close the socket after `connected` flipped but before establishment
// resolves -- the window where the proxy has no client left for the tool call.
class HeldSubscribeClient extends FakeDaemonClient {
  private releaseSubscribe: () => void = () => {};
  private readonly subscribeGate = new Promise<void>((resolve) => {
    this.releaseSubscribe = resolve;
  });

  override async subscribeToNotifications(): Promise<void> {
    await super.subscribeToNotifications();
    await this.subscribeGate;
  }

  closeSocketThenReleaseSubscribe(): void {
    this.emitConnectionClosed();
    this.releaseSubscribe();
  }
}

describe("DaemonMcpProxy tool call that was never written (#9996)", () => {
  test("a non-idempotent tool is retried on the reconnected client", async () => {
    const lostClient = new HeldSubscribeClient();
    const result = { content: [{ type: "text", text: "tapped" }] };
    const freshClient = new FakeDaemonClient({ toolResult: result });
    const clients = [lostClient, freshClient];
    const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
    const proxy = new DaemonMcpProxy({
      clientFactory: () => clients.shift()!,
      daemonManager: matchingDaemonManager(),
      autoStartDaemon: false,
      timer: new FakeTimer(),
    });

    try {
      const call = proxy.callTool("tapOn", { text: "Submit" });
      for (let turn = 0; turn < 100 && !proxy.isConnected(); turn += 1) {
        await Promise.resolve();
      }
      expect(proxy.isConnected()).toBe(true);
      lostClient.closeSocketThenReleaseSubscribe();

      await expect(call).resolves.toEqual(result);

      expect(lostClient.callToolCalls).toEqual([]);
      expect(freshClient.callToolCalls).toEqual([
        { toolName: "tapOn", params: { text: "Submit" } },
      ]);
    } finally {
      isAvailableSpy.mockRestore();
      await proxy.close();
    }
  });
});
