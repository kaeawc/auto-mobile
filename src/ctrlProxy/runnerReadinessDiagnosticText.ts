import { errorMessage } from "../utils/describeUnknownError";
import { redactAndroidCommandOutput } from "../utils/android-cmdline-tools/redactAndroidCommandOutput";

const MAX_DIAGNOSTIC_LENGTH = 4_000;

export function phaseElapsedLabel(phase: string): string {
  switch (phase) {
    case "package-compatibility":
      return "packageCompatibilityElapsedMs";
    case "runner-setup":
      return "runnerSetupElapsedMs";
    case "runner-connect":
      return "connectElapsedMs";
    case "runner-health":
      return "healthElapsedMs";
    default:
      return `${phase}ElapsedMs`;
  }
}

export function normalizeDiagnostic(error: unknown): string {
  const raw = errorMessage(error);
  const redacted = redactAndroidCommandOutput(raw);
  if (redacted.length <= MAX_DIAGNOSTIC_LENGTH) {
    return redacted;
  }
  const half = Math.floor((MAX_DIAGNOSTIC_LENGTH - 32) / 2);
  return `${redacted.slice(0, half)}\n...[diagnostic truncated]...\n${redacted.slice(-half)}`;
}
