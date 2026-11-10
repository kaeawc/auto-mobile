import { beforeAll, describe, expect, test } from "bun:test";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { registerAppTools } from "../../src/server/appTools";
import { registerObserveTools } from "../../src/server/observeTools";
import { registerNetworkTools } from "../../src/server/networkTools";
import { registerInteractionTools } from "../../src/server/interactionTools";
import { registerSwipeAtTools } from "../../src/server/swipeAtTools";
import { registerMultiTouchTools } from "../../src/server/multiTouchTools";
import { registerBiometricTools } from "../../src/server/biometricTools";
import { registerAppFileTools } from "../../src/server/appFileTools";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";

isolateToolRegistry();

/** Names of the registered tools declaring `trait`, sorted. */
function toolsWith(
  trait:
    | "stopsApp"
    | "replacesProcess"
    | "loudArtifactWrites"
    | "defaultsToSkeletonObservation"
    | "stagesFiles",
): string[] {
  return ToolRegistry.getEveryRegisteredTool()
    .filter((tool) => tool[trait] === true)
    .map((tool) => tool.name)
    .sort();
}

describe("tool traits replace the navigation recorder's name lists (#11825)", () => {
  beforeAll(() => {
    registerAppTools();
    registerObserveTools();
    registerNetworkTools();
    registerInteractionTools();
    registerSwipeAtTools();
    registerMultiTouchTools();
    registerBiometricTools();
    registerAppFileTools();
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

  test("defaultsToSkeletonObservation is declared by exactly the tools SKELETON_DEFAULT_ACTION_TOOLS named", () => {
    // The former SKELETON_DEFAULT_ACTION_TOOLS set in finalizeToolResponse.ts (`observe` owns its
    // own top-level projection and never declared it).
    expect(toolsWith("defaultsToSkeletonObservation")).toEqual(
      [
        "tapOn",
        "tapAt",
        "sendKeys",
        "launchApp",
        "tapAny",
        "dragAndDrop",
        "dragPath",
        "hoverAt",
        "selectAllText",
        "pressButton",
        "systemTray",
        "swipeOn",
        "swipeAt",
        "pinchOn",
        "multiTouch",
        "openLink",
        "shake",
        "recentApps",
        "homeScreen",
        "rotate",
        "terminateApp",
        "biometricAuth",
      ].sort(),
    );
  });

  test("stagesFiles is declared by exactly the tools FILE_STAGING_TOOLS named", () => {
    expect(toolsWith("stagesFiles")).toEqual(["putAppFile"]);
  });

  test("the state-preserving kill is not an app-stopping tool", () => {
    expect(ToolRegistry.getTool("appLifecycle")?.stopsApp).toBeUndefined();
  });
});
