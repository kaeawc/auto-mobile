import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import { ProgressCallback, RegisteredTool, ToolRegistry } from "../../src/server/toolRegistry";
import { INTERNAL_NO_DIFF_PARAM } from "../../src/daemon/internalToolCall";
import { INTERNAL_LIVE_DEADLINE_KEY_PARAM } from "../../src/daemon/wire/constants";
import { ActionableError } from "../../src/models/ActionableError";
import { deviceActionClock } from "../../src/server/pipeline/deviceActionClock";
import { resolveTransportDeadlineMs } from "../../src/server/transportDeadline";
import {
  currentExecution,
  currentRequestDeadline,
  getToolSelectionContext,
  runWithToolSelectionContext,
} from "../../src/features/toolSelection/toolSelectionContext";

/**
 * Unit guard for the `ToolRegistry.callInternal` seam (#3108).
 *
 * The seam is the single internal-caller entry point: it resolves the tool
 * (by name via `getTool`/`getToolForPlan`, or from an already-resolved
 * `RegisteredTool` for sites that must pre-parse), marks the args via
 * `markInternalToolCall`, and invokes the wrapped `.handler()` in one call,
 * returning the raw response untouched. It makes marking the internal path the
 * path of least resistance so a new internal caller cannot forget the
 * `__internalNoDiff` marker and pollute the agent-facing diff baseline (the
 * #3087 bug class).
 */
