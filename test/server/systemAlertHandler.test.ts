import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import { setDefaultSystemAlertGateForTesting } from "../../src/features/action/systemAlerts/SystemAlertGate";
import type { BootedDevice } from "../../src/models";
import { ActionableError } from "../../src/models/ActionableError";
import { withSystemAlertGate } from "../../src/server/systemAlertHandler";
import { ToolRegistry } from "../../src/server/toolRegistry";
import {
  createStructuredToolResponse,
  getStructuredField,
  type StructuredToolResponse,
} from "../../src/utils/toolUtils";
import { preserveToolRegistry } from "../helpers/withTemporaryTool";

const device: BootedDevice = { name: "emu", platform: "android", deviceId: "emulator-5554" };

function gateReturning(warnings: string[], order: string[] = []) {
  return () => ({
    beforeAction: async () => {
      order.push("gate");
      return warnings;
    },
    afterAction: async () => {
      order.push("after");
      return [];
    },
  });
}

describe("withSystemAlertGate (#14106)", () => {
  test("checks for system alerts before the action runs and again after it", async () => {
    const order: string[] = [];
    const handler = withSystemAlertGate(
      async () => {
        order.push("action");
        return createStructuredToolResponse({ success: true });
      },
      gateReturning([], order),
    );
    await handler(device, {});
    expect(order).toEqual(["gate", "action", "after"]);
  });

  test("adds every gate warning to the result's warnings, after the action's own", async () => {
    const handler = withSystemAlertGate(
      async () => createStructuredToolResponse({ success: true, warnings: ["action warning"] }),
      gateReturning([
        'Answered system alert "Allow Demo?" with "Allow" (systemAlerts policy allow).',
      ]),
    );
    const response = (await handler(device, {})) as StructuredToolResponse<{ warnings?: string[] }>;
    expect(getStructuredField(response, "warnings")).toEqual([
      "action warning",
      'Answered system alert "Allow Demo?" with "Allow" (systemAlerts policy allow).',
    ]);
    expect(response.success).toBe(true);
    expect(response.content.at(-1)?.text).toContain('Answered system alert "Allow Demo?"');
  });

  test("leaves the response untouched when the gate has nothing to say", async () => {
    const original = createStructuredToolResponse({ success: true });
    const handler = withSystemAlertGate(async () => original, gateReturning([]));
    expect(await handler(device, {})).toBe(original);
  });

  test("a failed action's error is rethrown unchanged, with no after-action check", async () => {
    const order: string[] = [];
    const failure = new ActionableError("Element not found");
    const handler = withSystemAlertGate(
      async () => {
        throw failure;
      },
      gateReturning(['Answered system alert "Allow Demo?" with "Allow".'], order),
    );
    await expect(handler(device, {})).rejects.toBe(failure);
    expect(failure.message).toBe("Element not found");
    expect(order).toEqual(["gate"]);
  });

  test("an abort keeps its read-only DOMException and skips the after-action check", async () => {
    const order: string[] = [];
    const controller = new AbortController();
    const handler = withSystemAlertGate(
      async () => {
        controller.abort();
        controller.signal.throwIfAborted();
        return createStructuredToolResponse({ success: true });
      },
      gateReturning(["Alert seen."], order),
    );
    await expect(handler(device, {}, undefined, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(order).toEqual(["gate"]);
  });
});

describe("ToolRegistry gates UI interactions on the system-alert policy (#14106)", () => {
  let restore: () => void;
  beforeAll(() => {
    restore = preserveToolRegistry();
  });
  afterAll(() => {
    restore();
    setDefaultSystemAlertGateForTesting(undefined);
  });

  test("only tools declaring answersSystemAlerts pass the gate, on the handler plans also call", async () => {
    const checked: string[] = [];
    setDefaultSystemAlertGateForTesting({
      beforeAction: async (target) => {
        checked.push(target.deviceId);
        return ["System alert seen."];
      },
      afterAction: async () => [],
    });
    const action = async () => createStructuredToolResponse({ success: true });
    ToolRegistry.registerDeviceAware("systemAlertGateNav", "test", z.object({}), {
      handler: action,
      answersSystemAlerts: true,
    });
    ToolRegistry.registerDeviceAware("systemAlertGatePlain", "test", z.object({}), action);

    const gated = (await ToolRegistry.getTool("systemAlertGateNav")!.deviceAwareHandler!(
      device,
      {},
    )) as StructuredToolResponse<{ warnings?: string[] }>;
    const plain = (await ToolRegistry.getTool("systemAlertGatePlain")!.deviceAwareHandler!(
      device,
      {},
    )) as StructuredToolResponse<{ warnings?: string[] }>;

    expect(checked).toEqual([device.deviceId]);
    expect(getStructuredField(gated, "warnings")).toEqual(["System alert seen."]);
    expect(getStructuredField(plain, "warnings")).toBeUndefined();
  });
});
