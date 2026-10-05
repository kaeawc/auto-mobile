import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { z } from "zod/v4";
import { ToolRegistryClass } from "../../src/server/toolRegistry";
import type { BootedDevice, ObserveResult } from "../../src/models";
import { INTERNAL_NO_DIFF_PARAM } from "../../src/server/internalToolCall";
import {
  beginPostActionCaptureAction,
  deferTerminalScreenshot,
  hasPendingTerminalScreenshot,
} from "../../src/utils/PostActionCaptureContext";
import { createStructuredToolResponse } from "../../src/utils/toolUtils";
import { readToolEnvelopePayload } from "../../src/server/toolEnvelopePayload";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeLogger } from "../fakes/FakeLogger";
import { serverConfig } from "../../src/utils/ServerConfig";

const device: BootedDevice = { name: "fake", platform: "android", deviceId: "capture-device" };
function observation(id: string): ObserveResult {
  return {
    deviceId: device.deviceId,
    observationId: id,
    screenSize: { width: 100, height: 100 },
    systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
    viewHierarchy: { hierarchy: {} },
  };
}

function payload(response: unknown) {
  const view = readToolEnvelopePayload(response);
  if (!view) {
    throw new Error("Missing response payload");
  }
  return view.payload;
}

describe("ToolRegistry post-action capture scope", () => {
  let registry: ToolRegistryClass;
  let restore: () => void;
  let memoryAudit: ReturnType<typeof spyOn>;
  beforeEach(() => {
    registry = new ToolRegistryClass(new FakeTimer(), new FakeLogger());
    registry.setToolCallRepositoryForTesting({ recordToolCall() {} });
    memoryAudit = spyOn(serverConfig, "isMemPerfAuditEnabled").mockReturnValue(false);
    restore = registry.setPipelineOverridesForTesting({
      executionTargetResolver: {
        async resolveExecutionTarget(input) {
          return {
            args: input.args,
            device,
            baseSessionUuid: undefined,
            sessionUuid: undefined,
            internalCall: input.args[INTERNAL_NO_DIFF_PARAM] === true,
            shouldResolveDevice: true,
          };
        },
      },
    });
  });
  afterEach(() => {
    restore();
    memoryAudit.mockRestore();
    registry.clearTools();
  });

  test("registered client action defers until after the handler and returns one screenshot", async () => {
    let captures = 0;
    registry.registerDeviceAware("captureAction", "capture probe", z.object({}), async () => {
      const frame = observation("client-action");
      const capture = async (chosen: ObserveResult) => {
        captures++;
        chosen.screenshotPath = "client.png";
        chosen.screenshotCapturedAt = 123;
      };
      const deferred = deferTerminalScreenshot(frame, capture);
      if (!deferred) {
        await capture(frame);
      }
      expect(deferred).toBe(true);
      expect(captures).toBe(0);
      return createStructuredToolResponse({ success: true, observation: frame });
    });
    const response = await registry.getTool("captureAction")!.handler({ raw: true });
    expect(captures).toBe(1);
    expect(payload(response).observation).toMatchObject({
      observationId: "client-action",
      screenshotPath: "client.png",
      screenshotCapturedAt: 123,
    });
  });

  for (const targetDevice of [false, true]) {
    test(`internal steps capture before returning inside a client scope (targetDevice: ${targetDevice})`, async () => {
      let captures = 0;
      registry.registerDeviceAware(
        "captureStep",
        "step probe",
        z.object({}),
        async (_device, args) => {
          const frame = observation(String(args.id));
          const capture = async (chosen: ObserveResult) => {
            captures++;
            chosen.screenshotPath = `${chosen.observationId}.png`;
          };
          const before = captures;
          const deferred = deferTerminalScreenshot(frame, capture);
          if (!deferred) {
            await capture(frame);
          }
          expect(deferred).toBe(false);
          expect(captures).toBe(before + 1);
          return createStructuredToolResponse({ success: true, observation: frame });
        },
      );
      registry.registerDeviceAware("capturePlan", "plan probe", z.object({}), async () => {
        for (const id of ["step-1", "step-2"]) {
          const result = await registry.callInternal(
            "captureStep",
            { id, raw: true },
            undefined,
            undefined,
            targetDevice ? { targetDevice: device } : {},
          );
          expect(payload(result).observation).toMatchObject({
            observationId: id,
            screenshotPath: `${id}.png`,
          });
        }
        expect(captures).toBe(2);
        return createStructuredToolResponse({ success: true });
      });
      await registry.getTool("capturePlan")!.handler({ raw: true });
      expect(captures).toBe(2);
    });
  }

  test("registered multi-action handler captures each screen before the next action", async () => {
    let screen = 0;
    const order: string[] = [];
    registry.registerDeviceAware("captureSequence", "sequence probe", z.object({}), async () => {
      const frames: ObserveResult[] = [];
      for (const id of ["first", "second"]) {
        await beginPostActionCaptureAction();
        screen++;
        order.push(`action-${screen}`);
        const frame = observation(id);
        const capture = async (chosen: ObserveResult) => {
          order.push(`capture-${chosen.observationId}-screen-${screen}`);
          chosen.screenshotPath = `screen-${screen}.png`;
        };
        if (!deferTerminalScreenshot(frame, capture)) {
          await capture(frame);
        }
        frames.push(frame);
      }
      expect(frames.map((frame) => frame.screenshotPath)).toEqual(["screen-1.png", "screen-2.png"]);
      expect(frames.some(hasPendingTerminalScreenshot)).toBe(false);
      return createStructuredToolResponse({ success: true, observation: frames[1] });
    });
    const response = await registry.getTool("captureSequence")!.handler({ raw: true });
    expect(payload(response).observation).toMatchObject({
      observationId: "second",
      screenshotPath: "screen-2.png",
    });
    expect(order).toEqual([
      "action-1",
      "capture-first-screen-1",
      "action-2",
      "capture-second-screen-2",
    ]);
  });
});
