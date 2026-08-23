import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * Bootstrap process.env so spawn/exec can find platform tooling even when the
 * MCP server is launched with a stripped environment (e.g. by an embedding host
 * that does not forward the user's shell PATH).
 *
 * - Adds standard system bin directories to PATH.
 * - Defaults ANDROID_HOME to the conventional per-OS SDK install location when
 *   it is not already set and the directory exists.
 *
 * Safe to call multiple times; only adds entries that are missing.
 */
export function bootstrapEnvironment(): void {
  ensureSystemPath();
  ensureAndroidHome();
}

function ensureSystemPath(): void {
  const sep = path.delimiter;
  const current = process.env.PATH ?? "";
  const existing = new Set(current.split(sep).filter(Boolean));

  const candidates = systemPathCandidates();
  const additions: string[] = [];
  for (const candidate of candidates) {
    if (!existing.has(candidate) && directoryExists(candidate)) {
      additions.push(candidate);
      existing.add(candidate);
    }
  }

  if (additions.length === 0) {
    return;
  }

  process.env.PATH =
    current.length > 0 ? `${current}${sep}${additions.join(sep)}` : additions.join(sep);
}

function ensureAndroidHome(): void {
  if (process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT) {
    return;
  }

  for (const candidate of androidHomeCandidates()) {
    if (directoryExists(candidate)) {
      process.env.ANDROID_HOME = candidate;
      return;
    }
  }
}

function systemPathCandidates(): string[] {
  const platform = process.platform;
  const home = os.homedir();

  if (platform === "darwin") {
    return [
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
      "/usr/local/bin",
      "/usr/local/sbin",
      "/opt/homebrew/bin",
      "/opt/homebrew/sbin",
      path.join(home, "Library/Android/sdk/platform-tools"),
      path.join(home, "Library/Android/sdk/emulator"),
      path.join(home, "Library/Android/sdk/cmdline-tools/latest/bin"),
    ];
  }

  if (platform === "linux") {
    return [
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
      "/usr/local/bin",
      "/usr/local/sbin",
      path.join(home, "Android/Sdk/platform-tools"),
      path.join(home, "Android/Sdk/emulator"),
      path.join(home, "Android/Sdk/cmdline-tools/latest/bin"),
    ];
  }

  if (platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA;
    const sdk = localAppData ? path.join(localAppData, "Android", "Sdk") : "";
    return [
      ...(sdk
        ? [
            path.join(sdk, "platform-tools"),
            path.join(sdk, "emulator"),
            path.join(sdk, "cmdline-tools", "latest", "bin"),
          ]
        : []),
    ];
  }

  return [];
}

function androidHomeCandidates(): string[] {
  const home = os.homedir();
  const platform = process.platform;

  if (platform === "darwin") {
    return [path.join(home, "Library/Android/sdk")];
  }

  if (platform === "linux") {
    return [path.join(home, "Android/Sdk")];
  }

  if (platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA;
    return localAppData ? [path.join(localAppData, "Android", "Sdk")] : [];
  }

  return [];
}

function directoryExists(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    // Bootstrap runs before logger setup; missing tool directories are expected.
  }
  return false;
}
