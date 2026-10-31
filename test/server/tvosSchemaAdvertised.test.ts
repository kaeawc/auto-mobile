import { beforeAll, describe, expect, test } from "bun:test";
import { toAdvertisedJsonSchema } from "../../src/server/pipeline/advertisedSchema";
import { registerAllTools } from "../../src/server/registerAllTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";

isolateToolRegistry();

/** Every `platform` property's enum in a JSON schema, with the path that reached it. */
function platformEnums(
  node: unknown,
  path: string[] = [],
): Array<{ path: string; values: string[] }> {
  if (Array.isArray(node)) {
    return node.flatMap((child, index) => platformEnums(child, [...path, String(index)]));
  }
  if (node === null || typeof node !== "object") {
    return [];
  }
  return Object.entries(node).flatMap(([key, value]) => {
    const here =
      key === "platform" && value !== null && typeof value === "object" && "enum" in value
        ? [{ path: [...path, key].join("."), values: (value as { enum: string[] }).enum }]
        : [];
    return [...here, ...platformEnums(value, [...path, key])];
  });
}

describe("tvOS is advertised in tool schemas and refused by every tool (#15886)", () => {
  beforeAll(() => {
    registerAllTools({ daemonMode: true });
  });

  test("every tool input that offers Android also offers tvos", () => {
    const offered = ToolRegistry.getEveryRegisteredTool().flatMap((tool) =>
      platformEnums(toAdvertisedJsonSchema(tool.schema, { constrainAppIds: false })).map(
        (entry) => ({ tool: tool.name, ...entry }),
      ),
    );
    expect(offered.length).toBeGreaterThan(0);
    const missing = offered.filter(
      (entry) => entry.values.includes("android") && !entry.values.includes("tvos"),
    );
    expect(missing).toEqual([]);
  });

  test("listDevices refuses tvos instead of listing it as empty", async () => {
    await expect(
      ToolRegistry.getTool("listDevices")!.handler({ platform: "tvos" }),
    ).rejects.toThrow(
      "listDevices is not supported on tvOS yet. Target an Android or iOS device instead.",
    );
  });

  test("startDevice refuses tvos before any device work", async () => {
    await expect(
      ToolRegistry.getTool("startDevice")!.handler({ platform: "tvos" }),
    ).rejects.toThrow(
      "startDevice is not supported on tvOS yet. Target an Android or iOS device instead.",
    );
  });
});
