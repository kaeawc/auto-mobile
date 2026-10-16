import type { Comparison, RunOutcome } from "./compare";
import type { TranscriptAudit } from "./transcript";

/** Everything one suite run produced; serialized as `result.json` in the run directory. */
export interface BenchmarkResult {
  suite: string;
  suitePath: string;
  runDirectory: string;
  startedAt: string;
  deviceSerial: string;
  claude: {
    requestedModel?: string;
    observedModel?: string;
    version?: string;
  };
  preflight: { log: string[]; durationSeconds: number };
  outcome: RunOutcome;
  audit: TranscriptAudit;
  comparison: Comparison;
}
