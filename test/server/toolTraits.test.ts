import { beforeAll, describe, expect, test } from "bun:test";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { registerAppTools } from "../../src/server/appTools";
import { registerObserveTools } from "../../src/server/observeTools";
import { registerNetworkTools } from "../../src/server/networkTools";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";

isolateToolRegistry();

/** Names of the registered tools declaring `trait`, sorted. */
function toolsWith(trait: "stopsApp" | "replacesProcess" | "loudArtifactWrites"): string[] {
  const tools = ToolRegistry["tools"];
  return [...tools.values()]
    .filter((tool) => tool[trait] === true)
    .map((tool) => tool.name)
    .sort();
}

describe("tool traits replace the navigation recorder's name lists (#11825)", () => {
  beforeAll(() => {
    registerAppTools();
    registerObserveTools();
    registerNetworkTools();
  });

  test("stopsApp is declared by exactly the tools APP_STOPPING_TOOLS named", () => {
    // The former APP_STOPPING_TOOLS set in toolRegistry.ts.
    expect(toolsWith("stopsApp")).toEqual(["crashApp", "terminateApp", "uninstallApp"]);
  });

  test("replacesProcess is declared by exactly the tools PROCESS_REPLACING_TOOLS named", () => {
    // The former PROCESS_REPLACING_TOOLS set in toolRegistry.ts.
    expect(toolsWith("replacesProcess")).toEqual(["installApp"]);
  });

  test("loudArtifactWrites is declared by exactly the tools READ_ONLY_ARTIFACT_TOOLS named", () => {
    // The former READ_ONLY_ARTIFACT_TOOLS set in finalizeToolResponse.ts.
    expect(toolsWith("loudArtifactWrites")).toEqual(["getNetworkGraph", "observe"]);
  });

  test("the state-preserving kill is not an app-stopping tool", () => {
    expect(ToolRegistry.getTool("appLifecycle")?.stopsApp).toBeUndefined();
  });
});
