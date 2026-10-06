import { describe, expect, test, spyOn } from "bun:test";
import { DaemonMcpProxy, DaemonToolOutcomeUnknownError } from "../../src/daemon/daemonMcpProxy";
import {
  DaemonClient,
  DaemonRequestNotDeliveredError,
  DaemonUnavailableError,
} from "../../src/daemon/client";
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

describe("DaemonMcpProxy retry of a never-written call (#9996 follow-up)", () => {
  // Attempt 1 hits the window where the proxy has no client; the retry runs on
  // `retryClient`, whose callTool fails with `retryFailure`.
  async function failRetry(
    toolName: string,
    retryFailure: Error,
  ): Promise<{ error: unknown; retryClient: FakeDaemonClient }> {
    const lostClient = new HeldSubscribeClient();
    const retryClient = new FakeDaemonClient({
      onCallTool: () => {
        throw retryFailure;
      },
    });
    const clients = [lostClient, retryClient];
    const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
    const proxy = new DaemonMcpProxy({
      clientFactory: () => clients.shift()!,
      daemonManager: matchingDaemonManager(),
      autoStartDaemon: false,
      timer: new FakeTimer(),
    });
    try {
      const call = proxy.callTool(toolName, {});
      const settled = call.then(
        () => undefined,
        (error: unknown) => error,
      );
      for (let turn = 0; turn < 100 && !proxy.isConnected(); turn += 1) {
        await Promise.resolve();
      }
      lostClient.closeSocketThenReleaseSubscribe();
      return { error: await settled, retryClient };
    } finally {
      isAvailableSpy.mockRestore();
      await proxy.close();
    }
  }

  test("a retried non-idempotent tool whose frame was written then lost is outcome-unknown", async () => {
    const { error, retryClient } = await failRetry(
      "tapOn",
      new DaemonUnavailableError("Socket connection closed"),
    );

    expect(error).toBeInstanceOf(DaemonToolOutcomeUnknownError);
    expect((error as DaemonToolOutcomeUnknownError).toolName).toBe("tapOn");
    // Retried exactly once; the ambiguous failure is not retried again.
    expect(retryClient.callToolCalls).toHaveLength(1);
  });

  test("a retry that provably never reached the daemon stays a not-delivered failure", async () => {
    const notDelivered = new DaemonRequestNotDeliveredError("Socket connection lost");
    const { error, retryClient } = await failRetry("tapOn", notDelivered);

    expect(error).toBe(notDelivered);
    expect(retryClient.callToolCalls).toHaveLength(1);
  });

  test("a retried idempotent tool keeps surfacing the raw transport error", async () => {
    const closed = new DaemonUnavailableError("Socket connection closed");
    const { error } = await failRetry("listDevices", closed);

    expect(error).toBe(closed);
  });

  test("a tool error returned by the daemon on the retry is not rewritten", async () => {
    const toolFailure = new Error("Element not found");
    const { error } = await failRetry("tapOn", toolFailure);

    expect(error).toBe(toolFailure);
  });
});
