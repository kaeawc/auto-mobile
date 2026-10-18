import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseGuardSource, relativePosix, typeScriptFiles } from "./astGuard";

/**
 * Hand-written `interface *Args` types in `src/server` drift from the zod wire schema (#6154).
 * `defineDeviceTool` / `definePlainTool` (src/server/defineTool.ts) infer handler args from the
 * schema, and a schema-shaped alias is `z.output<typeof schema>` (#11824). Migrating a type removes
 * its interface and its entry here; a count may only shrink, so a new tool defines its args through
 * the schema rather than adding another interface.
 */
const BASELINE: Readonly<Record<string, number>> = {
  "appFileContract.ts": 2,
  "biometricTools.ts": 1,
  "deviceSnapshotManager.ts": 2,
  "downloadsFixtureContract.ts": 1,
  "fileSourcePreparation.ts": 1,
  "interactionToolTypes.ts": 8,
  "navigationTools.ts": 3,
  "notificationTools.ts": 1,
  "performanceData.ts": 1,
  "prototypePatchAction.ts": 1,
  "prototypeReverse.ts": 1,
  "prototypeSavedActions.ts": 1,
  "setActiveDevice.ts": 2,
  "sharedStorageContract.ts": 1,
  "testRunResources.ts": 1,
  "testTimingData.ts": 1,
};

const SERVER_DIR = join(import.meta.dir, "..", "..", "src", "server");
const ARGS_NAME = /^[A-Za-z]+Args$/;

/** Top-level `interface *Args` declarations, exported or not, found by parsing the file. */
function argsInterfaceCount(file: string): number {
  const source = readFileSync(file, "utf8");
  // Cheap prefilter: parsing is only needed for files that could declare such an interface.
  if (!/interface [A-Za-z]+Args/.test(source)) {
    return 0;
  }
  return parseGuardSource(file, source).body.filter((node) => {
    const declaration =
      node.type === "ExportNamedDeclaration" ? (node.declaration ?? undefined) : node;
    return declaration?.type === "TSInterfaceDeclaration" && ARGS_NAME.test(declaration.id.name);
  }).length;
}

test("hand-written *Args interfaces in src/server only shrink, per file", () => {
  const counts = Object.fromEntries(
    typeScriptFiles(SERVER_DIR)
      .map((file) => [relativePosix(SERVER_DIR, file), argsInterfaceCount(file)] as const)
      .filter(([, count]) => count > 0),
  );
  const grown = Object.entries(counts).filter(([file, count]) => count > (BASELINE[file] ?? 0));
  expect(
    grown,
    `New hand-written *Args interfaces in src/server (file, count). Derive the type from the schema (z.output<typeof schema>) or define the tool with defineDeviceTool/definePlainTool.`,
  ).toEqual([]);
  const stale = Object.entries(BASELINE).filter(([file, max]) => (counts[file] ?? 0) < max);
  expect(
    stale,
    `Baseline entries above the actual count (file, baseline): lower or delete them so the ratchet keeps shrinking.`,
  ).toEqual([]);
});
