import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { registerNetworkTools } from "../../src/server/networkTools";
import { ToolRegistry } from "../../src/server/toolRegistry";

describe("network tool schema", () => {
  beforeEach(() => {
    ToolRegistry.clearTools();
    registerNetworkTools();
  });

  afterEach(() => {
    ToolRegistry.clearTools();
  });

  test("requires durationSeconds when starting error simulation", () => {
    const tool = ToolRegistry.getTool("network");
    const result = tool!.schema.safeParse({
      simulateErrors: {
        errorType: "timeout",
      },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toEqual(["simulateErrors", "durationSeconds"]);
      expect(result.error.issues[0].message).toBe("durationSeconds is required unless cancel is true");
    }
  });

  test("allows durationSeconds to be omitted when canceling error simulation", () => {
    const tool = ToolRegistry.getTool("network");
    const result = tool!.schema.safeParse({
      simulateErrors: {
        cancel: true,
      },
    });

    expect(result.success).toBe(true);
  });
});
