import { expect, test } from "bun:test";
import {
  OrderCheck,
  callsTo,
  dynamicImports,
  functionBody,
  ifStatements,
  newExpressions,
  parseSource,
  swapNodes,
  variableDeclarations,
} from "../helpers/entrypointOrder";

const entrypoint = await Bun.file("src/index.ts").text();

/** Boot-device dispatch must run before normal server imports and CtrlProxy warm-up. */
function bootDispatchViolations(source: string): string[] {
  const sf = parseSource(source);
  const main = functionBody(sf, "main");
  const check = new OrderCheck();
  if (!main) {
    return ["missing main()"];
  }
  const decl = check.require(
    "bootDeviceIndex declaration",
    variableDeclarations(main, "bootDeviceIndex", 'rawArgs.indexOf("--boot-device")'),
  );
  const dispatch = check.require("boot dispatch", ifStatements(main, "bootDeviceIndex >= 0"));
  const serverImport = check.require("server import", dynamicImports(main, "./server"));
  const warmup = check.require(
    "CtrlProxy warm-up",
    callsTo(sf, "AndroidCtrlProxyManager.prefetchApk"),
  );
  const exit = check.require("boot exit", dispatch ? callsTo(dispatch, "process.exit", "0") : []);
  check.before("boot index lookup", decl, "server import", serverImport);
  check.before("boot dispatch", dispatch, "server import", serverImport);
  check.before("boot dispatch", dispatch, "CtrlProxy warm-up", warmup);
  check.within("process.exit(0)", exit, "the boot dispatch", dispatch);
  return check.violations;
}

/** Malformed invocations exit before command dispatch or server startup. */
function invocationGuardViolations(source: string): string[] {
  const sf = parseSource(source);
  const check = new OrderCheck();
  const rejection = check.require("invalidInvocation guard", ifStatements(sf, "invalidInvocation"));
  const missingDaemon = check.require(
    "missing daemon command guard",
    ifStatements(sf, "daemonRequested && daemonCommand === undefined"),
  );
  const dispatch = check.require(
    "bootstrap-skipping daemon dispatch",
    ifStatements(sf, "daemonCommand && daemonCommandSkipsServerBootstrap(daemonCommand)"),
  );
  const toolRegistration = check.require(
    "tool registration",
    callsTo(sf, "registerMcpTools", "daemonMode"),
  );
  const stdioStartup = check.require("stdio transport", newExpressions(sf, "StdioServerTransport"));
  check.require(
    "process.exit(1) in the invalidInvocation guard",
    rejection ? callsTo(rejection, "process.exit", "1") : [],
  );
  check.require(
    "printUnknownDaemonCommand(undefined) in the missing daemon command guard",
    missingDaemon ? callsTo(missingDaemon, "printUnknownDaemonCommand", "undefined") : [],
  );
  check.before("invalidInvocation guard", rejection, "missing daemon command guard", missingDaemon);
  check.before("missing daemon command guard", missingDaemon, "daemon dispatch", dispatch);
  check.before("daemon dispatch", dispatch, "tool registration", toolRegistration);
  check.before("tool registration", toolRegistration, "stdio transport", stdioStartup);
  return check.violations;
}

test("boot-device dispatches before normal server imports and CtrlProxy warm-up", () => {
  expect(bootDispatchViolations(entrypoint)).toEqual([]);
});

test("malformed invocation guards exit before command dispatch or server startup", () => {
  expect(invocationGuardViolations(entrypoint)).toEqual([]);
});

test("the boot dispatch guard fails when the server import moves ahead of it", () => {
  const sf = parseSource(entrypoint);
  const main = functionBody(sf, "main")!;
  const dispatch = ifStatements(main, "bootDeviceIndex >= 0")[0]!;
  const serverImportStatement = dynamicImports(main, "./server")[0]!.parent.parent.parent;
  expect(bootDispatchViolations(swapNodes(entrypoint, dispatch, serverImportStatement))).toContain(
    "boot dispatch must come before server import",
  );
});

test("the boot dispatch guard fails when the boot exit leaves the dispatch", () => {
  const mutated = entrypoint.replace(
    /(await runBootDeviceCommand\(rawArgs\.slice\(bootDeviceIndex \+ 1\)\);)[\s\S]*?process\.exit\(0\);/,
    "$1",
  );
  expect(mutated).not.toBe(entrypoint);
  expect(bootDispatchViolations(mutated)).toContain("missing boot exit");
});

test("the invocation guard fails when registration moves ahead of the daemon dispatch", () => {
  const sf = parseSource(entrypoint);
  const dispatch = ifStatements(
    sf,
    "daemonCommand && daemonCommandSkipsServerBootstrap(daemonCommand)",
  )[0]!;
  const registration = callsTo(sf, "registerMcpTools", "daemonMode")[0]!.parent;
  expect(invocationGuardViolations(swapNodes(entrypoint, dispatch, registration))).toContain(
    "daemon dispatch must come before tool registration",
  );
});

test("the invocation guard fails when the rejection no longer exits", () => {
  const mutated = entrypoint.replace(
    /(if \(invalidInvocation\) \{\s*console\.error\(invalidInvocation\);)\s*process\.exit\(1\);/,
    "$1",
  );
  expect(mutated).not.toBe(entrypoint);
  expect(invocationGuardViolations(mutated)).toContain(
    "missing process.exit(1) in the invalidInvocation guard",
  );
});
