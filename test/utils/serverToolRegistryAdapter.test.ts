import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DefaultToolRegistry } from "../../src/utils/server/ToolRegistry";
import { ToolRegistry } from "../../src/server/toolRegistry";

describe("DefaultToolRegistry adapter", () => {
  beforeEach(() => {
    ToolRegistry.clearTools();
  });

  afterEach(() => {
    ToolRegistry.clearTools();
  });

  test("forwards registerTool options to the server ToolRegistry", () => {
    const adapter = new DefaultToolRegistry();

    adapter.registerTool(
      "adapterProgressProbe",
      "Adapter progress probe",
      {},
      async () => ({ success: true }),
      { supportsProgress: true },
    );

    expect(ToolRegistry.getTool("adapterProgressProbe")?.supportsProgress).toBe(true);
    expect(adapter.getTool("adapterProgressProbe")?.supportsProgress).toBe(true);
  });
});
