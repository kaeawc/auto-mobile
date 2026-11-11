import { ToolRegistryClass } from "../../src/server/toolRegistry";
import { pendingImeRestores } from "../../src/features/action/sendkeys/PendingImeRestore";
import { FakeLogger } from "../fakes/FakeLogger";
import { expect, test } from "bun:test";
import { z } from "zod/v4";
import {
  flushPendingImeRestoreBeforeDeviceEnd,
  flushPendingImeRestoreBeforeTool,
  sessionDisplayPinnedHandler,
} from "../../src/server/pipeline/deviceCallDispatch";
import { createKeyboardHandler } from "../../src/server/interactionToolHandlers";
import { withInstalledImeRestore } from "../../src/server/keyboardInstalledImeRestore";
import { ActionableError } from "../../src/models/ActionableError";
import { FakePendingImeRestoreRegistry } from "../fakes/FakePendingImeRestoreRegistry";
import { FakeTimer } from "../fakes/FakeTimer";

const device = { deviceId: "lazy-dispatch", platform: "android" as const, name: "Phone" };
const snapshot = { prior: "keyboard/.Ime", wasEnabled: false, priorSubtype: { id: null } };

function pendingRegistry(events: string[]) {
  const registry = new FakePendingImeRestoreRegistry();
  registry.store(device.deviceId, {
    snapshot,
    userId: 10,
    restore: async () => {
      events.push("restore");
    },
  });
  return registry;
}

test.each(["tapAt", "sendKeys", "observe", "keyboard"])(
  "%s dispatch keeps the AutoMobile IME selected for the session (#16428)",
  async (name) => {
    const events: string[] = [];
    const registry = pendingRegistry(events);
    const handler = sessionDisplayPinnedHandler({
      name,
      schema: z.object({}),
      handler: async () => {
        events.push(name);
        return { content: [] };
      },
    });
    await handler(device, {});
    await handler(device, {});
    expect(events).toEqual([name, name]);
    expect(registry.entries.has(device.deviceId)).toBe(true);
  },
);

test.each(["listImes", "setIme", "tapImeKey"] as const)(
  "keyboard %s restores the recorded keyboard before acting on the installed IME",
  async (action) => {
    const events: string[] = [];
    const registry = pendingRegistry(events);
    const handler = withInstalledImeRestore(createKeyboardHandler({}), registry);
    // A failed restore stops the action before it reaches adb, which keeps this test device-free.
    registry.error = new Error("keyboard restore rejected");
    const failure = await handler(device, { action }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ActionableError);
    expect(String(failure)).toContain("keyboard restore rejected");
    expect(registry.flushes).toEqual([device.deviceId]);
    registry.error = undefined;
    // tapImeKey without imeId/key is refused after the restore, again without touching adb.
    await handler(device, { action: "tapImeKey" }).catch(() => undefined);
    expect(events).toEqual(["restore"]);
    expect(registry.entries.has(device.deviceId)).toBe(false);
  },
);

test.each([
  ["deviceAware", false],
  ["deviceAware", true],
  ["plain", false],
] as const)(
  "%s registry dispatch (targetDevice=%s) never restores the session keyboard",
  async (kind, viaTarget) => {
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
    if (kind === "plain") {
      registry.register("plain", "test", z.object({ deviceId: z.string().optional() }), {
        handler,
      });
    } else {
      registry.registerDeviceAware("tapAt", "test", z.object({}), { handler });
    }
    pendingImeRestores.store(device.deviceId, {
      snapshot,
      userId: 10,
      restore: async () => {
        events.push("restore");
      },
    });
    try {
      for (let call = 0; call < 2; call++) {
        await (kind === "plain"
          ? registry.callInternal("plain", { deviceId: device.deviceId })
          : registry.callInternal("tapAt", {}, viaTarget ? { targetDevice: device } : {}));
      }
      expect(events).toEqual(["dispatch", "dispatch"]);
      expect(pendingImeRestores.hasPending(device.deviceId)).toBe(true);
    } finally {
      pendingImeRestores.discard(device.deviceId);
    }
  },
);

test("an iOS keyboard IME action leaves Android restoration pending", async () => {
  const events: string[] = [];
  const registry = pendingRegistry(events);
  const handler = withInstalledImeRestore(createKeyboardHandler({}), registry);
  const result = await handler({ ...device, platform: "ios" }, { action: "listImes" }).catch(
    (error: unknown) => error,
  );
  expect(result).toBeDefined();
  expect(registry.flushes).toEqual([]);
  expect(events).toEqual([]);
});

// A device-ending tool continues past a failed restore; a keyboard-acting tool still refuses (#17879).
test("a device-ending flush logs a rejected restore at warn and continues", async () => {
  const registry = new FakePendingImeRestoreRegistry();
  registry.error = new Error("ime list timed out");
  const log = new FakeLogger();
  await flushPendingImeRestoreBeforeDeviceEnd(device.deviceId, registry, log);
  expect(registry.flushes).toEqual([device.deviceId]);
  const warnings = log.messages.filter((m) => m.level === "warn");
  expect(warnings).toHaveLength(1);
  expect(warnings[0].message).toContain(device.deviceId);
  expect(warnings[0].message).toContain("ime list timed out");
});

test("a keyboard-acting flush still throws an ActionableError for a rejected restore", async () => {
  const registry = new FakePendingImeRestoreRegistry();
  registry.error = new Error("ime list timed out");
  const failure = await flushPendingImeRestoreBeforeTool(device.deviceId, registry).catch(
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(ActionableError);
  expect(String(failure)).toContain("ime list timed out");
});
