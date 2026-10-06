import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { AndroidCtrlProxyClient } from "../../../../src/features/observe/android";
import type { BootedDevice } from "../../../../src/models";
import { NetworkState } from "../../../../src/server/NetworkState";
import { FakeAdbExecutor } from "../../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../../fakes/FakeTimer";

const DEVICE_A: BootedDevice = {
  deviceId: "emulator-5554",
  platform: "android",
  isEmulator: true,
  name: "Pixel A",
};
const DEVICE_B: BootedDevice = {
  deviceId: "emulator-5556",
  platform: "android",
  isEmulator: true,
  name: "Pixel B",
};

const mockRule = {
  host: "api\\.example\\.com",
  path: "^/feed$",
  method: "*",
  limit: null,
  statusCode: 500,
  responseHeaders: {},
  responseBody: "",
  contentType: "application/json",
};

/** Issue #10061: a reconnect pushes only the connecting device's own network state. */
describe("AndroidCtrlProxyClient network state sync is scoped to its device", () => {
  let timer: FakeTimer;

  beforeEach(() => {
    timer = new FakeTimer();
    NetworkState.resetInstance();
  });

  afterEach(() => {
    NetworkState.resetInstance();
  });

  function syncedMessages(device: BootedDevice): Array<Record<string, unknown>> {
    const client = AndroidCtrlProxyClient.createForTesting(
      device,
      new FakeAdbExecutor(),
      () => {
        throw new Error("no socket in this test");
      },
      timer,
    );
    const sent: string[] = [];
    const sendSpy = spyOn(client, "sendMessage").mockImplementation((message: string) => {
      sent.push(message);
      return true;
    });
    try {
      client.syncNetworkStateToDevice();
    } finally {
      sendSpy.mockRestore();
    }
    return sent.map((message) => JSON.parse(message));
  }

  test("device B receives no rules and no simulation that were set for device A", () => {
    const state = NetworkState.getInstance();
    state.addMock(DEVICE_A.deviceId, mockRule);
    state.startSimulation(DEVICE_A.deviceId, "timeout", 30, null);

    const forB = syncedMessages(DEVICE_B);

    expect(forB.find((m) => m.type === "set_network_mock_rules")?.rules).toEqual([]);
    expect(forB.find((m) => m.type === "set_network_error_simulation")?.enabled).toBe(false);
  });

  test("device A still receives its own rules and simulation on reconnect", () => {
    const state = NetworkState.getInstance();
    const mock = state.addMock(DEVICE_A.deviceId, mockRule);
    state.startSimulation(DEVICE_A.deviceId, "timeout", 30, null);

    const forA = syncedMessages(DEVICE_A);

    const rules = forA.find((m) => m.type === "set_network_mock_rules")?.rules as Array<{
      mockId: string;
    }>;
    expect(rules.map((rule) => rule.mockId)).toEqual([mock.mockId]);
    expect(forA.find((m) => m.type === "set_network_error_simulation")).toMatchObject({
      enabled: true,
      errorType: "timeout",
    });
  });
});