describe("ToolRegistry.callInternal (#3108)", () => {
  const schema = z.object({
    text: z.string().optional(),
    platform: z.string().optional(),
  });

  interface Capture {
    args: Record<string, unknown>;
    progress?: ProgressCallback;
    signal?: AbortSignal;
  }

  const SENTINEL = { unique: Symbol("raw-response") };
  let captured: Capture[];

  function registerCapturingTool(name: string, options?: { debugOnly?: boolean }): void {
    captured = [];
    ToolRegistry.register(name, `Mock ${name}`, schema, {
      handler: async (args: any, progress?: ProgressCallback, signal?: AbortSignal) => {
        captured.push({ args, progress, signal });
        return SENTINEL;
      },
      ...options,
    });
  }

  beforeEach(() => {
    ToolRegistry.clearTools();
    captured = [];
  });

  afterEach(() => {
    ToolRegistry.clearTools();
  });

  test("AC1: marks args and returns the raw handler response untransformed", async () => {
    registerCapturingTool("tapOn");
    const tool = ToolRegistry.getTool("tapOn")!;

    const response = await ToolRegistry.callInternal(tool, { text: "Go" });

    // Raw response passes through by identity — no diff/strip/finalize wrapping.
    expect(response).toBe(SENTINEL);
    // The marker reached the handler.
    expect(captured).toHaveLength(1);
    expect(captured[0].args[INTERNAL_NO_DIFF_PARAM]).toBe(true);
    expect(captured[0].args.text).toBe("Go");
  });

  test("AC1: does not mutate the caller's args object", async () => {
    registerCapturingTool("tapOn");
    const tool = ToolRegistry.getTool("tapOn")!;
    const original: Record<string, unknown> = { text: "Go" };

    await ToolRegistry.callInternal(tool, original);

    expect(original[INTERNAL_NO_DIFF_PARAM]).toBeUndefined();
    expect(captured[0].args).not.toBe(original);
  });

  test("AC1: forwards progress and signal to the handler", async () => {
    registerCapturingTool("tapOn");
    const tool = ToolRegistry.getTool("tapOn")!;
    const progress: ProgressCallback = async () => {};
    const controller = new AbortController();

    await ToolRegistry.callInternal(tool, { text: "Go" }, { progress, signal: controller.signal });

    expect(captured[0].progress).toBe(progress);
    expect(captured[0].signal).toBe(controller.signal);
  });

  test("AC2: resolves a tool by name via getTool (string form)", async () => {
    registerCapturingTool("tapOn");

    const response = await ToolRegistry.callInternal("tapOn", { text: "Go" });

    expect(response).toBe(SENTINEL);
    expect(captured[0].args[INTERNAL_NO_DIFF_PARAM]).toBe(true);
  });

  test("hidden tools are omitted from discovery but remain directly and internally callable", async () => {
    registerCapturingTool("hiddenStep");
    registerCapturingTool("visibleStep");
    const visible = ToolRegistry.getTool("visibleStep");
    expect(visible?.name).toBe("visibleStep");
    const registered = ToolRegistry.getRegisteredTool("hiddenStep");
    if (!registered) {
      throw new Error("test tool was not registered");
    }
    registered.hidden = true;

    expect(ToolRegistry.getAllTools()).not.toContain(registered);
    expect(ToolRegistry.getTool("hiddenStep")).toBe(registered);

    const response = await ToolRegistry.callInternal("hiddenStep", { text: "Go" });
    expect(response).toBe(SENTINEL);
    expect(captured).toHaveLength(1);
  });

  test("AC2: forPlan resolves a plan-executable tool that getTool hides", async () => {
    // A gated (debugOnly) but planExecutable tool: getTool hides it, getToolForPlan
    // returns it. Only the `forPlan` resolution should reach it.
    registerCapturingTool("hiddenStep", { debugOnly: true });
    (ToolRegistry.getRegisteredTool("hiddenStep") as RegisteredTool).planExecutable = true;

    // Sanity: getTool hides it, so the default (non-forPlan) resolution must fail.
    expect(ToolRegistry.getTool("hiddenStep")).toBeUndefined();
    await expect(ToolRegistry.callInternal("hiddenStep", { text: "Go" })).rejects.toThrow(
      /Tool not found/,
    );

    // forPlan resolves it via getToolForPlan.
    const response = await ToolRegistry.callInternal(
      "hiddenStep",
      { text: "Go" },
      { forPlan: true },
    );
    expect(response).toBe(SENTINEL);
    expect(captured[0].args[INTERNAL_NO_DIFF_PARAM]).toBe(true);
  });

  test("does not apply public session selection to an internal plan step", async () => {
    registerCapturingTool("clipboard");
    const profileService = { isEnabled: async () => false };

    await runWithToolSelectionContext({ sessionToolSelectionService: profileService }, () =>
      ToolRegistry.callInternal("clipboard", {}, { forPlan: true }),
    );

    expect(captured).toHaveLength(1);
  });

  test("keeps nested internal plan calls independent of public session selection", async () => {
    captured = [];
    ToolRegistry.register("clipboard", "Mock clipboard", schema, async (args: any) => {
      captured.push({ args });
      return SENTINEL;
    });
    ToolRegistry.register("criticalSection", "Mock critical section", schema, async () => {
      return ToolRegistry.callInternal("clipboard", {}, { forPlan: true });
    });
    const profileService = { isEnabled: async () => false };

    await runWithToolSelectionContext({ sessionToolSelectionService: profileService }, () =>
      ToolRegistry.callInternal("criticalSection", {}, { forPlan: true }),
    );

    expect(captured).toHaveLength(1);
  });

  test("propagates outer execution metadata to a nested device-aware plan step", async () => {
    let seenExecution: ReturnType<typeof currentExecution>;
    let seenTransportDeadline: number | undefined;
    const device = { name: "Pixel", deviceId: "emulator-15663", platform: "android" as const };
    const originalRecorder = ToolRegistry.getCollaboratorsForTesting().navigationToolCallRecorder;
    const originalRepository = ToolRegistry.getCollaboratorsForTesting().toolCallRepository;
    const restore = ToolRegistry.setPipelineOverridesForTesting({
      executionTargetResolver: {
        async resolveExecutionTarget(input: any) {
          return {
            args: input.args,
            baseSessionUuid: undefined,
            device,
            internalCall: true,
            sessionUuid: undefined,
            shouldResolveDevice: true,
          };
        },
      },
      auditRunner: {
        async run(input: any) {
          return input.handler(input.device, input.args, input.progress, input.signal);
        },
      },
      afterToolCall: {
        async handle(input: any) {
          return { durationMs: 0, finalizedResponse: input.response };
        },
      },
      planLifecycleManager: { async afterExecution() {} },
    });
    ToolRegistry.setCollaboratorsForTesting({ navigationToolCallRecorder: { record() {} } });
    ToolRegistry.setCollaboratorsForTesting({ toolCallRepository: { async recordToolCall() {} } });
    try {
      ToolRegistry.registerDeviceAware("nestedStep", "Nested step", z.object({}), {
        handler: async (_device, args) => {
          captured.push({ args });
          seenExecution = currentExecution();
          seenTransportDeadline = resolveTransportDeadlineMs();
          return SENTINEL;
        },
        planExecutable: true,
      });

      // The outer call was admitted as a control call, so its dispatch moves the device's clock.
      deviceActionClock.markControl("outer-execution");
      await runWithToolSelectionContext(
        {
          execution: { executionId: "outer-execution", startTime: 123 },
          // A step inherits the plan's deadline; a remaining budget with no start of its own.
          planRequest: {},
          requestDeadline: { timeoutMs: 50 },
        },
        () => ToolRegistry.callInternal("nestedStep", {}, { forPlan: true }),
      );
      expect(deviceActionClock.lastActionStartMs(device.deviceId)).toBe(123);
      // The device-aware handler measures that budget from its execution's start (#15663).
      expect(seenTransportDeadline).toBe(173);

      // The step runs under the outer execution ambiently; its id is not written in-band (#15663).
      expect(captured).toHaveLength(1);
      expect(seenExecution).toMatchObject({ executionId: "outer-execution", startTime: 123 });
      expect(captured[0].args).not.toHaveProperty("__executionId");
      // Still in-band for the transport-deadline fallback until that moves too.
      expect(captured[0].args.__executionStartTime).toBe(123);
    } finally {
      restore();
      ToolRegistry.setCollaboratorsForTesting({ navigationToolCallRecorder: originalRecorder });
      ToolRegistry.setCollaboratorsForTesting({ toolCallRepository: originalRepository });
    }
  });

  // Inherited plan metadata must never become an own property with value
  // `undefined`: a `.strict()` tool schema (getAndroid/getApple/provisionDevice)
  // counts such a key as unrecognized and rejects the step outright.
  describe("inherited plan-request metadata", () => {
    test("omits absent parent metadata instead of writing undefined keys", async () => {
      registerCapturingTool("clipboard");

      await runWithToolSelectionContext({ planRequest: {} }, () =>
        ToolRegistry.callInternal("clipboard", { text: "Go" }, { forPlan: true }),
      );

      expect(captured).toHaveLength(1);
      const keys = Object.keys(captured[0].args);
      expect(keys).not.toContain(INTERNAL_LIVE_DEADLINE_KEY_PARAM);
      expect(keys).not.toContain("__mcpRequestDeadlineMs");
      expect(keys).not.toContain("__mcpRequestTimeoutMs");
      expect(keys).not.toContain("__executionStartTime");
      // Concretely: a strict step schema must still accept these args.
      const strict = z.object({ text: z.string(), [INTERNAL_NO_DIFF_PARAM]: z.boolean() }).strict();
      expect(() => strict.parse(captured[0].args)).not.toThrow();
    });

    test("forwards parent metadata that is present", async () => {
      registerCapturingTool("clipboard");

      await runWithToolSelectionContext(
        {
          planRequest: {
            deadlineMs: 10,
            timeoutMs: 20,
            startTime: 30,
            liveDeadlineKey: "live-key",
          },
        },
        () => ToolRegistry.callInternal("clipboard", { text: "Go" }, { forPlan: true }),
      );

      expect(captured[0].args[INTERNAL_LIVE_DEADLINE_KEY_PARAM]).toBe("live-key");
      expect(captured[0].args.__mcpRequestDeadlineMs).toBe(10);
      expect(captured[0].args.__mcpRequestTimeoutMs).toBe(20);
      expect(captured[0].args.__executionStartTime).toBe(30);
    });

    test("an absent parent value still strips a plan-supplied key", async () => {
      registerCapturingTool("clipboard");

      await runWithToolSelectionContext({ planRequest: { timeoutMs: 20 } }, () =>
        ToolRegistry.callInternal(
          "clipboard",
          { text: "Go", [INTERNAL_LIVE_DEADLINE_KEY_PARAM]: "forged-key" },
          { forPlan: true },
        ),
      );

      expect(Object.keys(captured[0].args)).not.toContain(INTERNAL_LIVE_DEADLINE_KEY_PARAM);
      expect(captured[0].args.__mcpRequestTimeoutMs).toBe(20);
    });
  });

  describe("the request deadline an internal call runs under (#15663)", () => {
    const outer = { deadlineMs: 900, timeoutMs: 800, startTime: 100, liveDeadlineKey: "outer" };

    function registerDeadlineProbe(): Array<ReturnType<typeof currentRequestDeadline>> {
      const seen: Array<ReturnType<typeof currentRequestDeadline>> = [];
      ToolRegistry.register("deadlineProbe", "Deadline probe", schema, {
        handler: async () => {
          seen.push(currentRequestDeadline());
          return SENTINEL;
        },
      });
      return seen;
    }

    test("outside a plan, a nested call does not inherit the outer request's deadline", async () => {
      const seen = registerDeadlineProbe();
      await runWithToolSelectionContext({ requestDeadline: outer }, () =>
        ToolRegistry.callInternal("deadlineProbe", {}),
      );
      expect(seen).toEqual([undefined]);
    });

    test("outside a plan, a nested call runs under the deadline its caller passes", async () => {
      const seen = registerDeadlineProbe();
      const passed = { deadlineMs: 500, timeoutMs: 400 };
      await runWithToolSelectionContext({ requestDeadline: outer }, () =>
        ToolRegistry.callInternal("deadlineProbe", {}, { requestDeadline: passed }),
      );
      expect(seen).toEqual([passed]);
    });

    test("inside a plan, every internal call runs under the request's deadline", async () => {
      const seen = registerDeadlineProbe();
      await runWithToolSelectionContext({ requestDeadline: outer, planRequest: {} }, async () => {
        await ToolRegistry.callInternal("deadlineProbe", {}, { forPlan: true });
        // A caller's own deadline does not replace the plan's, as plan metadata never could.
        await ToolRegistry.callInternal(
          "deadlineProbe",
          {},
          { requestDeadline: { deadlineMs: 1 } },
        );
      });
      expect(seen).toEqual([outer, outer]);
    });
  });

  describe("a plan step's tapAt geometry (#15663)", () => {
    test("reaches the call ambiently, never in its arguments", async () => {
      const seen: unknown[] = [];
      ToolRegistry.register("probe", "probe", schema, {
        handler: async (args: Record<string, unknown>) => {
          seen.push(getToolSelectionContext()?.tapAtPlanContext, Object.keys(args));
          return SENTINEL;
        },
      });
      const geometry = { geometry: undefined };

      await ToolRegistry.callInternal("probe", { text: "a" }, { tapAtPlanContext: geometry });

      expect(seen[0]).toBe(geometry);
      expect(seen[1]).not.toContain("__tapAtPlanContext");
    });

    test("a nested call does not inherit the enclosing step's geometry", async () => {
      const seen: unknown[] = [];
      ToolRegistry.register("inner", "inner", schema, {
        handler: async () => {
          seen.push(getToolSelectionContext()?.tapAtPlanContext);
          return SENTINEL;
        },
      });
      ToolRegistry.register("outer", "outer", schema, {
        handler: async () => ToolRegistry.callInternal("inner", {}),
      });

      await ToolRegistry.callInternal("outer", {}, { tapAtPlanContext: {} });

      expect(seen).toEqual([undefined]);
    });
  });

  test("AC3: throws ActionableError when the tool name is unresolved", async () => {
    await expect(ToolRegistry.callInternal("nonexistent", {})).rejects.toBeInstanceOf(
      ActionableError,
    );
    await expect(ToolRegistry.callInternal("nonexistent", {})).rejects.toThrow(
      /Tool not found: nonexistent/,
    );
  });
});
