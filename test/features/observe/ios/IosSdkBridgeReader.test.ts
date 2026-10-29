import { describe, expect, test } from "bun:test";
import {
  createIosSdkBridgeReader,
  type IosSdkBridgeClient,
} from "../../../../src/features/observe/ios/IosSdkBridgeReader";
import type { IosObservationBridgeState } from "../../../../src/features/observe/ios/observationBridgeState";
import type { CtrlProxySdkObservationResult } from "../../../../src/features/observe/ios/types";

const observation = {
  captureIdentity: 41,
  orientation: "portrait",
  coordinateSpace: "screen",
  bounds: { left: 0, top: 0, right: 402, bottom: 874 },
  capabilities: [],
};

class FakeBridgeClient implements IosSdkBridgeClient {
  state: IosObservationBridgeState | Error = {
    status: "available",
    schemaVersion: 1,
    supportedActions: ["tap"],
  };
  reply: CtrlProxySdkObservationResult = {
    success: true,
    available: true,
    observation,
    totalTimeMs: 1,
  };
  observeCalls = 0;

  async getObservationBridgeStateForIos(): Promise<IosObservationBridgeState> {
    if (this.state instanceof Error) {
      throw this.state;
    }
    return this.state;
  }

  async requestSdkObservationForIos(): Promise<CtrlProxySdkObservationResult> {
    this.observeCalls++;
    return this.reply;
  }

  async requestSdkActionForIos(): Promise<never> {
    throw new Error("not used");
  }
}

describe("createIosSdkBridgeReader (#5159)", () => {
  test("returns the bridge snapshot when the app registered a bridge", async () => {
    const client = new FakeBridgeClient();
    const reader = createIosSdkBridgeReader({ client: () => client, enabled: () => true });
    expect(await reader.observe("com.example.app")).toEqual({ kind: "observation", observation });
  });

  test("changes nothing when routing is off, there is no runner, or no bridge is registered", async () => {
    const client = new FakeBridgeClient();
    expect(
      await createIosSdkBridgeReader({ client: () => client, enabled: () => false }).observe("a"),
    ).toEqual({ kind: "none" });
    expect(
      await createIosSdkBridgeReader({ client: () => null, enabled: () => true }).observe("a"),
    ).toEqual({ kind: "none" });
    client.state = { status: "unavailable", reason: "NOT_REGISTERED" };
    expect(
      await createIosSdkBridgeReader({ client: () => client, enabled: () => true }).observe("a"),
    ).toEqual({ kind: "none" });
    expect(client.observeCalls).toBe(0);
  });

  test("a failed discovery probe keeps observe on XCTest without a fallback claim", async () => {
    const client = new FakeBridgeClient();
    client.state = new Error("probe timed out");
    const reader = createIosSdkBridgeReader({ client: () => client, enabled: () => true });
    expect(await reader.observe("a")).toEqual({ kind: "none" });
  });

  test("a registered bridge that does not answer is reported unavailable", async () => {
    const client = new FakeBridgeClient();
    client.reply = {
      success: false,
      available: false,
      failure: "bridge_unavailable",
      totalTimeMs: 1,
    };
    const reader = createIosSdkBridgeReader({ client: () => client, enabled: () => true });
    expect(await reader.observe("a")).toEqual({
      kind: "unavailable",
      detail: "bridge_unavailable",
    });
  });
});
