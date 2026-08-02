import { logger } from "../logger";

/** Minimum guest memory required by modern Play Store system images. */
export const MIN_AVD_RAM_MB = 2048;

/**
 * Parsed AVD configuration from config.ini
 */
export interface AvdConfig {
  apiLevel?: number;
  osVersion?: string;
  screenWidth?: number;
  screenHeight?: number;
  screenDensity?: number;
  /** Configured guest memory in megabytes. */
  ramSizeMb?: number;
  deviceName?: string;
  tag?: string;
}

/**
 * Interface for reading AVD config.ini files
 */
export interface AvdConfigReader {
  readConfig(avdName: string): Promise<AvdConfig | null>;
}

/**
 * Maps Android API levels to version strings.
 * Only includes levels where the mapping is well-established.
 */
const API_LEVEL_TO_VERSION: Record<number, string> = {
  21: "5.0",
  22: "5.1",
  23: "6.0",
  24: "7.0",
  25: "7.1",
  26: "8.0",
  27: "8.1",
  28: "9",
  29: "10",
  30: "11",
  31: "12",
  32: "12L",
  33: "13",
  34: "14",
  35: "15",
  36: "16",
};

export function apiLevelToVersion(apiLevel: number): string | undefined {
  return API_LEVEL_TO_VERSION[apiLevel];
}

/**
 * Reads AVD config.ini files from the AVD home directory.
 */
export class FileAvdConfigReader implements AvdConfigReader {
  private readFileFn: (path: string, encoding: string) => Promise<string>;
  private existsFn: (path: string) => boolean;
  private avdHome: string;

  constructor(
    readFileFn?: (path: string, encoding: string) => Promise<string>,
    existsFn?: (path: string) => boolean,
    avdHome?: string,
  ) {
    const fs = require("fs");
    const path = require("path");
    this.readFileFn = readFileFn ?? ((p: string, e: string) => fs.promises.readFile(p, e));
    this.existsFn = existsFn ?? ((p: string) => fs.existsSync(p));

    const homeDir = process.env.HOME || process.env.USERPROFILE;
    this.avdHome = avdHome ?? process.env.ANDROID_AVD_HOME ?? (homeDir ? path.join(homeDir, ".android", "avd") : "");
  }

  async readConfig(avdName: string): Promise<AvdConfig | null> {
    const path = require("path");
    const configPath = path.join(this.avdHome, `${avdName}.avd`, "config.ini");

    if (!this.existsFn(configPath)) {
      logger.debug(`AVD config.ini not found: ${configPath}`);
      return null;
    }

    try {
      const content = await this.readFileFn(configPath, "utf-8");
      return parseAvdConfig(content);
    } catch (error) {
      logger.warn(`Failed to read AVD config for ${avdName}: ${error}`);
      return null;
    }
  }
}

/**
 * Parse AVD config.ini content into structured data.
 */
export function parseAvdConfig(content: string): AvdConfig {
  const props = new Map<string, string>();
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {continue;}
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 0) {continue;}
    props.set(trimmed.slice(0, eqIdx).trim(), trimmed.slice(eqIdx + 1).trim());
  }

  const config: AvdConfig = {};

  // Screen dimensions
  const width = props.get("hw.lcd.width");
  if (width) {config.screenWidth = Number.parseInt(width, 10) || undefined;}

  const height = props.get("hw.lcd.height");
  if (height) {config.screenHeight = Number.parseInt(height, 10) || undefined;}

  const density = props.get("hw.lcd.density");
  if (density) {config.screenDensity = Number.parseInt(density, 10) || undefined;}

  const ramSize = props.get("hw.ramSize");
  if (ramSize) {
    const parsedRamSize = Number.parseInt(ramSize, 10);
    if (Number.isFinite(parsedRamSize)) {config.ramSizeMb = parsedRamSize;}
  }

  // Device name (form factor hint)
  const deviceName = props.get("hw.device.name");
  if (deviceName) {config.deviceName = deviceName;}

  // Tag
  const tag = props.get("tag.id");
  if (tag) {config.tag = tag;}

  // API level from image.sysdir.1 path
  // Typical: system-images/android-34/google_apis/arm64-v8a/
  const sysdir = props.get("image.sysdir.1");
  if (sysdir) {
    const match = sysdir.match(/android-(\d+)/);
    if (match) {
      const level = Number.parseInt(match[1], 10);
      config.apiLevel = level;
      config.osVersion = apiLevelToVersion(level) ?? String(level);
    }
  }

  return config;
}
