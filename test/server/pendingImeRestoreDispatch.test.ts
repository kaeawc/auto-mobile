import { ToolRegistryClass } from "../../src/server/toolRegistry";
import { pendingImeRestores } from "../../src/features/action/sendkeys/PendingImeRestore";
import { FakeLogger } from "../fakes/FakeLogger";
import { expect, test } from "bun:test";
import { z } from "zod/v4";
import { sessionDisplayPinnedHandler } from "../../src/server/pipeline/deviceCallDispatch";
import { ActionableError } from "../../src/models/ActionableError";
import { FakePendingImeRestoreRegistry } from "../fakes/FakePendingImeRestoreRegistry";
import { FakeTimer } from "../fakes/FakeTimer";

const device = { deviceId: "lazy-dispatch", platform: "android" as const, name: "Phone" };
function harness(name = "tapAt") {
  const pendingImeRestores = new FakePendingImeRestoreRegistry();
  const events: string[] = [];
  pendingImeRestores.store(
    device.deviceId,
    {
      snapshot: { prior: "keyboard/.Ime", wasEnabled: false, priorSubtype: { id: null } },
      userId: 10,
      restore: async () => {
        events.push("restore");
      },
    },
    new FakeTimer(),
  );
  const handler = sessionDisplayPinnedHandler({
    name,
    schema: z.object({}),
    pendingImeRestores,
    handler: async () => {
      events.push(name);
      return { content: [] };
    },
  });
  return { pendingImeRestores, events, handler };
}

test("a tap restores the device once before dispatch; the next tap does nothing", async () => {
  const h = harness();
  await h.handler(device, {});
  await h.handler(device, {});
  expect(h.events).toEqual(["restore", "tapAt", "tapAt"]);
});

test.each(["sendKeys", "observe"])("%s preserves pending restoration", async (name) => {
  const h = harness(name);
  await h.handler(device, {});
  expect(h.events).toEqual([name]);
  expect(h.pendingImeRestores.flushes).toEqual([]);
});

test("a failed restore surfaces a structured error on the triggering tap", async () => {
  const h = harness();
  h.pendingImeRestores.error = new Error("keyboard restore rejected");
  const result = await h.handler(device, {}).catch((error: unknown) => error);
  expect(result).toBeInstanceOf(ActionableError);
  expect(String(result)).toContain("keyboard restore rejected");
  expect(h.events).toEqual([]);
});

test("another device does not restore this device's snapshot", async () => {
  const h = harness();
  await h.handler({ ...device, deviceId: "other" }, {});
  expect(h.events).toEqual(["tapAt"]);
  expect(h.pendingImeRestores.entries.has(device.deviceId)).toBe(true);
});

test.each(["targetDevice", "resolvedDevice", "plainDevice", "nestedDevice"] as const)(
  "%s registry dispatch restores through the shared hook and surfaces failures",
  async (path) => {
    const timer = new FakeTimer();
    const events: string[] = [];
    const registry = new ToolRegistryClass(timer, new FakeLogger(), null, {
      beforeToolCall: async () => {},
    });
    registry.setToolCallRepositoryForTesting({ recordToolCall: async () => {} });
    registry.setPipelineOverridesForTesting({
      executionTargetResolver: {
        resolveExecutionTarget: async (input) => ({
          args: input.args,
          device,
          internalCall: true,
          shouldResolveDevice: true,
          baseSessionUuid: undefined,
          sessionUuid: undefined,
        }),
      },
      auditRunner: {
        run: async (input) => input.handler(input.device, input.args, input.progress, input.signal),
      },
    });
    const handler = async () => {
      events.push("dispatch");
      return { content: [] };
    };
    if (path === "plainDevice" || path === "nestedDevice") {
      registry.register(
        "plain",
        "test",
        z.object({
          deviceId: z.string().optional(),
          device: z.object({ deviceId: z.string() }).optional(),
        }),
        handler,
      );
    } else {
      registry.registerDeviceAware("tapAt", "test", z.object({}), handler);
    }
    const invoke = () =>
      path === "plainDevice" || path === "nestedDevice"
        ? registry.callInternal(
            "plain",
            path === "plainDevice"
              ? { deviceId: device.deviceId }
              : { device: { deviceId: device.deviceId } },
          )
        : registry.callInternal(
            "tapAt",
            {},
            path === "targetDevice" ? { targetDevice: device } : {},
          );
    const store = (fail: boolean) =>
      pendingImeRestores.store(
        device.deviceId,
        {
          snapshot: { prior: "keyboard/.Ime", wasEnabled: false, priorSubtype: { id: null } },
          userId: 10,
          restore: async () => {
            events.push("restore");
            if (fail) {
              throw new Error("keyboard restore rejected");
            }
          },
        },
        timer,
      );
    try {
      store(false);
      await invoke();
      await invoke();
      expect(events).toEqual(["restore", "dispatch", "dispatch"]);
      store(true);
      await expect(invoke()).rejects.toBeInstanceOf(ActionableError);
      expect(events).toEqual(["restore", "dispatch", "dispatch", "restore"]);
    } finally {
      pendingImeRestores.discard(device.deviceId);
    }
  },
);
