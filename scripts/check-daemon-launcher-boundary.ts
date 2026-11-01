import { runBoundaryRowCli } from "./lib/boundaryCli";

// Daemon-launcher boundary over src/daemon, or over the files named on the command line. The row
// lives in scripts/lib/boundaryRows.ts (issue #13219); this entry point keeps the check's script
// name stable.
runBoundaryRowCli("daemon-launcher", undefined, process.argv.slice(2));
