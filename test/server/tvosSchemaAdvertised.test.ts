import { beforeAll, describe, expect, test } from "bun:test";
import { ActionableError } from "../../src/models";
import { unsupportedPlatformToolMessage } from "../../src/server/applePlatformToolSupport";
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

  test("every tool that offers tvos and is not behind the device gate refuses it by name", async () => {
    const plain = ToolRegistry.getEveryRegisteredTool().filter(
      (tool) =>
        tool.deviceAwareHandler === undefined &&
        JSON.stringify(toAdvertisedJsonSchema(tool.schema, { constrainAppIds: false })).includes(
          '"tvos"',
        ),
    );
    expect(plain.map((tool) => tool.name).sort()).toEqual([
      "deleteDevice",
      "killDevice",
      "listDeviceImages",
      "listDevices",
      "setActiveDevice",
      "startDevice",
    ]);
    const outcomes = await Promise.all(
      plain.map(async (tool) => {
        // Both shapes a lifecycle request names its platform with.
        const request = {
          platform: "tvos",
          deviceId: "5B7E1C3D-2A4F-4E6B-8C9D-1E2F3A4B5C6D",
          name: "Apple TV 4K (3rd generation)",
          target: { platform: "tvos", isVirtual: true, stableId: "5B7E1C3D" },
        };
        const error = await Promise.resolve(tool.handler(request)).then(
          () => undefined,
          (caught: unknown) => caught,
        );
        return error instanceof ActionableError &&
          error.message === unsupportedPlatformToolMessage(tool.name, "tvos")
          ? "refused"
          : `${tool.name}: ${String(error)}`;
      }),
    );
    expect(outcomes.filter((outcome) => outcome !== "refused")).toEqual([]);
  });

  test("deleteDevice refuses an Apple TV named only by its target, before any teardown", async () => {
    const error = await Promise.resolve(
      ToolRegistry.getTool("deleteDevice")!.handler({
        target: { platform: "tvos", isVirtual: true, stableId: "5B7E1C3D" },
        mode: "destroy",
        verifyAbsence: true,
      }),
    ).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ActionableError);
    expect((error as ActionableError).message).toBe(
      unsupportedPlatformToolMessage("deleteDevice", "tvos"),
    );
  });
});
