import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { ProgressCallback, RegisteredTool, ToolRegistry } from "../../src/server/toolRegistry";
import { INTERNAL_NO_DIFF_PARAM } from "../../src/server/internalToolCall";
import { ActionableError } from "../../src/models/ActionableError";
import { runWithToolCapabilityContext } from "../../src/features/toolCapabilities/toolCapabilityContext";

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
    ToolRegistry.register(
      name,
      `Mock ${name}`,
      schema,
      async (args: any, progress?: ProgressCallback, signal?: AbortSignal) => {
        captured.push({ args, progress, signal });
        return SENTINEL;
      },
      options
    );
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

    await ToolRegistry.callInternal(tool, { text: "Go" }, progress, controller.signal);

    expect(captured[0].progress).toBe(progress);
    expect(captured[0].signal).toBe(controller.signal);
  });

  test("AC2: resolves a tool by name via getTool (string form)", async () => {
    registerCapturingTool("tapOn");

    const response = await ToolRegistry.callInternal("tapOn", { text: "Go" });

    expect(response).toBe(SENTINEL);
    expect(captured[0].args[INTERNAL_NO_DIFF_PARAM]).toBe(true);
  });

  test("AC2: forPlan resolves a plan-executable tool that getTool hides", async () => {
    // A gated (debugOnly) but planExecutable tool: getTool hides it, getToolForPlan
    // returns it. Only the `forPlan` resolution should reach it.
    registerCapturingTool("hiddenStep", { debugOnly: true });
    ((ToolRegistry as any).tools.get("hiddenStep") as RegisteredTool).planExecutable = true;

    // Sanity: getTool hides it, so the default (non-forPlan) resolution must fail.
    expect(ToolRegistry.getTool("hiddenStep")).toBeUndefined();
    await expect(ToolRegistry.callInternal("hiddenStep", { text: "Go" })).rejects.toThrow(
      /Tool not found/
    );

    // forPlan resolves it via getToolForPlan.
    const response = await ToolRegistry.callInternal(
      "hiddenStep",
      { text: "Go" },
      undefined,
      undefined,
      { forPlan: true }
    );
    expect(response).toBe(SENTINEL);
    expect(captured[0].args[INTERNAL_NO_DIFF_PARAM]).toBe(true);
  });

  test("admits an executePlan-authorized step without separately enabling its capability", async () => {
    registerCapturingTool("clipboard");
    const profileService = { isEnabled: async () => false };

    await runWithToolCapabilityContext(
      { planCapabilitiesAuthorized: true, sessionToolProfileService: profileService },
      () => ToolRegistry.callInternal("clipboard", {}, undefined, undefined, {
        forPlan: true,
      }),
    );

    expect(captured).toHaveLength(1);
  });

  test("propagates executePlan authorization to nested plan steps", async () => {
    captured = [];
    ToolRegistry.register("clipboard", "Mock clipboard", schema, async (args: any) => {
      captured.push({ args });
      return SENTINEL;
    });
    ToolRegistry.register("criticalSection", "Mock critical section", schema, async () => {
      return ToolRegistry.callInternal("clipboard", {}, undefined, undefined, { forPlan: true });
    });
    const profileService = { isEnabled: async () => false };

    await runWithToolCapabilityContext(
      { planCapabilitiesAuthorized: true, sessionToolProfileService: profileService },
      () => ToolRegistry.callInternal("criticalSection", {}, undefined, undefined, {
        forPlan: true,
      }),
    );

    expect(captured).toHaveLength(1);
  });

  test("AC3: throws ActionableError when the tool name is unresolved", async () => {
    await expect(ToolRegistry.callInternal("nonexistent", {})).rejects.toBeInstanceOf(ActionableError);
    await expect(ToolRegistry.callInternal("nonexistent", {})).rejects.toThrow(/Tool not found: nonexistent/);
  });
});
