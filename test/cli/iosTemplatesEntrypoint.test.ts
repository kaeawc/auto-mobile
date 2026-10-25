import { expect, test } from "bun:test";
import {
  dynamicImports,
  functionBody,
  ifStatements,
  parseSource,
  variableDeclarations,
} from "../helpers/entrypointOrder";
import { hasGlobalHelpFlag } from "../../src/cli/helpFlag";
test("ios-templates dispatch precedes normal server startup and owns its help", async () => {
  const source = await Bun.file("src/startup/earlyEntrypoints.ts").text();
  const body = functionBody(parseSource(source), "runEarlyEntrypoints");
  if (!body) {
    throw new Error("missing early entrypoint");
  }
  expect(
    variableDeclarations(body, "templatesIndex", 'rawArgs.indexOf("--ios-templates")'),
  ).toHaveLength(1);
  expect(ifStatements(body, "templatesIndex >= 0")).toHaveLength(1);
  expect(dynamicImports(body, "../cli/iosTemplates")).toHaveLength(1);
  for (const spec of ["../server", "../daemon/daemon"]) {
    expect(dynamicImports(body, spec)).toHaveLength(0);
  }
  expect(hasGlobalHelpFlag(["--ios-templates", "--help"])).toBe(false);
});
