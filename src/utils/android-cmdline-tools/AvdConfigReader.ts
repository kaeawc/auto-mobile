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
  private configHome: string;

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
    const androidUserHome = process.env.ANDROID_USER_HOME || undefined;
    const avdHomeEnv = process.env.ANDROID_AVD_HOME || undefined;
    const configHome = process.env.ANDROID_EMULATOR_HOME
      || androidUserHome
      || (process.env.ANDROID_SDK_HOME ? path.join(process.env.ANDROID_SDK_HOME, ".android") : undefined)
      || (homeDir ? path.join(homeDir, ".android") : "");
    this.avdHome = avdHome
      ?? avdHomeEnv
      ?? path.join(configHome, "avd");
    this.configHome = avdHome
      ? path.dirname(avdHome)
      : (process.env.ANDROID_EMULATOR_HOME
        || androidUserHome
        || (process.env.ANDROID_SDK_HOME ? path.join(process.env.ANDROID_SDK_HOME, ".android") : undefined)
        || (avdHomeEnv ? path.dirname(this.avdHome) : configHome));
  }

  async readConfig(avdName: string): Promise<AvdConfig | null> {
    const path = require("path");
    const conventionalConfigPath = path.join(this.avdHome, `${avdName}.avd`, "config.ini");
    let configPath = conventionalConfigPath;

    const resolvedConfigPath = await this.resolveRegistryConfigPath(avdName);
    if (resolvedConfigPath) {
      configPath = resolvedConfigPath;
    } else if (!this.existsFn(configPath)) {
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

  private async resolveRegistryConfigPath(avdName: string): Promise<string | null> {
    const path = require("path");
    const registryPath = path.join(this.avdHome, `${avdName}.ini`);
    if (!this.existsFn(registryPath)) {return null;}
    try {
      const registry = parseKeyValueProperties(await this.readFileFn(registryPath, "utf-8"));
      const candidates = registryConfigCandidates(registry, this.configHome);
      return candidates.find(candidate => this.existsFn(candidate)) ?? null;
    } catch (error) {
      logger.warn(`Failed to read AVD registry for ${avdName}: ${error}`);
      return null;
    }
  }
}

/**
 * Parse AVD config.ini content into structured data.
 */
export function parseAvdConfig(content: string): AvdConfig {
  const props = parseKeyValueProperties(content);
  return {
    ...parseScreenDimensions(props),
    ...parseRamSize(props),
    ...parseDeviceMetadata(props),
    ...parseApiMetadata(props),
  };
}

function parseKeyValueProperties(content: string): Map<string, string> {
  const props = new Map<string, string>();
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {continue;}
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 0) {continue;}
    props.set(trimmed.slice(0, eqIdx).trim(), trimmed.slice(eqIdx + 1).trim());
  }
  return props;
}

function registryConfigCandidates(props: Map<string, string>, configHome: string): string[] {
  const path = require("path");
  const candidates: string[] = [];
  const absolutePath = props.get("path");
  if (absolutePath && path.isAbsolute(absolutePath)) {
    candidates.push(path.join(absolutePath, "config.ini"));
  }

  const relativePath = props.get("path.rel");
  if (relativePath && !path.isAbsolute(relativePath)) {
    const relativeBase = path.resolve(configHome);
    const resolvedDirectory = path.resolve(relativeBase, relativePath);
    candidates.push(path.join(resolvedDirectory, "config.ini"));
  }
  return candidates;
}

function parseScreenDimensions(props: Map<string, string>): Pick<AvdConfig, "screenWidth" | "screenHeight" | "screenDensity"> {
  return {
    screenWidth: parseDimension(props.get("hw.lcd.width")),
    screenHeight: parseDimension(props.get("hw.lcd.height")),
    screenDensity: parseDimension(props.get("hw.lcd.density")),
  };
}

function parseDimension(value: string | undefined): number | undefined {
  if (!value) {return undefined;}
  const parsed = Number.parseInt(value, 10);
  return parsed || undefined;
}

function parseRamSize(props: Map<string, string>): Pick<AvdConfig, "ramSizeMb"> {
  const value = props.get("hw.ramSize");
  if (!value) {
    return {};
  }
  const match = /^(\d+)\s*(?:(k|m|g)(?:i?b)?)?$/i.exec(value);
  if (!match) {return {};}

  const amount = Number(match[1]);
  const unit = match[2]?.toLowerCase();
  const multiplier = unit === "g" ? 1024 : unit === "k" ? 1 / 1024 : 1;
  const ramSizeMb = amount * multiplier;
  return Number.isFinite(ramSizeMb) ? { ramSizeMb } : {};
}

function parseDeviceMetadata(props: Map<string, string>): Pick<AvdConfig, "deviceName" | "tag"> {
  return {
    ...(props.get("hw.device.name") ? { deviceName: props.get("hw.device.name") } : {}),
    ...(props.get("tag.id") ? { tag: props.get("tag.id") } : {}),
  };
}

function parseApiMetadata(props: Map<string, string>): Pick<AvdConfig, "apiLevel" | "osVersion"> {
  const sysdir = props.get("image.sysdir.1");
  const match = sysdir?.match(/android-(\d+)/);
  if (!match) {return {};}
  const level = Number.parseInt(match[1], 10);
  return { apiLevel: level, osVersion: apiLevelToVersion(level) ?? String(level) };
}
