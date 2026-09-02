import { afterEach, describe, expect, test } from "bun:test";
import { ToolRegistry } from "../../src/server/toolRegistry";
import {
  InternalToolPayloads,
  narrowInternalToolEnvelope,
} from "../../src/server/internalToolPayloads";
import {
  createStructuredToolResponse,
  getStructuredField,
  StructuredToolResponse,
} from "../../src/utils/toolUtils";
import { ObserveToolPayload, SwipeOnToolPayload } from "../../src/models";
import { INTERNAL_NO_DIFF_PARAM } from "../../src/server/internalToolCall";

/**
 * Issue #3222 (follow-up to #2932 / PR #3217): thread the concrete payload type
 * through the tool-registry boundary for the internally-consumed tools
 * (`swipeOn`, `observe`) so the envelope-vs-`structuredContent` guarantee is
 * enforced by a typed boundary, not by a local `asToolEnvelope` unchecked cast.
 *
 * Two acceptance criteria:
 *  - AC1: `callInternalTyped("observe")`/`callInternalTyped("swipeOn")` resolve to
 *    the concrete `StructuredToolResponse<…Payload>` envelope (the internal-lookup
 *    seam threads the payload type through the registry). Composes with the
 *    `callInternal` seam (#3108) rather than duplicating it.
 *  - AC2: the `asToolEnvelope<T>()` unchecked casts at the internal read sites are
 *    eliminated — the in-flight-pipeline sites use a runtime-validated
 *    `narrowInternalToolEnvelope`, `callInternalTyped` narrows the same way, and
 *    `asToolEnvelope` is gone from `src/`.
 */

describe("narrowInternalToolEnvelope (AC2 runtime-validated narrowing)", () => {
  test("narrows a valid swipeOn envelope so getStructuredField reads the payload", () => {
    const response: unknown = createStructuredToolResponse<SwipeOnToolPayload>({
      success: true,
      found: true,
      message: "Swiped up and found element",
    } as SwipeOnToolPayload);

    const envelope = narrowInternalToolEnvelope("swipeOn", response);
    expect(envelope).toBe(response as StructuredToolResponse<SwipeOnToolPayload>);
    expect(getStructuredField(envelope, "found")).toBe(true);
    expect(getStructuredField(envelope, "success")).toBe(true);
  });

  test("narrows a valid observe envelope keyed to the observe payload type", () => {
    const hierarchy = { hierarchy: { node: {} } };
    const response: unknown = createStructuredToolResponse<ObserveToolPayload>({
      viewHierarchy: hierarchy,
    } as unknown as ObserveToolPayload);

    const envelope = narrowInternalToolEnvelope("observe", response);
    expect(getStructuredField(envelope, "viewHierarchy")).toBe(hierarchy as never);
  });

  test("returns undefined for null / undefined responses", () => {
    expect(narrowInternalToolEnvelope("swipeOn", null)).toBeUndefined();
    expect(narrowInternalToolEnvelope("swipeOn", undefined)).toBeUndefined();
  });

  test("returns undefined for a non-object response", () => {
    expect(narrowInternalToolEnvelope("observe", 42)).toBeUndefined();
    expect(narrowInternalToolEnvelope("observe", "text")).toBeUndefined();
  });

  test("returns undefined when structuredContent is missing or not an object", () => {
    expect(narrowInternalToolEnvelope("swipeOn", { content: [] })).toBeUndefined();
    expect(
      narrowInternalToolEnvelope("swipeOn", { structuredContent: "not-an-object" }),
    ).toBeUndefined();
    expect(narrowInternalToolEnvelope("swipeOn", { structuredContent: null })).toBeUndefined();
  });
});

describe("ToolRegistry.callInternalTyped (AC1 typed seam)", () => {
  afterEach(() => {
    ToolRegistry.clearTools();
  });

  function registerSwipeOn(found: boolean): void {
    ToolRegistry.register("swipeOn", "swipeOn", {}, async () =>
      createStructuredToolResponse<SwipeOnToolPayload>({
        success: true,
        found,
        message: found ? "Swiped up and found element" : "Swiped up",
      } as SwipeOnToolPayload),
    );
  }

  test("resolves to the concrete envelope whose payload reads via getStructuredField", async () => {
    registerSwipeOn(true);
    // `result` is StructuredToolResponse<SwipeOnToolPayload> | undefined — no cast.
    const result = await ToolRegistry.callInternalTyped("swipeOn", {
      direction: "up",
      lookFor: { text: "x" },
    });
    expect(getStructuredField(result, "found")).toBe(true);
    expect(getStructuredField(result, "success")).toBe(true);
  });

  test("delegates through callInternal so the args are marked internal (#3108)", async () => {
    let seenArgs: Record<string, unknown> | undefined;
    ToolRegistry.register("swipeOn", "swipeOn", {}, async (args: any) => {
      seenArgs = args;
      return createStructuredToolResponse<SwipeOnToolPayload>({
        success: true,
        found: true,
        message: "ok",
      } as SwipeOnToolPayload);
    });
    await ToolRegistry.callInternalTyped("swipeOn", { direction: "up" });
    // callInternal applies markInternalToolCall → the internal-no-diff marker is present.
    expect(seenArgs?.[INTERNAL_NO_DIFF_PARAM]).toBe(true);
  });

  test("throws when the tool is unregistered (callInternal contract)", async () => {
    ToolRegistry.clearTools();
    await expect(ToolRegistry.callInternalTyped("swipeOn", {})).rejects.toThrow();
  });

  test("narrows a non-envelope handler response to undefined", async () => {
    ToolRegistry.register("swipeOn", "swipeOn", {}, async () => 42 as unknown);
    const result = await ToolRegistry.callInternalTyped("swipeOn", { direction: "up" });
    expect(result).toBeUndefined();
    expect(getStructuredField(result, "found")).toBeUndefined();
  });

  /**
   * AC1 is fundamentally a *type-level* guarantee. It is CI-pinned by the
   * type-only `AssertTrue` guards in `src/server/internalToolPayloads.ts` — NOT
   * by this test: the `bun run typecheck` gate compiles only `src`
   * (`tsconfig.json` include), so a type assertion here would never be checked
   * and would pass even against an `any` regression. This runtime block instead
   * asserts the value flow and that the payload map is keyed by tool name.
   */
  test("resolved envelope is typed; map is keyed by tool name", async () => {
    registerSwipeOn(false);
    const typed: StructuredToolResponse<SwipeOnToolPayload> | undefined =
      await ToolRegistry.callInternalTyped("swipeOn", { direction: "up" });
    expect(getStructuredField(typed, "found")).toBe(false);

    // The map is keyed by tool name → payload type.
    type SwipeMapped = InternalToolPayloads["swipeOn"];
    type ObserveMapped = InternalToolPayloads["observe"];
    const _swipe: SwipeMapped = { success: true, found: true, message: "" } as SwipeOnToolPayload;
    const _observe: ObserveMapped = {} as ObserveToolPayload;
    expect(_swipe).toBeDefined();
    expect(_observe).toBeDefined();
  });
});
