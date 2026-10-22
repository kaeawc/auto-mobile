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
  });
}

describe("withSystemAlertGate (#14106)", () => {
  test("checks for system alerts before the action runs", async () => {
    const order: string[] = [];
    const handler = withSystemAlertGate(
      async () => {
        order.push("action");
        return createStructuredToolResponse({ success: true });
      },
      gateReturning([], order),
    );
    await handler(device, {});
    expect(order).toEqual(["gate", "action"]);
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

  test("a failed action still names the alert the gate answered", async () => {
    const handler = withSystemAlertGate(
      async () => {
        throw new ActionableError("Element not found");
      },
      gateReturning([
        'Answered system alert "Allow Demo?" with "Allow" (systemAlerts policy allow).',
      ]),
    );
    await expect(handler(device, {})).rejects.toThrow(
      'Element not found (system alerts: Answered system alert "Allow Demo?"',
    );
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

  test("only tools declaring recordsNavigation pass the gate, on the handler plans also call", async () => {
    const checked: string[] = [];
    setDefaultSystemAlertGateForTesting({
      beforeAction: async (target) => {
        checked.push(target.deviceId);
        return ["System alert seen."];
      },
    });
    const action = async () => createStructuredToolResponse({ success: true });
    ToolRegistry.registerDeviceAware("systemAlertGateNav", "test", z.object({}), action, {
      recordsNavigation: true,
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
