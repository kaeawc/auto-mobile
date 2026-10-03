import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import { fileURLToPath } from "node:url";

const transpiler = new Bun.Transpiler({ loader: "ts" });
const clientModuleNames = new Set(["AndroidCtrlProxyClient", "IOSCtrlProxyClient"]);

export function staticCtrlProxyImports(source: string, sourceUrl: string | URL): string[] {
  // scanImports drops type-only imports and require.resolve, but reports eager
  // and lazy requires with the same kind and no scope/location information.
  // Guard static imports only: cleanup's require calls live in lazy clear closures.
  return transpiler
    .scanImports(source)
    .filter(
      ({ kind, path }) =>
        kind === "import-statement" &&
        clientModuleNames.has(posix.parse(new URL(path, sourceUrl).pathname).name),
    )
    .map(({ path }) => path);
}

for (const file of ["ctrlProxyRegistryCleanup.ts", "portAvailabilityPreload.ts"]) {
  test(`${file} does not statically import either CtrlProxy client`, () => {
    const sourceUrl = new URL(file, import.meta.url);
    const source = readFileSync(fileURLToPath(sourceUrl), "utf8");
    expect(staticCtrlProxyImports(source, sourceUrl)).toEqual([]);
  });
}

test("static import guard flags the old cleanup's two runtime imports", () => {
  const oldSource = `
    import { AndroidCtrlProxyClient } from "../../src/features/observe/android/AndroidCtrlProxyClient";
    import { IOSCtrlProxyClient } from "../../src/features/observe/ios/IOSCtrlProxyClient";
  `;
  expect(staticCtrlProxyImports(oldSource, import.meta.url)).toEqual([
    "../../src/features/observe/android/AndroidCtrlProxyClient",
    "../../src/features/observe/ios/IOSCtrlProxyClient",
  ]);
});

test("static import guard permits type-only imports, resolution and lazy loading", () => {
  const source = `
    import type { AndroidCtrlProxyClient } from "../../src/features/observe/android/AndroidCtrlProxyClient";
    import type { IOSCtrlProxyClient } from "../../src/features/observe/ios/IOSCtrlProxyClient";
    const modulePath = require.resolve("../../src/features/observe/android/AndroidCtrlProxyClient");
    const clear = () => require("../../src/features/observe/android/AndroidCtrlProxyClient");
    const load = () => import("../../src/features/observe/ios/IOSCtrlProxyClient");
  `;
  expect(staticCtrlProxyImports(source, import.meta.url)).toEqual([]);
});
