import { readFileSync } from "node:fs";
import { BOUNDARY_ROWS } from "./lib/boundaryRows";
import { parseUnifiedDiff, renderBoundaryResult, scanBoundary } from "./lib/boundaryScanner";

/**
 * Usage: bun scripts/check-boundary-row.ts <row-id> <unified-diff-file>
 * Runs one row of the table-driven boundary scanner (issue #13219) over the
 * files in a unified diff of src/. Exit 1 on violations, 2 on usage errors.
 */
const [rowId, diffPath] = process.argv.slice(2);
const row = BOUNDARY_ROWS.find((candidate) => candidate.id === rowId);
if (!row || !diffPath) {
  console.error(
    `usage: check-boundary-row.ts <${BOUNDARY_ROWS.map((candidate) => candidate.id).join("|")}> <diff-file>`,
  );
  process.exit(2);
}

const violations = scanBoundary(row, parseUnifiedDiff(readFileSync(diffPath, "utf8")), {
  readSource: (path) => {
    try {
      return readFileSync(path, "utf8");
    } catch (error) {
      // A path in the diff that is absent on disk (deleted or renamed away) has nothing to scan.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  },
});
const result = renderBoundaryResult(row, violations);
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exit(result.exitCode);
