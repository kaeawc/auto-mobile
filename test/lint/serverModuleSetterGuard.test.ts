import { typeScriptFiles, relativePosix, readGuardFile, parseGuardSource } from "./astGuard";
import { beforeAll, describe, expect, test } from "bun:test";

import path from "node:path";

/**
 * #11831: `src/server` modules take their collaborators as `register*Tools(deps = {})` /
 * `create*Handler(deps)` arguments, not through exported module-level setters a test must
 * remember to reset. This fails on any exported `set*`/`reset*` function or const whose name
 * ends in `Factory`, `ForTesting` or `Dependencies`.
 */
const SETTER_NAME = /^(?:set|reset)[A-Z]\w*(?:Factory|ForTesting|Dependencies)$/;
const REPO_ROOT = path.join(import.meta.dir, "..", "..");
const SERVER_DIR = path.join(REPO_ROOT, "src", "server");
// Parsing every src/server file can exceed Bun's default hook limit on loaded CI runners.
const TREE_SCAN_HOOK_TIMEOUT_MS = 30_000;

/**
 * The setters left from the original 87. This list may only shrink: delete an entry in the PR
 * that replaces its setter with an injected dependency.
 */
const REMAINING: ReadonlySet<string> = new Set([
  // Fronts the process-wide segmented-session registry shared by videoRecording and device
  // teardown; it goes when that registry is injected instead of module-level.
  "src/server/videoRecordingSegments.ts\tsetSegmentedSessionRecordingDependencies",
]);

export function exportedSetterNames(file: string, source: string): string[] {
  if (!/\bexport\b/.test(source) || !/\b(?:set|reset)[A-Z]/.test(source)) {
    return [];
  }
  const names: string[] = [];
  for (const statement of parseGuardSource(file, source).body) {
    if (statement.type !== "ExportNamedDeclaration" || !statement.declaration) {
      continue;
    }
    const declaration = statement.declaration;
    if (declaration.type === "FunctionDeclaration" && declaration.id) {
      names.push(declaration.id.name);
    } else if (declaration.type === "VariableDeclaration") {
      for (const declarator of declaration.declarations) {
        if (declarator.id.type === "Identifier") {
          names.push(declarator.id.name);
        }
      }
    }
  }
  return names.filter((name) => SETTER_NAME.test(name));
}

describe("src/server exported setter guard", () => {
  let found: string[];
  beforeAll(() => {
    found = typeScriptFiles(SERVER_DIR)
      .flatMap((file) =>
        exportedSetterNames(file, readGuardFile(file)).map(
          (name) => `${relativePosix(REPO_ROOT, file)}\t${name}`,
        ),
      )
      .sort();
  }, TREE_SCAN_HOOK_TIMEOUT_MS);

  test("detector finds exported setter functions and consts only", () => {
    const source = [
      "export function setFooFactory() {}",
      "export async function resetBarDependencies() {}",
      "export const setBazForTesting = () => {};",
      "function setPrivateFactory() {}",
      "export function setPostureHandler() {}",
      "export function createFooHandler() {}",
    ].join("\n");
    expect(exportedSetterNames("x.ts", source)).toEqual([
      "setFooFactory",
      "resetBarDependencies",
      "setBazForTesting",
    ]);
  });

  test("no new exported setters", () => {
    expect(
      found.filter((entry) => !REMAINING.has(entry)),
      "Take the collaborator as a register*/create* dependency instead of an exported setter.",
    ).toEqual([]);
  });

  test("the remaining list is tight, so removing a setter must shrink it", () => {
    expect([...REMAINING].filter((entry) => !found.includes(entry))).toEqual([]);
  });
});
