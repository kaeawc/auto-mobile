import { readFileSync } from "node:fs";
import { sortedReaddirEntriesSync } from "../../src/utils/io";
import { BOUNDARY_ROWS } from "./boundaryRows";
import {
  type ChangedFile,
  parseUnifiedDiff,
  renderBoundaryResult,
  scanBoundary,
  treeTooSmallMessage,
} from "./boundaryScanner";

const SOURCE_ROOT = "src";

/** Every `.ts` file under `directory`, as sorted forward-slash repo paths. */
function sourceFiles(directory: string, extensions: readonly string[]): string[] {
  return sortedReaddirEntriesSync(directory).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      return sourceFiles(path, extensions);
    }
    return entry.isFile() && extensions.some((extension) => entry.name.endsWith(extension))
      ? [path]
      : [];
  });
}

function readSource(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    // A path in the diff that is absent on disk (deleted or renamed away) has nothing to scan.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

/**
 * Runs one row of the table-driven boundary scanner (issue #13219) and exits.
 * Diff rows read a unified diff of src/ from `diffPath`; `tree` rows walk their
 * `treeRoot` (default `src/`) and take no diff, or scan only `targets` when given.
 * Exit 1 on violations, 2 on usage errors.
 */
export function runBoundaryRowCli(
  rowId: string | undefined,
  diffPath?: string,
  targets: readonly string[] = [],
): never {
  const row = BOUNDARY_ROWS.find((candidate) => candidate.id === rowId);
  if (!row || (row.scope !== "tree" && !diffPath)) {
    console.error(
      `usage: check-boundary-row.ts <${BOUNDARY_ROWS.map((candidate) => candidate.id).join("|")}> [<diff-file>]`,
    );
    process.exit(2);
  }
  const changed: ChangedFile[] =
    row.scope === "tree"
      ? (targets.length > 0
          ? targets.map((target) => target.replaceAll("\\", "/"))
          : sourceFiles(row.treeRoot ?? SOURCE_ROOT, row.extensions ?? [".ts"])
        ).map((path) => ({ path, addedLines: new Set<number>() }))
      : parseUnifiedDiff(readFileSync(diffPath!, "utf8"));
  const tooSmall =
    row.scope === "tree" && targets.length === 0
      ? treeTooSmallMessage(row, changed.length)
      : undefined;
  if (tooSmall) {
    console.error(tooSmall);
    process.exit(1);
  }
  const result = renderBoundaryResult(row, scanBoundary(row, changed, { readSource }));
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exit(result.exitCode);
}
