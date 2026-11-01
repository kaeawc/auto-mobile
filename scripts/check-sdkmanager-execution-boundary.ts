import { runBoundaryRowCli } from "./lib/boundaryCli";

// Full-tree sdkmanager execution boundary. The row lives in scripts/lib/boundaryRows.ts
// (issue #13219); this entry point keeps the check's script name stable.
runBoundaryRowCli("sdkmanager-execution");
