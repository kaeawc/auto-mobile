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
  /** appBuild: the installed app's versionName/versionCode/lastUpdateTime fingerprint. */
  preflight: { log: string[]; durationSeconds: number; appBuild: string };
  outcome: RunOutcome;
  audit: TranscriptAudit;
  comparison: Comparison;
}
