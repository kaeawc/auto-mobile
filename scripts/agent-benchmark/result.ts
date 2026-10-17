import type { Comparison, RunOutcome } from "./compare";
import type { TranscriptAudit } from "./transcript";

/** Everything one suite run produced; serialized as `result.json` in the run directory. */
export interface BenchmarkResult {
  suite: string;
  suitePath: string;
  runDirectory: string;
  startedAt: string;
  deviceSerial: string;
  /** Digest of the prompt, suite settings, and requested model (see suiteDigest). */
  suiteDigest: string;
  /** `sha256=<prefix>` of the AutoMobile server bundle; a stale build reads as different. */
  serverBuild: string;
  claude: {
    requestedModel?: string;
    observedModel?: string;
    version?: string;
  };
  /** appBuild: the installed app's versionName/versionCode/lastUpdateTime fingerprint. */
  /** device: SDK/model/locale/size/density fingerprint (see describeDevice). */
  preflight: { log: string[]; durationSeconds: number; appBuild: string; device: string };
  outcome: RunOutcome;
  audit: TranscriptAudit;
  comparison: Comparison;
}
