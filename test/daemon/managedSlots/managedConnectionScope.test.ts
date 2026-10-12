import { describe, expect, test } from "bun:test";
import {
  managedConnectionHostMutationRefusal,
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
