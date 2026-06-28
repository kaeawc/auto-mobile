import { existsSync } from "node:fs";
import { homedir } from "node:os";

export function resolveStableDaemonWorkingDirectory(
  homeDirectory: string = homedir()
): string {
  if (homeDirectory.length > 0 && existsSync(homeDirectory)) {
    return homeDirectory;
  }

  return "/";
}
