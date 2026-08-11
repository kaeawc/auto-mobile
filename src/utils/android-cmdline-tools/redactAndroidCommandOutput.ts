import { homedir } from "node:os";
import { redactHomeDir } from "../redactPath";

export function redactAndroidCommandOutput(value: string, home: string = homedir()): string {
  const redactedSecrets = value.replace(
    /\b(token|password|secret|api[_-]?key)\s*[:=]\s*[^\s]+/gi,
    (_match, key: string) => `${key}=[REDACTED]`,
  );
  const redactedLeadingHome = redactHomeDir(redactedSecrets, home);
  return home.length > 0 ? redactedLeadingHome.replaceAll(home, "~") : redactedLeadingHome;
}
