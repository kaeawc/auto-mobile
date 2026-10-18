import { runBoundaryRowCli } from "./lib/boundaryCli";

/**
 * Usage: bun scripts/check-boundary-row.ts <row-id> [<unified-diff-file>]
 * Runs one row of the table-driven boundary scanner (issue #13219). Diff rows
 * scan the files in a unified diff of src/; `tree` rows scan all of src/.
 */
const [rowId, diffPath] = process.argv.slice(2);
runBoundaryRowCli(rowId, diffPath);
