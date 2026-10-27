import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AndroidDeviceStateSync } from "../../../../src/features/observe/android/AndroidDeviceStateSync";
import { NetworkState } from "../../../../src/utils/NetworkState";

describe("AndroidDeviceStateSync", () => {
  beforeEach(() => NetworkState.resetInstance());
  afterEach(() => NetworkState.resetInstance());

  test("network sync always sends the mock rules then the error simulation state", () => {
    const sent: string[] = [];
    new AndroidDeviceStateSync({
      deviceId: "emulator-5554",
      sendMessage: (message) => {
        sent.push(message);
        return true;
      },
    }).syncNetworkState();
    expect(sent.map((message) => JSON.parse(message).type)).toEqual([
      "set_network_mock_rules",
      "set_network_error_simulation",
    ]);
  });

  test("a failing send is swallowed so a reconnect never throws", () => {
    const sync = new AndroidDeviceStateSync({
      deviceId: "emulator-5554",
      sendMessage: () => {
        throw new Error("socket gone");
      },
    });
    expect(sync.syncNetworkState()).toBe(false);
    expect(() => sync.syncAccessibilityFlags()).not.toThrow();
  });
});

test.each([
  [true, true, true],
  [false, true, false],
  [true, false, false],
])("network delivery %s / %s returns %s", (first, second, expected) => {
  let sends = 0;
  const sync = new AndroidDeviceStateSync({
    deviceId: "fake",
    sendMessage: () => (++sends === 1 ? first : second),
  });
  expect(sync.syncNetworkState()).toBe(expected);
  expect(sends).toBe(2);
});
