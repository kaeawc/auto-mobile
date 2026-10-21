import { describe, expect, test } from "bun:test";
import {
  brokerConnectionHostMutationRefusal,
  brokerConnectionPlatformRefusal,
} from "../../../src/daemon/sessionBroker/connectionScope";
import {
  DEVICE_OUTSIDE_BROKER_GRANT_CODE,
  DeviceOutsideBrokerGrantError,
} from "../../../src/daemon/sessionBroker/connectionRefusal";
import { computeBindingScopeKey } from "../../../src/daemon/sessionBroker/registry/bindingRegistry";

const identity = { managedHostScope: "host", runnerNamespace: "runner", runnerIncarnation: "run" };
const binding = { scopeKey: computeBindingScopeKey(identity), sessionUuids: new Set<string>() };

describe("managed connection host and scope decisions", () => {
  test("bound host mutations carry the existing refusal code and binding scope", () => {
    const refusal = brokerConnectionHostMutationRefusal({ binding, action: "ide/setFeatureFlag" });
    expect(refusal).toBeInstanceOf(DeviceOutsideBrokerGrantError);
    expect(refusal?.toPayload()).toMatchObject({
      code: DEVICE_OUTSIDE_BROKER_GRANT_CODE,
      reason: "host",
      scopeKey: binding.scopeKey,
      action: "ide/setFeatureFlag",
      retryable: false,
    });
    expect(refusal?.message).toContain(
      "It changes state shared by every connection of this daemon.",
    );
    expect(
      refusal?.message.endsWith(
        "Reads stay open; use a separate MCP connection for anything else.",
      ),
    ).toBe(true);
  });
});

test.each([
  {
    name: "android binding rejects ios",
    sessions: ["android-slot"],
    platform: "ios",
    refused: true,
  },
  {
    name: "mixed bindings permit ios",
    sessions: ["android-slot", "ios-slot"],
    platform: "ios",
    refused: false,
  },
  {
    name: "mixed bindings permit android",
    sessions: ["android-slot", "ios-slot"],
    platform: "android",
    refused: false,
  },
  {
    name: "unknown binding permits routing",
    sessions: ["unknown-slot"],
    platform: "ios",
    refused: false,
  },
  { name: "empty binding permits routing", sessions: [], platform: "ios", refused: false },
  { name: "no binding permits routing", sessions: undefined, platform: "ios", refused: false },
  {
    name: "no platform permits routing",
    sessions: ["android-slot"],
    platform: undefined,
    refused: false,
  },
])("platform-only managed refusal: $name", ({ sessions, platform, refused }) => {
  const platforms = new Map([
    ["android-slot", "android"],
    ["ios-slot", "ios"],
  ]);
  const input = {
    binding: sessions === undefined ? undefined : { ...binding, sessionUuids: new Set(sessions) },
    action: "homeScreen",
    platform,
    grantedPlatformOf: (sessionUuid: string) => platforms.get(sessionUuid),
  };
  const refusal = brokerConnectionPlatformRefusal(input);
  if (!refused) {
    expect(refusal).toBeUndefined();
    return;
  }
  expect(refusal).toBeInstanceOf(DeviceOutsideBrokerGrantError);
  expect(refusal?.toPayload()).toEqual({
    code: DEVICE_OUTSIDE_BROKER_GRANT_CODE,
    action: "homeScreen",
    reason: "device",
    platform: "ios",
    scopeKey: binding.scopeKey,
    retryable: false,
  });
  expect(refusal?.message).toContain(
    "None of its granted devices is an ios device; name a device by deviceId to read one outside its grants.",
  );
  expect(refusal?.message).not.toContain("undefined");
});
