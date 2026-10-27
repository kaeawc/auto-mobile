import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  androidAvdConfigurationSchema,
  androidAvdConfigurationKeys,
  type AndroidAvdConfiguration,
} from "../models/AndroidAvdConfiguration";
import { resolveAndroidAvdHome } from "../utils/android-cmdline-tools/AvdConfigReader";
import { awaitWhileRequestIsLive, throwIfAborted } from "../utils/toolUtils";
import { ProvisionDeviceError } from "./ProvisionDeviceError";

export interface AndroidAvdConfigWriteOptions {
  signal?: AbortSignal;
}

export interface AndroidAvdConfigWriter {
  setMemoryMb(
    avdName: string,
    memoryMb: number,
    options?: AndroidAvdConfigWriteOptions,
  ): Promise<void>;
  setConfiguration?(
    avdName: string,
    configuration: AndroidAvdConfiguration,
    options?: AndroidAvdConfigWriteOptions,
  ): Promise<void>;
}

interface FileAndroidAvdConfigWriterDependencies {
  readFile(path: string, encoding: "utf8"): Promise<string>;
  writeFile(path: string, content: string, encoding: "utf8"): Promise<void>;
  environment: NodeJS.ProcessEnv;
  homeDirectory: () => string;
}

function defaultAndroidAvdConfigWriterDependencies(): FileAndroidAvdConfigWriterDependencies {
  return {
    readFile: (path, encoding) => fs.readFile(path, encoding),
    writeFile: (path, content, encoding) => fs.writeFile(path, content, encoding),
    environment: process.env,
    homeDirectory: homedir,
  };
}

function configWriteSignal(
  options: AndroidAvdConfigWriteOptions | undefined,
): AbortSignal | undefined {
  return options?.signal;
}

/**
 * Applies a small, typed subset of AVD hardware configuration after
 * `avdmanager create avd`. The caller creates only default-path AVDs, so the
 * standard AVD-home location is authoritative here.
 */
export class FileAndroidAvdConfigWriter implements AndroidAvdConfigWriter {
  constructor(
    private readonly dependencies: FileAndroidAvdConfigWriterDependencies = defaultAndroidAvdConfigWriterDependencies(),
  ) {}

  async setMemoryMb(
    avdName: string,
    memoryMb: number,
    options?: AndroidAvdConfigWriteOptions,
  ): Promise<void> {
    if (!Number.isInteger(memoryMb) || memoryMb <= 0) {
      throw new ProvisionDeviceError(
        "platform_command_failed",
        `Android AVD memoryMb must be a positive integer; got ${memoryMb}.`,
      );
    }
    return this.setConfiguration(avdName, { memoryMb }, options);
  }

  async setConfiguration(
    avdName: string,
    configuration: AndroidAvdConfiguration,
    options?: AndroidAvdConfigWriteOptions,
  ): Promise<void> {
    const signal = configWriteSignal(options);
    throwIfAborted(signal);
    const validated = androidAvdConfigurationSchema.parse(configuration);
    const replacements = new Map<string, string>();
    for (const key of Object.keys(validated) as (keyof AndroidAvdConfiguration)[]) {
      const value = validated[key];
      if (value !== undefined) {
        replacements.set(
          androidAvdConfigurationKeys[key],
          typeof value === "boolean" ? (value ? "yes" : "no") : String(value),
        );
      }
    }
    if (validated.gpuMode !== undefined) {
      replacements.set("hw.gpu.enabled", "yes");
    }
    const avdHome = resolveAndroidAvdHome(
      this.dependencies.environment,
      this.dependencies.homeDirectory(),
    );
    const configPath = join(avdHome, `${avdName}.avd`, "config.ini");
    const content = await awaitWhileRequestIsLive(
      this.dependencies.readFile(configPath, "utf8"),
      signal,
    );
    // A timed-out provision may have rolled this AVD back while the read was
    // pending. Never apply its captured content to a same-name replacement.
    throwIfAborted(signal);
    const lines = content.split(/\r?\n/);
    const replaced = new Set<string>();
    const updated = lines.map((line) => {
      const key = line.slice(0, line.indexOf("=")).trim();
      if (replacements.has(key)) {
        replaced.add(key);
        return `${key}=${replacements.get(key)}`;
      }
      return line;
    });
    for (const [key, value] of replacements) {
      if (replaced.has(key)) {
        continue;
      }
      if (updated.at(-1) !== "") {
        updated.push("");
      }
      updated.push(`${key}=${value}`, "");
    }
    throwIfAborted(signal);
    await this.dependencies.writeFile(configPath, updated.join("\n"), "utf8");
  }
}
