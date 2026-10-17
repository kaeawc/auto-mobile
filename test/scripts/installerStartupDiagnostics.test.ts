import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import {
  OrderCheck,
  callsTo,
  dynamicImports,
  functionBody,
  parseSource,
  swapNodes,
} from "../helpers/entrypointOrder";
const entrypointSource = readFileSync("src/index.ts", "utf8");
const fullDaemonSource = readFileSync("src/daemon/daemon.ts", "utf8");

/**
 * Only the statements from the phase start to the phase end matter to the auxiliary guard, so the
 * tests parse that window instead of the whole 240 KB daemon file (parsing it per test blew the
 * 100 ms unit budget on loaded CI runners).
 */
function auxiliaryPhaseWindow(source: string): string {
  const start = source.indexOf('startupBenchmark.startPhase("auxiliarySocketServerStart")');
  const endCall = source.indexOf('startupBenchmark.endPhase("auxiliarySocketServerStart")');
  if (start < 0 || endCall < start) {
    throw new Error("auxiliarySocketServerStart phase window not found in src/daemon/daemon.ts");
  }
  return source.slice(source.lastIndexOf("\n", start) + 1, source.indexOf("\n", endCall));
}
const daemonSource = auxiliaryPhaseWindow(fullDaemonSource);

/** The awaited forms of these calls: an un-awaited start would let the phase end early. */
function awaited(calls: ts.CallExpression[]): ts.AwaitExpression[] {
  return calls.map((call) => call.parent).filter(ts.isAwaitExpression);
}

/** Module loading is recorded around the first awaited startup import in main(). */
function moduleImportViolations(source: string): string[] {
  const main = functionBody(parseSource(source), "main");
  if (!main) {
    return ["missing main()"];
  }
  const check = new OrderCheck();
  const processEntryMark = check.require(
    "processEntry mark",
    callsTo(main, "startupBenchmark.mark", '"processEntry"'),
  );
  const moduleImportsStart = check.require(
    "moduleImports start",
    callsTo(main, "startupBenchmark.startPhase", '"moduleImports"'),
  );
  const firstDynamicImport = check.require("awaited dynamic import", awaited(dynamicImports(main)));
  const moduleImportsEnd = check.require(
    "moduleImports end",
    callsTo(main, "startupBenchmark.endPhase", '"moduleImports"').filter(
      (call) => firstDynamicImport !== undefined && call.getStart() > firstDynamicImport.getEnd(),
    ),
  );
  check.before("processEntry mark", processEntryMark, "moduleImports start", moduleImportsStart);
  check.before(
    "moduleImports start",
    moduleImportsStart,
    "first dynamic import",
    firstDynamicImport,
  );
  check.before("first dynamic import", firstDynamicImport, "moduleImports end", moduleImportsEnd);
  return check.violations;
}

/** The auxiliary socket startup phase stays open across every auxiliary server start. */
function auxiliarySocketPhaseViolations(source: string): string[] {
  const sf = parseSource(source);
  const check = new OrderCheck();
  const phaseStart = check.require(
    "auxiliary phase start",
    callsTo(sf, "startupBenchmark.startPhase", '"auxiliarySocketServerStart"'),
  );
  const first = check.require(
    "awaited video-recording socket start",
    awaited(callsTo(sf, "this.startAuxiliarySocket", '"video-recording"')),
  );
  const last = check.require(
    "awaited video-stream socket start",
    awaited(callsTo(sf, "this.startAuxiliarySocket", '"video-stream"')),
  );
  const phaseEnd = check.require(
    "auxiliary phase end",
    callsTo(sf, "startupBenchmark.endPhase", '"auxiliarySocketServerStart"'),
  );
  check.before("auxiliary phase start", phaseStart, "video-recording socket start", first);
  check.before("video-recording socket start", first, "video-stream socket start", last);
  check.before("video-stream socket start", last, "auxiliary phase end", phaseEnd);
  return check.violations;
}

describe("#4631 installer startup diagnostics", () => {
  test("records module loading before the first awaited startup import", () => {
    expect(moduleImportViolations(entrypointSource)).toEqual([]);
  });

  test("keeps auxiliary socket startup active until every server is ready", () => {
    expect(auxiliarySocketPhaseViolations(daemonSource)).toEqual([]);
  });

  test("the module-import guard fails when the phase start moves after the first import", () => {
    const main = functionBody(parseSource(entrypointSource), "main")!;
    const start = callsTo(main, "startupBenchmark.startPhase", '"moduleImports"')[0]!.parent;
    const firstImportStatement = dynamicImports(main)[0]!.parent.parent.parent;
    expect(
      moduleImportViolations(swapNodes(entrypointSource, start, firstImportStatement)),
    ).not.toEqual([]);
  });

  test("the auxiliary phase guard fails when a socket start is no longer awaited", () => {
    const mutated = daemonSource.replace(
      'await this.startAuxiliarySocket("video-stream"',
      'void this.startAuxiliarySocket("video-stream"',
    );
    expect(mutated).not.toBe(daemonSource);
    expect(auxiliarySocketPhaseViolations(mutated)).toContain(
      "missing awaited video-stream socket start",
    );
  });

  test("the auxiliary phase guard fails when the phase ends before the last server starts", () => {
    const sf = parseSource(daemonSource);
    const end = callsTo(sf, "startupBenchmark.endPhase", '"auxiliarySocketServerStart"')[0]!.parent;
    const lastStart = callsTo(sf, "this.startAuxiliarySocket", '"video-stream"')[0]!.parent.parent;
    expect(auxiliarySocketPhaseViolations(swapNodes(daemonSource, end, lastStart))).not.toEqual([]);
  });
});
