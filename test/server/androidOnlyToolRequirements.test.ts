import { describe, expect, test } from "bun:test";
import toolDefinitions from "../../schemas/tool-definitions.json";
import { TOOL_REQUIREMENTS_META_KEY } from "../../src/server/toolRequirements";

interface ListedTool {
  name: string;
  _meta?: Record<string, unknown>;
}

function requiresOf(name: string): unknown {
  const tool = (toolDefinitions as ListedTool[]).find((listed) => listed.name === name);
  return tool?._meta?.[TOOL_REQUIREMENTS_META_KEY];
}

describe("Android-only tools advertise only Android (#19172)", () => {
  test.each(["recordDeviceGestures", "setSensor"])("%s requires only platform:android", (name) => {
    expect(requiresOf(name)).toEqual(["platform:android"]);
  });
});
