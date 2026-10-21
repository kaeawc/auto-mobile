import { expect, test } from "bun:test";
import {
  OrderCheck,
  callsTo,
  dynamicImports,
  functionBody,
  ifStatements,
  parseSource,
  swapNodes,
  variableDeclarations,
} from "../helpers/entrypointOrder";

const entrypoint = await Bun.file("src/index.ts").text();
const earlyEntrypoints = await Bun.file("src/startup/earlyEntrypoints.ts").text();
const runStartup = await Bun.file("src/startup/runStartup.ts").text();
const stdioServer = await Bun.file("src/startup/stdioServer.ts").text();

/**
 * main() runs the early entrypoints, then loads the server modules, then the rest of startup, so
 * everything the later steps import or warm up comes after the early dispatch.
 */
function mainOrderViolations(source: string): string[] {
  const main = functionBody(parseSource(source), "main");
  if (!main) {
    return ["missing main()"];
  }
  const check = new OrderCheck();
  const early = check.require("early entrypoints", callsTo(main, "runEarlyEntrypoints"));
  const load = check.require("server module load", callsTo(main, "loadServerModules"));
  const startup = check.require("startup", callsTo(main, "runStartup"));
  check.before("early entrypoints", early, "server module load", load);
  check.before("server module load", load, "startup", startup);
  return check.violations;
}

/** Boot-device dispatch must run before normal server imports and CtrlProxy warm-up. */
function bootDispatchViolations(source: string): string[] {
  const sf = parseSource(source);
  const early = functionBody(sf, "runEarlyEntrypoints");
  const check = new OrderCheck();
  if (!early) {
    return ["missing runEarlyEntrypoints()"];
  }
  check.require(
    "bootDeviceIndex declaration",
    variableDeclarations(early, "bootDeviceIndex", 'rawArgs.indexOf("--boot-device")'),
  );
  const dispatch = check.require("boot dispatch", ifStatements(early, "bootDeviceIndex >= 0"));
  const exit = check.require("boot exit", dispatch ? callsTo(dispatch, "process.exit", "0") : []);
  check.within("process.exit(0)", exit, "the boot dispatch", dispatch);
  for (const spec of ["../server", "../daemon/daemon"]) {
    if (dynamicImports(early, spec).length > 0) {
      check.violations.push(`early entrypoints must not import ${spec}`);
    }
  }
  if (callsTo(sf, "AndroidCtrlProxyManager.prefetchApk").length > 0) {
    check.violations.push("early entrypoints must not warm up CtrlProxy");
  }
  return check.violations;
}

/** Malformed invocations exit before command dispatch or server startup. */
function invocationGuardViolations(startupSource: string, stdioSource: string): string[] {
  const startupSf = parseSource(startupSource);
  const check = new OrderCheck();
  const run = functionBody(startupSf, "runStartup");
  const skipped = functionBody(startupSf, "runSkippedBootstrapDaemonCommand");
  const bootstrap = functionBody(startupSf, "bootstrapServer");
  if (!run || !skipped || !bootstrap) {
    return ["missing runStartup(), runSkippedBootstrapDaemonCommand() or bootstrapServer()"];
  }
  const rejection = check.require(
    "invalidInvocation guard",
    ifStatements(run, "args.invalidInvocation"),
  );
  const missingDaemon = check.require(
    "missing daemon command guard",
    ifStatements(skipped, "args.daemonRequested && daemonCommand === undefined"),
  );
  const dispatch = check.require(
    "bootstrap-skipping daemon dispatch",
    ifStatements(skipped, "daemonCommand && daemonCommandSkipsServerBootstrap(daemonCommand)"),
  );
  const toolRegistration = check.require(
    "tool registration",
    callsTo(bootstrap, "modules.registerMcpTools", "args.daemonMode"),
  );
  check.require(
    "stdio transport",
    callsTo(parseSource(stdioSource), "modules.createStdioServerTransport"),
  );
  const skippedCall = check.require(
    "daemon dispatch call",
    ifStatements(run, "await runSkippedBootstrapDaemonCommand(args, modules)"),
  );
  const bootstrapCall = check.require("server bootstrap call", callsTo(run, "bootstrapServer"));
  const stdioCall = check.require("stdio server call", callsTo(run, "runStdioServer"));
  check.require(
    "process.exit(1) in the invalidInvocation guard",
    rejection ? callsTo(rejection, "process.exit", "1") : [],
  );
  check.require(
    "printUnknownDaemonCommand(undefined) in the missing daemon command guard",
    missingDaemon ? callsTo(missingDaemon, "printUnknownDaemonCommand", "undefined") : [],
  );
  check.before("invalidInvocation guard", rejection, "daemon dispatch call", skippedCall);
  check.before("missing daemon command guard", missingDaemon, "daemon dispatch", dispatch);
  check.before("daemon dispatch call", skippedCall, "server bootstrap call", bootstrapCall);
  check.before("server bootstrap call", bootstrapCall, "stdio server call", stdioCall);
  check.within("tool registration", toolRegistration, "the server bootstrap", bootstrap);
  return check.violations;
}

