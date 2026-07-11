import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { createMcpServer } from "../../src/server/index";
import { ToolRegistry } from "../../src/server/toolRegistry";

/**
 * `criticalSection` (and the `barrier` tool built on it) are registered ONLY in
 * daemon mode — they rely on the daemon's cross-process lock coordinator and are
 * meaningless over a single stdio connection. Pin that gate so it can't silently
 * regress into the stdio tool surface.
 */
describe("criticalSection / barrier daemon-only registration", () => {
  beforeEach(() => {
    ToolRegistry.clearTools();
  });

  afterAll(() => {
    // Leave a clean registry for any later suite in the same process.
    ToolRegistry.clearTools();
  });

  test("stdio mode registers core tools but not criticalSection or barrier", () => {
    createMcpServer({ daemonMode: false });

    // Sanity: non-gated tools are present, so registration actually ran.
    expect(ToolRegistry.getTool("observe")).toBeDefined();

    expect(ToolRegistry.getTool("criticalSection")).toBeUndefined();
    expect(ToolRegistry.getTool("barrier")).toBeUndefined();
  });

  test("daemon mode registers criticalSection and barrier", () => {
    createMcpServer({ daemonMode: true });

    expect(ToolRegistry.getTool("criticalSection")).toBeDefined();
    expect(ToolRegistry.getTool("barrier")).toBeDefined();
  });
});
