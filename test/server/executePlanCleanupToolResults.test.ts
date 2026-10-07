import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod/v4";
import { ActionableError } from "../../src/models";
import type { BootedDevice } from "../../src/models";
import { DefaultAppCleanupService } from "../../src/server/AppCleanupService";
import { DefaultAfterToolCallHandler, ToolRegistryClass } from "../../src/server/toolRegistry";
import { FakeDisplayInventoryProvider } from "../fakes/FakeDisplayInventoryProvider";
import { FakeLogger } from "../fakes/FakeLogger";
import { FakeTimer } from "../fakes/FakeTimer";

// #10090 x app cleanup: the JUnit runner reads per-step results (and, on failure, the recovery
// context) out of the `executePlan` response, while the plan's app cleanup runs after that
// response is finalized and can fail. A failing cleanup is reported through a warning and the
// device health marker only; it must not replace or trim the response the runner reads.
// The response is the real capture the Kotlin runner tests parse (executePlanToolResultsCapture).

const CAPTURED = path.join(
  import.meta.dir,
  "../../android/junit-runner/src/test/resources/captured/execute-plan-tool-results.json",
);

const device: BootedDevice = { name: "Pixel", deviceId: "emulator-5554", platform: "android" };

type CapturedEnvelope = { content: Array<{ type: string; text: string }> };

function planPayload(response: CapturedEnvelope) {
  return JSON.parse(response.content[0].text) as {
    toolResults: Array<{ stepIndex: number; tool: string }>;
    skippedSteps: Array<{ stepIndex: number }>;
  };
}

describe("executePlan whose app cleanup fails", () => {
  test.each(["result", "throw"])(
    "still returns toolResults addressed by plan step index (cleanup fails via %s)",
    async (outcome) => {
      const log = new FakeLogger();
      const registry = new ToolRegistryClass(new FakeTimer(), log);
      registry.setToolCallRepositoryForTesting({ recordToolCall: async () => {} });
      registry.setCleanupService(
        new DefaultAppCleanupService({
          logger: log,
          createClearAppData: () => ({
            execute: async () => {
              if (outcome === "throw") {
                throw new ActionableError("App is not installed");
              }
              return {
                success: false,
                packageName: "com.example.app",
                error: "App is not installed",
              };
            },
          }),
        }),
      );
      const restore = registry.setPipelineOverridesForTesting({
        displayInventory: new FakeDisplayInventoryProvider(),
        executionTargetResolver: {
          resolveExecutionTarget: async (input) => ({
            args: input.args,
            device,
            internalCall: false,
            baseSessionUuid: undefined,
            sessionUuid: undefined,
            shouldResolveDevice: true,
          }),
        },
        auditRunner: {
          run: async (input) =>
            input.handler(input.device, input.args, input.progress, input.signal),
        },
        afterToolCall: new DefaultAfterToolCallHandler(),
      });
      try {
        const captured = JSON.parse(readFileSync(CAPTURED, "utf8")) as CapturedEnvelope;
        registry.registerDeviceAware("executePlan", "Plan", z.object({}), async () => captured);

        const response = (await registry.getTool("executePlan")!.handler({
          cleanupAppId: "com.example.app",
          cleanupClearAppData: true,
        })) as CapturedEnvelope;

        const payload = planPayload(response);
        expect(payload.toolResults.map((entry) => [entry.stepIndex, entry.tool])).toEqual([
          [0, "tapOn"],
          [2, "tapOn"],
        ]);
        expect(payload.skippedSteps.map((step) => step.stepIndex)).toEqual([1]);
        expect(log.at("warn").some((entry) => entry.message.includes("App is not installed"))).toBe(
          true,
        );
      } finally {
        restore();
        registry.clearTools();
      }
    },
  );
});
