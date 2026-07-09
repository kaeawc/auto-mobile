import { promises as fsPromises, constants as fsConstants } from "node:fs";
import path from "node:path";
import { ActionableError } from "../models";

export const TOOL_OUTPUTS_DIR_FLAG = "--tool-outputs-dir";
export const TOOL_OUTPUT_DIR_FLAG_ALIAS = "--tool-output-dir";
export const TOOL_OUTPUTS_DIR_ENV = "AUTOMOBILE_TOOL_OUTPUTS_DIR";

export interface ToolOutputsDirFileSystem {
  ensureDir(dirPath: string): Promise<void>;
  stat(dirPath: string): Promise<{ isDirectory(): boolean }>;
  access(dirPath: string): Promise<void>;
}

const nodeToolOutputsDirFileSystem: ToolOutputsDirFileSystem = {
  async ensureDir(dirPath: string): Promise<void> {
    await fsPromises.mkdir(dirPath, { recursive: true });
  },

  async stat(dirPath: string): Promise<{ isDirectory(): boolean }> {
    return await fsPromises.stat(dirPath);
  },

  async access(dirPath: string): Promise<void> {
    await fsPromises.access(dirPath, fsConstants.W_OK);
  },
};

function firstFlagValue(args: string[], flags: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (!flags.includes(args[i])) {
      continue;
    }
    const value = args[i + 1];
    if (!value || value.startsWith("--")) {
      return undefined;
    }
    return value;
  }
  return undefined;
}

function normalizeConfiguredPath(value: string | undefined, launchCwd: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  return path.isAbsolute(trimmed) ? trimmed : path.resolve(launchCwd, trimmed);
}

export function parseToolOutputsDirConfig(
  args: string[],
  env: NodeJS.ProcessEnv,
  launchCwd: string
): string | undefined {
  const cliValue = firstFlagValue(args, [TOOL_OUTPUTS_DIR_FLAG, TOOL_OUTPUT_DIR_FLAG_ALIAS]);
  return normalizeConfiguredPath(cliValue ?? env[TOOL_OUTPUTS_DIR_ENV], launchCwd);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function validateToolOutputsDirForWrite(
  dirPath: string,
  fileSystem: ToolOutputsDirFileSystem = nodeToolOutputsDirFileSystem
): Promise<string> {
  try {
    await fileSystem.ensureDir(dirPath);
  } catch (error) {
    throw new ActionableError(
      `Failed to create tool outputs directory "${dirPath}": ${errorMessage(error)}`
    );
  }

  let stats: { isDirectory(): boolean };
  try {
    stats = await fileSystem.stat(dirPath);
  } catch (error) {
    throw new ActionableError(
      `Failed to inspect tool outputs directory "${dirPath}": ${errorMessage(error)}`
    );
  }

  if (!stats.isDirectory()) {
    throw new ActionableError(`Configured tool outputs path "${dirPath}" is not a directory`);
  }

  try {
    await fileSystem.access(dirPath);
  } catch (error) {
    throw new ActionableError(
      `Configured tool outputs directory "${dirPath}" is not writable: ${errorMessage(error)}`
    );
  }

  return dirPath;
}
