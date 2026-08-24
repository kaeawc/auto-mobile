import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { createJSONToolResponse } from "../../src/utils/toolUtils";

// Issue #4181, rank 4 (A4): AUTOMOBILE_ALWAYS_LOAD_TOOLS advertises
// _meta["anthropic/alwaysLoad"] on every advertised tool definition. There was
// ZERO coverage repo-wide ('grep -rn "ALWAYS_LOAD|alwaysLoad" test/' -> 0).
//
// Scope note (per the A4 NEEDS-FIX correction): this covers the
// getToolDefinitions() path ONLY. The registerWithServer() _meta path
// (toolRegistry.ts:1050) is served by an SDK handler that index.ts:264
// shadows with its own ListTools handler, so no wire test can reach it.
//
// The flag is a strict `=== "true"` check. Mutating it to Boolean(env) would
// make "1"/"TRUE"/"false" truthy — the negative rows below red on that.
const FLAG = "AUTOMOBILE_ALWAYS_LOAD_TOOLS";
const TOOL = "__test_always_load__";

describe("AUTOMOBILE_ALWAYS_LOAD_TOOLS advertisement", () => {
  let original: string | undefined;

  beforeAll(() => {
    original = process.env[FLAG];
    ToolRegistry.register(TOOL, "throwaway tool for always-load coverage", z.object({}), async () =>
      createJSONToolResponse({ ok: true }),
    );
  });

  afterEach(() => {
    delete process.env[FLAG];
  });

  afterAll(() => {
    if (original === undefined) {
      delete process.env[FLAG];
    } else {
      process.env[FLAG] = original;
    }
    (ToolRegistry as unknown as { tools: Map<string, unknown> }).tools.delete(TOOL);
  });

  test('advertises _meta.anthropic/alwaysLoad when the flag is exactly "true"', () => {
    process.env[FLAG] = "true";
    const def = ToolRegistry.getToolDefinitions().find((d) => d.name === TOOL);
    expect((def as any)._meta).toEqual({ "anthropic/alwaysLoad": true });
  });

  test.each([
    ["unset", undefined],
    ["false", "false"],
    ["1", "1"],
    ["TRUE (wrong case)", "TRUE"],
    ["empty string", ""],
  ])("omits _meta when the flag is %s", (_label, value) => {
    if (value === undefined) {
      delete process.env[FLAG];
    } else {
      process.env[FLAG] = value;
    }
    const def = ToolRegistry.getToolDefinitions().find((d) => d.name === TOOL);
    expect((def as any)._meta).toBeUndefined();
  });
});
