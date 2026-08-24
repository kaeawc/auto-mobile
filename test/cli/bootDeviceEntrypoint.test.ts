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
