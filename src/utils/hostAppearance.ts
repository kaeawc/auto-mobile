import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AppearanceMode } from "../models";
import { DefaultHostDefaultsClient, type HostDefaultsClient } from "./HostDefaultsClient";
import { logger } from "./logger";

const execFileAsync = promisify(execFile);

type CommandResult = {
  stdout: string;
  stderr: string;
};

async function runCommand(command: string, args: string[]): Promise<CommandResult | null> {
  try {
    const result = await execFileAsync(command, args, { timeout: 2000 });
    return {
      stdout: result.stdout ? result.stdout.toString() : "",
      stderr: result.stderr ? result.stderr.toString() : "",
    };
  } catch (error) {
    // Command may not exist on this host, or the queried key/scheme may be unset
    // (e.g. no AppleInterfaceStyle default in light mode); null just means "unknown",
    // so callers fall through to the next detection method or a light-mode default.
    logger.debug(`src/utils/hostAppearance.ts fallback failed: ${error}`, error);
    return null;
  }
}

function isDarkThemeValue(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized.includes("dark") || normalized.includes("prefer-dark");
}

export async function detectHostAppearance(
  hostDefaults: HostDefaultsClient = new DefaultHostDefaultsClient()
): Promise<AppearanceMode> {
  if (hostDefaults.isSupported()) {
    const style = await hostDefaults.readGlobal("AppleInterfaceStyle");
    return style?.toLowerCase() === "dark" ? "dark" : "light";
  }

  if (process.platform === "linux") {
    const gnomeScheme = await runCommand("gsettings", [
      "get",
      "org.gnome.desktop.interface",
      "color-scheme",
    ]);
    if (gnomeScheme?.stdout) {
      return isDarkThemeValue(gnomeScheme.stdout) ? "dark" : "light";
    }

    const gnomeTheme = await runCommand("gsettings", [
      "get",
      "org.gnome.desktop.interface",
      "gtk-theme",
    ]);
    if (gnomeTheme?.stdout) {
      return isDarkThemeValue(gnomeTheme.stdout) ? "dark" : "light";
    }

    const kdeTheme = await runCommand("kreadconfig5", [
      "--group",
      "General",
      "--key",
      "ColorScheme",
    ]) ?? await runCommand("kreadconfig6", [
      "--group",
      "General",
      "--key",
      "ColorScheme",
    ]);
    if (kdeTheme?.stdout) {
      return isDarkThemeValue(kdeTheme.stdout) ? "dark" : "light";
    }
  }

  logger.debug("[HostAppearance] Falling back to light appearance (unsupported host)");
  return "light";
}
