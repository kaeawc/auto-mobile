import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { isolateEmptyToolRegistry, preserveToolRegistry } from "./withTemporaryTool";

describe("empty tool registry isolation restores the surrounding registry", () => {
  let restore: () => void;
  let sentinel: ReturnType<typeof ToolRegistry.getTool>;
  let previous: ReturnType<typeof ToolRegistry.getAllTools>;
  beforeAll(() => {
    previous = ToolRegistry.getAllTools();
    restore = preserveToolRegistry();
    ToolRegistry.register("emptyIsolationSentinel", "sentinel", z.object({}), async () => ({}));
    sentinel = ToolRegistry.getTool("emptyIsolationSentinel");
  });
  afterAll(() => {
    restore();
    expect(ToolRegistry.getTool("emptyIsolationSentinel")).toBeUndefined();
    expect(ToolRegistry.getAllTools()).toEqual(previous);
  });

  describe("isolated describe", () => {
    isolateEmptyToolRegistry();
    test("starts empty and can register its own tool", () => {
      expect(ToolRegistry.getAllTools()).toHaveLength(0);
      ToolRegistry.register("emptyIsolationTemporary", "temporary", z.object({}), async () => ({}));
      expect(ToolRegistry.getTool("emptyIsolationTemporary")).toBeDefined();
    });
  });

  describe("after the isolated describe", () => {
    test("restores the same sentinel object and removes the temporary tool", () => {
      expect(ToolRegistry.getTool("emptyIsolationSentinel")).toBe(sentinel);
      expect(ToolRegistry.getTool("emptyIsolationTemporary")).toBeUndefined();
    });
  });
});
