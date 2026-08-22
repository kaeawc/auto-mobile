import { errorMessage } from "./describeUnknownError";
import { promises as fsPromises, constants as fsConstants } from "node:fs";
import path from "node:path";
import { ActionableError } from "../models";
import type { FileSystem } from "./filesystem/DefaultFileSystem";
import { serverConfig } from "./ServerConfig";
import { getTempDir, TEMP_SUBDIRS } from "./tempDir";
import { firstFlagValue } from "./cliArgs";

export const TOOL_OUTPUTS_DIR_FLAG = "--tool-outputs-dir";
export const TOOL_OUTPUT_DIR_FLAG_ALIAS = "--tool-output-dir";
export const TOOL_OUTPUTS_DIR_ENV = "AUTOMOBILE_TOOL_OUTPUTS_DIR";
export const TOOL_OUTPUTS_DIR_ENV_ALIAS = "AUTO_MOBILE_TOOL_OUTPUTS_DIR";

export interface ToolOutputsDirValidationDeps extends Pick<FileSystem, "ensureDir"> {
  stat(dirPath: string): Promise<{ isDirectory(): boolean }>;
  access(dirPath: string): Promise<void>;
}

const nodeToolOutputsDirValidationDeps: ToolOutputsDirValidationDeps = {
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
  return normalizeConfiguredPath(
    cliValue ?? env[TOOL_OUTPUTS_DIR_ENV] ?? env[TOOL_OUTPUTS_DIR_ENV_ALIAS],
    launchCwd
  );
}

export function getDefaultToolOutputsDir(): string {
  return getTempDir(TEMP_SUBDIRS.TOOL_OUTPUTS);
}

export async function validateToolOutputsDirForWrite(
  dirPath: string,
  fileSystem: ToolOutputsDirValidationDeps = nodeToolOutputsDirValidationDeps
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

export async function getValidatedToolOutputsDirForWrite(
  fileSystem: ToolOutputsDirValidationDeps = nodeToolOutputsDirValidationDeps
): Promise<string | undefined> {
  const configuredDir = serverConfig.getToolOutputsDir();
  if (!configuredDir) {
    return undefined;
  }

  return await validateToolOutputsDirForWrite(configuredDir, fileSystem);
}
