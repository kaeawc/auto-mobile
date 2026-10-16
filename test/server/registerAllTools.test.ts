import { beforeAll, describe, expect, test } from "bun:test";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { registerMcpTools } from "../../src/server/index";
import { initializeCliTools } from "../../src/cli/cliToolRegistration";
import { registerAllTools } from "../../src/server/registerAllTools";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";
import committedDefinitions from "../../schemas/tool-definitions.json";
import before from "../fixtures/tool-registration/registered-tool-names.json";

isolateToolRegistry();

/** Names registered by one entry point, in registration order, starting from an empty registry. */
function registeredNames(register: () => void): string[] {
  const tools = ToolRegistry["tools"];
  tools.clear();
  register();
  return [...tools.keys()];
}

const sorted = (names: readonly string[]): string[] => [...names].sort();

describe("registerAllTools entry points (#11829)", () => {
  const after: Record<string, string[]> = {};

  beforeAll(() => {
    after.serverDaemon = registeredNames(() => registerMcpTools(true));
    after.serverStdio = registeredNames(() => registerMcpTools(false));
    after.cli = registeredNames(() => initializeCliTools());
    after.generator = registeredNames(() => registerAllTools({ daemonMode: true }));
    after.measurementScripts = registeredNames(() =>
      registerAllTools({ daemonMode: true, includeDoctor: true }),
    );
  });

  test("the daemon server registers the same tools in the same order as before", () => {
    expect(after.serverDaemon).toEqual(before.serverDaemon);
  });

  test("the stdio server registers the same tools in the same order as before", () => {
    expect(after.serverStdio).toEqual(before.serverStdio);
  });

  test("the CLI registers the same tool set as before", () => {
    expect(sorted(after.cli)).toEqual(sorted(before.cli));
  });

  test("the tool-definition generator registers the same tool set as before and covers the committed definitions", () => {
    const registered = new Set(after.generator);
    expect(sorted(after.generator)).toEqual(sorted(before.serverDaemon));
    expect(committedDefinitions.map((tool) => tool.name).filter((n) => !registered.has(n))).toEqual(
      [],
    );
  });

  test("the benchmark and context scripts now cover every group the old ten-group list had", () => {
    const registered = new Set(after.measurementScripts);
    expect(before.measurementScripts.filter((name) => !registered.has(name))).toEqual([]);
    expect(sorted(after.measurementScripts)).toEqual(sorted(before.cli.concat("setToolEnabled")));
  });
});
