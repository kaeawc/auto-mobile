import { describe, expect, test } from "bun:test";
import {
  managedConnectionHostMutationRefusal,
  managedConnectionPlatformRefusal,
  managedConnectionScopeResetRefusal,
} from "../../../src/daemon/managedSlots/managedConnectionScope";
import {
  DEVICE_OUTSIDE_MANAGED_SLOTS_CODE,
  DeviceOutsideManagedSlotsError,
} from "../../../src/daemon/managedSlots/managedSlotRefusal";
import { computeSlotScopeKey } from "../../../src/daemon/managedSlots/slotRegistry";

const identity = { managedHostScope: "host", runnerNamespace: "runner", runnerIncarnation: "run" };
const binding = { scopeKey: computeSlotScopeKey(identity), sessionUuids: new Set<string>() };

describe("managed connection host and scope decisions", () => {
  test("undefined bindings permit host mutation and any scope reset", () => {
    expect(
      managedConnectionHostMutationRefusal({ binding: undefined, action: "daemon/refreshDevices" }),
    ).toBeUndefined();
    expect(
      managedConnectionScopeResetRefusal({
        binding: undefined,
        action: "daemon/resetSlotScope",
        identity: { runnerNamespace: "other", runnerIncarnation: "other" },
      }),
    ).toBeUndefined();
  });

  test("bound host mutations carry the existing refusal code and binding scope", () => {
    const refusal = managedConnectionHostMutationRefusal({ binding, action: "ide/setFeatureFlag" });
    expect(refusal).toBeInstanceOf(DeviceOutsideManagedSlotsError);
    expect(refusal?.toPayload()).toMatchObject({
      code: DEVICE_OUTSIDE_MANAGED_SLOTS_CODE,
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

  test.each([
    { ...identity, managedHostScope: "other" },
    { ...identity, runnerNamespace: "other" },
    { ...identity, runnerIncarnation: "other" },
    { runnerNamespace: identity.runnerNamespace, runnerIncarnation: identity.runnerIncarnation },
  ])("bound scope reset refuses a different or incomplete identity %j", (target) => {
    const refusal = managedConnectionScopeResetRefusal({
      binding,
      action: "daemon/resetSlotScope",
      identity: target,
    });
    expect(refusal).toBeInstanceOf(DeviceOutsideManagedSlotsError);
    expect(refusal?.toPayload()).toMatchObject({
      code: DEVICE_OUTSIDE_MANAGED_SLOTS_CODE,
      reason: "scope",
      scopeKey: binding.scopeKey,
      action: "daemon/resetSlotScope",
      retryable: false,
    });
    expect(refusal?.message).toContain("named by all three identity parts");
  });

  test("bound scope reset permits exactly its own scope even with no sessions", () => {
    expect(
      managedConnectionScopeResetRefusal({ binding, action: "daemon/resetSlotScope", identity }),
    ).toBeUndefined();
  });
});

test.each([
  { name: "android slot rejects ios", sessions: ["android-slot"], platform: "ios", refused: true },
  {
    name: "mixed slots permit ios",
    sessions: ["android-slot", "ios-slot"],
    platform: "ios",
    refused: false,
  },
  {
    name: "mixed slots permit android",
    sessions: ["android-slot", "ios-slot"],
    platform: "android",
    refused: false,
  },
  {
    name: "unknown slot permits routing",
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
    slotPlatformOf: (sessionUuid: string) => platforms.get(sessionUuid),
  };
  const refusal = managedConnectionPlatformRefusal(input);
  if (!refused) {
    expect(refusal).toBeUndefined();
    return;
  }
  expect(refusal).toBeInstanceOf(DeviceOutsideManagedSlotsError);
  expect(refusal?.toPayload()).toEqual({
    code: DEVICE_OUTSIDE_MANAGED_SLOTS_CODE,
    action: "homeScreen",
    reason: "device",
    platform: "ios",
    scopeKey: binding.scopeKey,
    retryable: false,
  });
  expect(refusal?.message).toContain(
    "None of its slot devices is an ios device; name a device by deviceId to read one outside its slots.",
  );
  expect(refusal?.message).not.toContain("undefined");
});
