import { writeSync } from "node:fs";
import { terminateCliProcess } from "../../src/cli/termination";
import { defaultTimer } from "../../src/utils/SystemTimer";

// This timer represents an abandoned read-only diagnostic socket/handle. A
// normal event-loop exit would wait for it; a bounded repair result must not.
defaultTimer.setInterval(() => {}, 60_000);
writeSync(1, `${JSON.stringify({ status: "failed", phase: "verification" })}\n`);
terminateCliProcess(
  { exitCode: 1 },
  {
    terminate: (exitCode) => process.exit(exitCode),
  },
);
