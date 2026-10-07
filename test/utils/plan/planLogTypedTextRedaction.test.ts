import { describe, expect, spyOn, test } from "bun:test";
import * as yaml from "js-yaml";
import { z } from "zod/v4";
import type { BootedDevice } from "../../../src/models";
import type { Plan } from "../../../src/models/Plan";
import { ToolRegistry, ToolRegistryClass } from "../../../src/server/toolRegistry";
import { logger } from "../../../src/utils/logger";
import { DefaultPlanExecutor } from "../../../src/utils/plan/PlanExecutor";
import { PlanNormalizer } from "../../../src/utils/plan/PlanNormalizer";
import { YamlPlanSerializer } from "../../../src/utils/plan/PlanSerializer";
import { createStructuredToolResponse } from "../../../src/utils/toolUtils";
import { FakeLogger } from "../../fakes/FakeLogger";
import { FakeTimer } from "../../fakes/FakeTimer";

const SECRET = "hunter2-secret";

function loggedText(calls: unknown[][]): string {
  return calls.map((call) => call.map((part) => String(part)).join(" ")).join("\n");
}

describe("plan logs never carry typed text", () => {
  test("YAML import logs the raw plan with typed text redacted", () => {
    const info = spyOn(logger, "info");
    const debug = spyOn(logger, "debug");
    try {
      const plan = new YamlPlanSerializer().importPlanFromYaml(
        yaml.dump({
          name: "login",
          steps: [{ tool: "sendKeys", commands: [{ action: "type", text: SECRET }] }],
        }),
      );
      // The plan itself keeps the real text: it is what the executor types.
      expect(JSON.stringify(plan.steps)).toContain(SECRET);
      const logged = loggedText([...info.mock.calls, ...debug.mock.calls]);
      expect(logged).not.toContain(SECRET);
      expect(logged).toContain("<text, 14 characters>");
    } finally {
      info.mockRestore();
      debug.mockRestore();
    }
  });

  test("step normalization debug lines redact typed text", () => {
    const debug = spyOn(logger, "debug");
    try {
      const step = PlanNormalizer.normalizeStep({ command: "clipboard", text: SECRET }, 0);
      expect(step.params.text).toBe(SECRET);
      const logged = loggedText(debug.mock.calls);
      expect(logged).not.toContain(SECRET);
      expect(logged).toContain("<text, 14 characters>");
    } finally {
      debug.mockRestore();
    }
  });

  test("executor's per-step params line redacts typed text but the tool receives it", async () => {
    const timer = new FakeTimer();
    const registry = new ToolRegistryClass(timer, new FakeLogger());
    registry.setToolCallRepositoryForTesting({ recordToolCall: async () => {} });
    const device: BootedDevice = { deviceId: "device-A", name: "Pixel", platform: "android" };
    const restore = registry.setPipelineOverridesForTesting({
      executionTargetResolver: {
        resolveExecutionTarget: async (input) => ({
          args: input.args,
          baseSessionUuid: "session",
          device,
          internalCall: false,
          sessionUuid: "session",
          shouldResolveDevice: true,
        }),
      },
      auditRunner: {
        run: async (input) => input.handler(input.device, input.args, input.progress, input.signal),
      },
      afterToolCall: {
        handle: async (input) => ({ durationMs: 0, finalizedResponse: input.response }),
      },
      planLifecycleManager: { afterExecution: async () => {} },
    });
    const toolLookup = spyOn(ToolRegistry, "getToolForPlan").mockImplementation((name) =>
      registry.getToolForPlan(name),
    );
    const received: string[] = [];
    registry.registerDeviceAware(
      "sendKeys",
      "Fake sendKeys",
      z.object({
        sessionUuid: z.string().optional(),
        platform: z.string().optional(),
        deviceId: z.string().optional(),
        commands: z.array(z.object({ action: z.string(), text: z.string().optional() })),
      }),
      async (_device, args) => {
        received.push(...args.commands.map((command) => command.text ?? ""));
        return createStructuredToolResponse({ success: true });
      },
    );
    const plan: Plan = {
      name: "login",
      steps: [{ tool: "sendKeys", params: { commands: [{ action: "type", text: SECRET }] } }],
    };
    const info = spyOn(logger, "info");
    const debug = spyOn(logger, "debug");
    try {
      await new DefaultPlanExecutor(timer).executePlan(plan, 0, "android", "device-A", "session");
      expect(received).toEqual([SECRET]);
      const logged = loggedText([...info.mock.calls, ...debug.mock.calls]);
      expect(logged).toContain("sendKeys with params");
      expect(logged).not.toContain(SECRET);
      expect(logged).toContain("<text, 14 characters>");
    } finally {
      info.mockRestore();
      debug.mockRestore();
      toolLookup.mockRestore();
      restore();
    }
  });
});
