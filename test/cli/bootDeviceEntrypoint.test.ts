import { expect, test } from "bun:test";

test("boot-device dispatches before normal server imports and CtrlProxy warm-up", async () => {
  const entrypoint = await Bun.file("src/index.ts").text();
  const bootDispatch = entrypoint.indexOf(
    'const bootDeviceIndex = rawArgs.indexOf("--boot-device")',
  );
  const serverImport = entrypoint.indexOf('await import("./server")');
  const ctrlProxyWarmup = entrypoint.indexOf("AndroidCtrlProxyManager.prefetchApk()");
  const bootExit = entrypoint.indexOf("process.exit(0);", bootDispatch);

  expect(bootDispatch).toBeGreaterThanOrEqual(0);
  expect(bootDispatch).toBeLessThan(serverImport);
  expect(bootDispatch).toBeLessThan(ctrlProxyWarmup);
  expect(bootExit).toBeGreaterThan(bootDispatch);
  expect(bootExit).toBeLessThan(serverImport);
});

test("malformed invocation guards exit before command dispatch or server startup", async () => {
  const entrypoint = await Bun.file("src/index.ts").text();
  const rejection = entrypoint.indexOf("if (invalidInvocation)");
  const missingDaemon = entrypoint.indexOf("if (daemonRequested && daemonCommand === undefined)");
  const dispatch = entrypoint.indexOf("if (daemonCommand &&");
  const toolRegistration = entrypoint.indexOf("registerMcpTools(daemonMode)");
  const stdioStartup = entrypoint.indexOf("new StdioServerTransport()");

  expect(rejection).toBeGreaterThanOrEqual(0);
  expect(missingDaemon).toBeGreaterThan(rejection);
  expect(entrypoint.slice(rejection, missingDaemon)).toContain("process.exit(1)");
  expect(entrypoint.slice(missingDaemon, dispatch)).toContain(
    "printUnknownDaemonCommand(undefined)",
  );
  expect(missingDaemon).toBeLessThan(dispatch);
  expect(dispatch).toBeLessThan(toolRegistration);
  expect(toolRegistration).toBeLessThan(stdioStartup);
});
