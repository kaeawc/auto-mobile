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

/**
 * Issue #10062: the reconnect re-push carries the time LEFT, which the device times on its own
 * monotonic clock, so neither clock skew nor the reconnect restarts the original duration.
 */
describe("AndroidCtrlProxyClient reconnect sends the remaining error simulation time", () => {
  let timer: FakeTimer;
  let getInstanceSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    timer = new FakeTimer();
    NetworkState.resetInstance();
    const state = new NetworkState({ timer });
    getInstanceSpy = spyOn(NetworkState, "getInstance").mockReturnValue(state);
  });

  afterEach(() => {
    getInstanceSpy.mockRestore();
    NetworkState.resetInstance();
  });

  function reconnectSimulationMessage(): Record<string, unknown> | undefined {
    const client = AndroidCtrlProxyClient.createForTesting(
      DEVICE_A,
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
    return sent
      .map((message) => JSON.parse(message) as Record<string, unknown>)
      .find((m) => m.type === "set_network_error_simulation");
  }

  test("reconnect right after start sends the full duration and keeps the legacy epoch", () => {
    NetworkState.getInstance().startSimulation(DEVICE_A.deviceId, "http500", 30, null);

    expect(reconnectSimulationMessage()).toMatchObject({
      enabled: true,
      remainingMs: 30_000,
      expiresAtEpochMs: timer.now() + 30_000,
    });
  });

  test("reconnect ten seconds in sends what is left, not the original duration", () => {
    NetworkState.getInstance().startSimulation(DEVICE_A.deviceId, "http500", 30, null);
    timer.advanceTime(10_000);

    expect(reconnectSimulationMessage()).toMatchObject({ enabled: true, remainingMs: 20_000 });
  });

  test("a disabled simulation carries no remaining time", () => {
    expect(reconnectSimulationMessage()).toMatchObject({ enabled: false, remainingMs: null });
  });
});
