import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
const entrypointSource = readFileSync("src/index.ts", "utf8");
const daemonSource = readFileSync("src/daemon/daemon.ts", "utf8");

describe("#4631 installer startup diagnostics", () => {
  test("records module loading before the first awaited startup import", () => {
    const mainStart = entrypointSource.indexOf("async function main()");
    const processEntryMark = entrypointSource.indexOf(
      'startupBenchmark.mark("processEntry")',
      mainStart,
    );
    const moduleImportsStart = entrypointSource.indexOf(
      'startupBenchmark.startPhase("moduleImports")',
      mainStart,
    );
    const firstDynamicImport = entrypointSource.indexOf("await import(", mainStart);
    const moduleImportsEnd = entrypointSource.indexOf(
      'startupBenchmark.endPhase("moduleImports")',
      firstDynamicImport,
    );

    expect(mainStart).toBeGreaterThanOrEqual(0);
    expect(processEntryMark).toBeGreaterThan(mainStart);
    expect(moduleImportsStart).toBeGreaterThan(processEntryMark);
    expect(firstDynamicImport).toBeGreaterThan(moduleImportsStart);
    expect(moduleImportsEnd).toBeGreaterThan(firstDynamicImport);
  });

  test("keeps auxiliary socket startup active until every server is ready", () => {
    const socketStartsBegin = daemonSource.indexOf("await startVideoRecordingSocketServer()");
    const socketStartsEnd = daemonSource.indexOf("await startVideoStreamSocketServer()");
    const phaseStart = daemonSource.lastIndexOf(
      'startupBenchmark.startPhase("auxiliarySocketServerStart")',
      socketStartsBegin,
    );
    const phaseEnd = daemonSource.indexOf(
      'startupBenchmark.endPhase("auxiliarySocketServerStart")',
      socketStartsEnd,
    );

    expect(socketStartsBegin).toBeGreaterThanOrEqual(0);
    expect(socketStartsEnd).toBeGreaterThan(socketStartsBegin);
    expect(phaseStart).toBeGreaterThanOrEqual(0);
    expect(phaseStart).toBeLessThan(socketStartsBegin);
    expect(phaseEnd).toBeGreaterThan(socketStartsEnd);
  });
});