/** Usage- or error-only `--cli doctor` calls are answered before the server bootstrap (#14533). */
function cliDispatchViolations(startupSource: string): string[] {
  const sf = parseSource(startupSource);
  const run = functionBody(sf, "runStartup");
  const skipped = functionBody(sf, "runSkippedBootstrapCliCommand");
  if (!run || !skipped) {
    return ["missing runStartup() or runSkippedBootstrapCliCommand()"];
  }
  const check = new OrderCheck();
  const guard = check.require(
    "bootstrap-skipping CLI guard",
    ifStatements(skipped, "!args.cliMode || !modules.cliCommandSkipsServerBootstrap(args.cliArgs)"),
  );
  const dispatch = check.require("CLI dispatch", callsTo(skipped, "runCliMode"));
  const skippedCall = check.require(
    "CLI dispatch call",
    ifStatements(run, "await runSkippedBootstrapCliCommand(args, modules)"),
  );
  const bootstrapCall = check.require("server bootstrap call", callsTo(run, "bootstrapServer"));
  check.before("bootstrap-skipping CLI guard", guard, "CLI dispatch", dispatch);
  check.before("CLI dispatch call", skippedCall, "server bootstrap call", bootstrapCall);
  return check.violations;
}

test("the entrypoint runs early entrypoints, then loads the server, then starts up", () => {
  expect(mainOrderViolations(entrypoint)).toEqual([]);
});

test("boot-device dispatches before normal server imports and CtrlProxy warm-up", () => {
  expect(bootDispatchViolations(earlyEntrypoints)).toEqual([]);
});

test("malformed invocation guards exit before command dispatch or server startup", () => {
  expect(invocationGuardViolations(runStartup, stdioServer)).toEqual([]);
});

test("the ordering guard fails when the server load moves ahead of the early entrypoints", () => {
  const main = functionBody(parseSource(entrypoint), "main")!;
  const early = callsTo(main, "runEarlyEntrypoints")[0]!.parent.parent;
  const load = callsTo(main, "loadServerModules")[0]!.parent.parent.parent.parent;
  expect(mainOrderViolations(swapNodes(entrypoint, early, load))).toContain(
    "early entrypoints must come before server module load",
  );
});

test("the boot dispatch guard fails when the server import moves into the early entrypoints", () => {
  const mutated = earlyEntrypoints.replace(
    "const bootDeviceIndex",
    'await import("../server");\n  const bootDeviceIndex',
  );
  expect(mutated).not.toBe(earlyEntrypoints);
  expect(bootDispatchViolations(mutated)).toContain("early entrypoints must not import ../server");
});

test("the boot dispatch guard fails when the boot exit leaves the dispatch", () => {
  const mutated = earlyEntrypoints.replace(
    /(await runBootDeviceCommand\(rawArgs\.slice\(bootDeviceIndex \+ 1\)\);)[\s\S]*?process\.exit\(0\);/,
    "$1",
  );
  expect(mutated).not.toBe(earlyEntrypoints);
  expect(bootDispatchViolations(mutated)).toContain("missing boot exit");
});

test("the invocation guard fails when registration moves ahead of the daemon dispatch", () => {
  const run = functionBody(parseSource(runStartup), "runStartup")!;
  const dispatch = ifStatements(run, "await runSkippedBootstrapDaemonCommand(args, modules)")[0]!;
  const bootstrap = callsTo(run, "bootstrapServer")[0]!.parent;
  expect(
    invocationGuardViolations(swapNodes(runStartup, dispatch, bootstrap), stdioServer),
  ).toContain("daemon dispatch call must come before server bootstrap call");
});

test("the invocation guard fails when the rejection no longer exits", () => {
  const mutated = runStartup.replace(
    /(if \(args\.invalidInvocation\) \{\s*console\.error\(args\.invalidInvocation\);)\s*process\.exit\(1\);/,
    "$1",
  );
  expect(mutated).not.toBe(runStartup);
  expect(invocationGuardViolations(mutated, stdioServer)).toContain(
    "missing process.exit(1) in the invalidInvocation guard",
  );
});

test("usage- or error-only doctor calls dispatch before the server bootstrap", () => {
  expect(cliDispatchViolations(runStartup)).toEqual([]);
});

test("the CLI dispatch guard fails when the bootstrap moves ahead of the doctor dispatch", () => {
  const run = functionBody(parseSource(runStartup), "runStartup")!;
  const dispatch = ifStatements(run, "await runSkippedBootstrapCliCommand(args, modules)")[0]!;
  const bootstrap = callsTo(run, "bootstrapServer")[0]!.parent;
  expect(cliDispatchViolations(swapNodes(runStartup, dispatch, bootstrap))).toContain(
    "CLI dispatch call must come before server bootstrap call",
  );
});
