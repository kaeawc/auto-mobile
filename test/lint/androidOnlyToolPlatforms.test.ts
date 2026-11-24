import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { registerMcpTools } from "../../src/server";
import { ToolRegistry, type RegisteredTool } from "../../src/server/toolRegistry";
import { isDebugModeEnabled, setDebugModeEnabled } from "../../src/utils/debug";
import { serverConfig } from "../../src/utils/ServerConfig";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";
import { scanAndroidOnlyRefusals, srcAndroidOnlyRefusals } from "./androidOnlyToolRefusals";

isolateToolRegistry();

/**
 * An Android-only tool declares it with the typed `platforms` restriction (#18721), so the registry
 * refuses other devices before the handler and `requires` / docs/tools.md advertise Android alone.
 * A handler that refuses non-Android devices itself, or a description that says the tool is
 * Android-only, without that restriction advertises iOS support that does not exist.
 */

/** Tools that are Android-only for some calls but still serve others on iOS. */
const EXEMPT: Readonly<Record<string, string>> = {
  killProfile: "action list reads the built-in OEM catalog on any device",
  manufacturerProfile: "actions list and describe read the built-in persona catalog on any device",
  portReverse: "on iOS it answers that a simulator shares the host network instead of refusing",
};

/** A description that says the whole tool is Android-only. */
const ANDROID_ONLY_DESCRIPTION = /^Android(?: \d+\+)?: |(?:^|\. )Android only\.$/;

// Scan src/ once, outside the timed test bodies.
const refusals = srcAndroidOnlyRefusals();

function restrictionProblem(tool: RegisteredTool): string | undefined {
  if (Object.hasOwn(EXEMPT, tool.name)) {
    return undefined;
  }
  if (tool.platforms === undefined) {
    return "declares no platforms restriction";
  }
  return tool.platforms.includes("ios") ? "admits ios in its platforms" : undefined;
}

describe("Android-only tools declare their platforms (#18721)", () => {
  let tools = new Map<string, RegisteredTool>();
  let previousDebugMode = false;

  beforeAll(() => {
    previousDebugMode = isDebugModeEnabled();
    setDebugModeEnabled(true);
    serverConfig.setEmbeddedSdkEnabled(true);
    ToolRegistry.clearTools();
    registerMcpTools(true);
    tools = new Map(ToolRegistry.getEveryRegisteredTool().map((tool) => [tool.name, tool]));
  });

  afterAll(() => {
    ToolRegistry.clearTools();
    setDebugModeEnabled(previousDebugMode);
    serverConfig.setEmbeddedSdkEnabled(false);
  });

  test("a src/ refusal naming a tool as Android-only has the typed restriction", () => {
    // A subject read from a template hole ("…") cannot be attributed to a tool and is not checked.
    const problems = refusals.flatMap(({ file, line, subject, text }) => {
      const tool = tools.get(subject);
      const problem = tool?.requiresDevice ? restrictionProblem(tool) : undefined;
      return problem ? [`${file}:${line} ${subject} ${problem}: ${JSON.stringify(text)}`] : [];
    });
    expect(
      problems,
      'Register the tool with platforms: ["android"] and drop the handler check, or add it to EXEMPT with the reason',
    ).toEqual([]);
  });

  test("a device tool whose description says Android-only has the typed restriction", () => {
    const problems = [...tools.values()].flatMap((tool) => {
      const problem =
        tool.requiresDevice && ANDROID_ONLY_DESCRIPTION.test(tool.description)
          ? restrictionProblem(tool)
          : undefined;
      return problem ? [`${tool.name} ${problem}`] : [];
    });
    expect(problems).toEqual([]);
  });

  test("every exemption names a registered device tool without a restriction", () => {
    expect(
      Object.keys(EXEMPT).filter((name) => {
        const tool = tools.get(name);
        return !tool?.requiresDevice || tool.platforms !== undefined;
      }),
    ).toEqual([]);
  });
});

describe("scanAndroidOnlyRefusals", () => {
  test("finds literal, template and concatenated refusals with their subject", () => {
    const source = [
      `const a = "measureStartup is only supported on Android.";`,
      "const b = `${tool} is Android-only; select an Android device.`;",
      `const c = "setAppLinks supports Android 12+ only; " + "iOS has no control.";`,
      `const d = "Records Android-only state for diagnostics.";`,
    ].join("\n");
    expect(
      scanAndroidOnlyRefusals("probe.ts", source).map(({ line, subject }) => [line, subject]),
    ).toEqual([
      [1, "measureStartup"],
      [2, "…"],
      [3, "setAppLinks"],
    ]);
  });
});
