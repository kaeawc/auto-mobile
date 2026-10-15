import { describe, expect, test } from "bun:test";
import type { PooledDevice } from "../../../src/daemon/devicePool";
import { currentBindingReconciler } from "../../../src/daemon/sessionBroker/provisioning/exclusion";
import type { BindingToolInvoker } from "../../../src/daemon/sessionBroker/provisioning/reconcilerPorts";
import { PoolManagedSlotDeviceStopper } from "../../../src/daemon/managedSlots/poolManagedSlotDeviceStopper";
import type { BindingKey } from "../../../src/daemon/sessionBroker/registry/bindingRegistry";

function pooled(over: Partial<PooledDevice>): PooledDevice {
  return {
    id: "emulator-5554",
    name: "Unknown (emulator-5554)",
    platform: "android",
    sessionId: null,
    status: "idle",
    lastUsedAt: 0,
    assignmentCount: 0,
    errorCount: 0,
    avdName: "amslot-a",
    ...over,
  } as PooledDevice;
}

const TARGET = {
  platform: "android" as const,
  stableId: "amslot-a",
  name: "amslot-a",
  fromScopeKey: "scope-1",
  stillClaimed: async () => true,
};

function harness(devices: PooledDevice[], respond: (args: Record<string, unknown>) => unknown) {
  const calls: Array<{
    name: string;
    args: Record<string, unknown>;
    binding: BindingKey | undefined;
  }> = [];
  const invoke: BindingToolInvoker = async (name, args) => {
    calls.push({ name, args, binding: currentBindingReconciler() });
    return respond(args);
  };
  return {
    calls,
    stopper: new PoolManagedSlotDeviceStopper({ getAllDevices: () => devices }, invoke),
  };
}

const OK = { content: [{ type: "text", text: JSON.stringify({ success: true }) }] };

describe("PoolManagedSlotDeviceStopper", () => {
  test("shuts the pooled runtime down with killDevice (never deleteDevice), unforced, as the reconciler", async () => {
    const { stopper, calls } = harness([pooled({})], () => OK);

    expect(await stopper.stopAndVerifyOffline(TARGET)).toEqual({ kind: "stopped" });

    expect(calls).toEqual([
      {
        name: "killDevice",
        args: { device: { name: "amslot-a", platform: "android", deviceId: "emulator-5554" } },
        binding: { scopeKey: "scope-1", bindingIndex: 0 },
      },
    ]);
  });

  test("a device that is already stopped meets the goal", async () => {
    const { stopper } = harness([pooled({})], () => ({
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({ error: { code: "device_already_stopped", message: "stopped" } }),
        },
      ],
    }));

    expect((await stopper.stopAndVerifyOffline(TARGET)).kind).toBe("stopped");
  });

  test("a refused or throwing killDevice is a failure", async () => {
    const refused = harness([pooled({})], () => ({
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({ message: "held by a session", error: { code: "device_held" } }),
        },
      ],
    }));
    expect(await refused.stopper.stopAndVerifyOffline(TARGET)).toMatchObject({
      kind: "failed",
      message: "held by a session",
    });

    const thrown = harness([pooled({})], () => {
      throw new Error("lease timeout");
    });
    expect(await thrown.stopper.stopAndVerifyOffline(TARGET)).toMatchObject({
      kind: "failed",
      message: "lease timeout",
    });
  });

  test("re-checks the registry claim immediately before killing and kills nothing once lost", async () => {
    const { stopper, calls } = harness([pooled({})], () => OK);

    const result = await stopper.stopAndVerifyOffline({
      ...TARGET,
      stillClaimed: async () => false,
    });

    expect(result.kind).toBe("failed");
    expect(calls).toEqual([]);
  });

  test("a running device with no pooled runtime is a failure, not a silent success", async () => {
    const { stopper, calls } = harness([pooled({ avdName: "other" })], () => OK);

    expect((await stopper.stopAndVerifyOffline(TARGET)).kind).toBe("failed");
    expect(calls).toEqual([]);
  });
});
