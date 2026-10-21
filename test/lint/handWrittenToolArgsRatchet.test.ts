import { beforeAll, expect, test } from "bun:test";

import { join } from "node:path";
import { parseGuardSource, relativePosix, typeScriptFiles, readGuardFile } from "./astGuard";

/**
 * Hand-written `interface *Args` types in `src/server` (and in the tool-backing managers moved
 * out of it, `TOOL_MANAGER_FILES`) drift from the zod wire schema (#6154).
 * `defineDeviceTool` / `definePlainTool` (src/server/defineTool.ts) infer handler args from the
 * schema, and a schema-shaped alias is `z.output<typeof schema>` (#11824). Migrating a type removes
 * its interface and its entry here; a count may only shrink, so a new tool defines its args through
 * the schema rather than adding another interface.
 *
 * Shapes that are not a tool's wire input are deliberately outside the ratchet and are named
 * `*Input` / `*QueryParams` rather than `*Args`: resource URI query parameters (no tool schema),
 * the narrowed per-action slices the prototype handlers read from the already-validated
 * `prototypeSchema` output, and internal service request shapes. What remains below is owned by
 * other in-flight lanes (navigation, interaction, device tools).
 *
 * Moving a manager out of `src/server` must not take its tool args out of the ratchet (#14525):
 * the daemon snapshot manager's capture/restore args are `z.output` of the shapes the
 * `deviceSnapshot` schema is built from (src/models/deviceSnapshotArgsSchema.ts), and it stays
 * scanned at a zero baseline so a hand-written replacement fails here.
 */
const BASELINE: Readonly<Record<string, number>> = {
  "server/interactionToolTypes.ts": 1,
  "server/navigationTools.ts": 3,
  "server/setActiveDevice.ts": 2,
};

const SRC_DIR = join(import.meta.dir, "..", "..", "src");
const SERVER_DIR = join(SRC_DIR, "server");
/** Managers outside `src/server` whose argument types are populated from a tool's validated args. */
const TOOL_MANAGER_FILES = [join(SRC_DIR, "daemon", "deviceSnapshotManager.ts")];
const ARGS_NAME = /^[A-Za-z]+Args$/;

/** Top-level `interface *Args` declarations, exported or not, found by parsing the file. */
function argsInterfaceCount(file: string): number {
  const source = readGuardFile(file);
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

let counts: Record<string, number> = {};

// The scan and oxc parsing are file-system work, so they run once outside the per-test budget.
beforeAll(() => {
  counts = Object.fromEntries(
    [...typeScriptFiles(SERVER_DIR), ...TOOL_MANAGER_FILES]
      .map((file) => [relativePosix(SRC_DIR, file), argsInterfaceCount(file)] as const)
      .filter(([, count]) => count > 0),
  );
});

test("no file grows its hand-written *Args interface count", () => {
  const grown = Object.entries(counts).filter(([file, count]) => count > (BASELINE[file] ?? 0));
  expect(
    grown,
    `New hand-written *Args interfaces in src/server or a tool manager (file, count). Derive the type from the schema (z.output<typeof schema>) or define the tool with defineDeviceTool/definePlainTool.`,
  ).toEqual([]);
});

test("baseline has no stale entries", () => {
  const stale = Object.entries(BASELINE).filter(([file, max]) => (counts[file] ?? 0) < max);
  expect(
    stale,
    `Baseline entries above the actual count (file, baseline): lower or delete them so the ratchet keeps shrinking.`,
  ).toEqual([]);
});
