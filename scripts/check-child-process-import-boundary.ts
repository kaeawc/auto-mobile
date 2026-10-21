import { runBoundaryRowCli } from "./lib/boundaryCli";

// The row lives in scripts/lib/boundaryRows.ts and its detector in
// scripts/lib/childProcessImportBoundary.ts (issue #13219); this entry point
// keeps the check's script name stable.
runBoundaryRowCli("child-process-import");
