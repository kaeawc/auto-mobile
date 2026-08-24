import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ActionableError } from "../../src/models";
import { serverConfig } from "../../src/utils/ServerConfig";
import {
  getDefaultToolOutputsDir,
  getValidatedToolOutputsDirForWrite,
  parseToolOutputsDirConfig,
  validateToolOutputsDirForWrite,
  type ToolOutputsDirValidationDeps,
} from "../../src/utils/toolOutputArtifacts";

class FakeToolOutputsDirFileSystem implements ToolOutputsDirValidationDeps {
  ensureDirCalls: string[] = [];
  statCalls: string[] = [];
  accessCalls: string[] = [];
  ensureDirError: Error | undefined;
  statError: Error | undefined;
  accessError: Error | undefined;
  isDirectory = true;

  async ensureDir(dirPath: string): Promise<void> {
    this.ensureDirCalls.push(dirPath);
    if (this.ensureDirError) {
      throw this.ensureDirError;
    }
  }

  async stat(dirPath: string): Promise<{ isDirectory(): boolean }> {
    this.statCalls.push(dirPath);
    if (this.statError) {
      throw this.statError;
    }
    return { isDirectory: () => this.isDirectory };
  }

  async access(dirPath: string): Promise<void> {
    this.accessCalls.push(dirPath);
    if (this.accessError) {
      throw this.accessError;
    }
  }
}

describe("parseToolOutputsDirConfig", () => {
  test("returns undefined when no CLI flag or environment variable is configured", () => {
    expect(parseToolOutputsDirConfig([], {}, "/launch")).toBeUndefined();
  });

  test("resolves CLI paths to absolute paths from the launch working directory", () => {
    const launchCwd = path.resolve("launch-root");
    expect(parseToolOutputsDirConfig(["--tool-outputs-dir", "artifacts"], {}, launchCwd)).toBe(
      path.resolve(launchCwd, "artifacts"),
    );
  });

  test("supports the singular CLI alias", () => {
    const launchCwd = path.resolve("launch-root");
    expect(parseToolOutputsDirConfig(["--tool-output-dir", "artifacts"], {}, launchCwd)).toBe(
      path.resolve(launchCwd, "artifacts"),
    );
  });

  test("CLI flag wins over environment variable", () => {
    const launchCwd = path.resolve("launch-root");
    expect(
      parseToolOutputsDirConfig(
        ["--tool-outputs-dir", "cli-artifacts"],
        { AUTOMOBILE_TOOL_OUTPUTS_DIR: "env-artifacts" },
        launchCwd,
      ),
    ).toBe(path.resolve(launchCwd, "cli-artifacts"));
  });

  test("resolves environment variable paths to absolute paths from the launch working directory", () => {
    const launchCwd = path.resolve("launch-root");
    expect(
      parseToolOutputsDirConfig([], { AUTOMOBILE_TOOL_OUTPUTS_DIR: "env-artifacts" }, launchCwd),
    ).toBe(path.resolve(launchCwd, "env-artifacts"));
  });

  test("supports the legacy AUTO_MOBILE environment variable alias", () => {
    const launchCwd = path.resolve("launch-root");
    expect(
      parseToolOutputsDirConfig(
        [],
        { AUTO_MOBILE_TOOL_OUTPUTS_DIR: "legacy-artifacts" },
        launchCwd,
      ),
    ).toBe(path.resolve(launchCwd, "legacy-artifacts"));
  });

  test("primary environment variable wins over the legacy alias", () => {
    const launchCwd = path.resolve("launch-root");
    expect(
      parseToolOutputsDirConfig(
        [],
        {
          AUTOMOBILE_TOOL_OUTPUTS_DIR: "primary-artifacts",
          AUTO_MOBILE_TOOL_OUTPUTS_DIR: "legacy-artifacts",
        },
        launchCwd,
      ),
    ).toBe(path.resolve(launchCwd, "primary-artifacts"));
  });

  test("ignores blank configured values", () => {
    expect(
      parseToolOutputsDirConfig(
        ["--tool-outputs-dir", "   "],
        { AUTOMOBILE_TOOL_OUTPUTS_DIR: "   " },
        path.resolve("launch-root"),
      ),
    ).toBeUndefined();
  });
});

describe("getDefaultToolOutputsDir", () => {
  test("uses the stable AutoMobile data directory instead of TMPDIR", () => {
    const originalDataDir = process.env.AUTOMOBILE_DATA_DIR;
    const originalLegacyDataDir = process.env.AUTO_MOBILE_DATA_DIR;
    const originalTmpDir = process.env.TMPDIR;
    const dataDir = path.join(tmpdir(), "auto-mobile-data-dir-test");
    const ephemeralTmpDir = path.join(tmpdir(), "bunx-ephemeral-test");

    process.env.AUTOMOBILE_DATA_DIR = dataDir;
    delete process.env.AUTO_MOBILE_DATA_DIR;
    process.env.TMPDIR = ephemeralTmpDir;
    try {
      expect(getDefaultToolOutputsDir()).toBe(path.join(dataDir, "tool_outputs"));
    } finally {
      if (originalDataDir === undefined) {
        delete process.env.AUTOMOBILE_DATA_DIR;
      } else {
        process.env.AUTOMOBILE_DATA_DIR = originalDataDir;
      }
      if (originalLegacyDataDir === undefined) {
        delete process.env.AUTO_MOBILE_DATA_DIR;
      } else {
        process.env.AUTO_MOBILE_DATA_DIR = originalLegacyDataDir;
      }
      if (originalTmpDir === undefined) {
        delete process.env.TMPDIR;
      } else {
        process.env.TMPDIR = originalTmpDir;
      }
    }
  });
});

describe("validateToolOutputsDirForWrite", () => {
  test("creates missing directories and verifies writability", async () => {
    const fs = new FakeToolOutputsDirFileSystem();

    await expect(validateToolOutputsDirForWrite("/artifacts", fs)).resolves.toBe("/artifacts");

    expect(fs.ensureDirCalls).toEqual(["/artifacts"]);
    expect(fs.statCalls).toEqual(["/artifacts"]);
    expect(fs.accessCalls).toEqual(["/artifacts"]);
  });

  test("creates missing directories with the default filesystem adapter", async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "tool-output-artifacts-"));
    const artifactsDir = path.join(tempDir, "missing", "outputs");
    try {
      await expect(validateToolOutputsDirForWrite(artifactsDir)).resolves.toBe(artifactsDir);
      expect(existsSync(artifactsDir)).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("throws an actionable error when the path is not a directory", async () => {
    const fs = new FakeToolOutputsDirFileSystem();
    fs.isDirectory = false;

    await expect(validateToolOutputsDirForWrite("/artifact-file", fs)).rejects.toThrow(
      ActionableError,
    );
    await expect(validateToolOutputsDirForWrite("/artifact-file", fs)).rejects.toThrow(
      "not a directory",
    );
  });

  test("throws an actionable error when the directory cannot be created", async () => {
    const fs = new FakeToolOutputsDirFileSystem();
    fs.ensureDirError = new Error("permission denied");

    await expect(validateToolOutputsDirForWrite("/locked", fs)).rejects.toThrow(ActionableError);
    await expect(validateToolOutputsDirForWrite("/locked", fs)).rejects.toThrow(
      "Failed to create tool outputs directory",
    );
  });

  test("throws an actionable error when the directory is not writable", async () => {
    const fs = new FakeToolOutputsDirFileSystem();
    fs.accessError = new Error("EACCES");

    await expect(validateToolOutputsDirForWrite("/readonly", fs)).rejects.toThrow(ActionableError);
    await expect(validateToolOutputsDirForWrite("/readonly", fs)).rejects.toThrow("not writable");
  });

  test("revalidates on every write attempt", async () => {
    const fs = new FakeToolOutputsDirFileSystem();

    await validateToolOutputsDirForWrite("/artifacts", fs);
    await validateToolOutputsDirForWrite("/artifacts", fs);

    expect(fs.ensureDirCalls).toEqual(["/artifacts", "/artifacts"]);
    expect(fs.statCalls).toEqual(["/artifacts", "/artifacts"]);
    expect(fs.accessCalls).toEqual(["/artifacts", "/artifacts"]);
  });

  test("validates the configured directory on every write attempt", async () => {
    const fs = new FakeToolOutputsDirFileSystem();
    serverConfig.setToolOutputsDir("/configured-artifacts");
    try {
      await expect(getValidatedToolOutputsDirForWrite(fs)).resolves.toBe("/configured-artifacts");
      await expect(getValidatedToolOutputsDirForWrite(fs)).resolves.toBe("/configured-artifacts");
    } finally {
      serverConfig.setToolOutputsDir(undefined);
    }

    expect(fs.ensureDirCalls).toEqual(["/configured-artifacts", "/configured-artifacts"]);
    expect(fs.statCalls).toEqual(["/configured-artifacts", "/configured-artifacts"]);
    expect(fs.accessCalls).toEqual(["/configured-artifacts", "/configured-artifacts"]);
  });

  test("returns undefined without validation when artifact mode is disabled", async () => {
    const fs = new FakeToolOutputsDirFileSystem();
    serverConfig.setToolOutputsDir(undefined);

    await expect(getValidatedToolOutputsDirForWrite(fs)).resolves.toBeUndefined();

    expect(fs.ensureDirCalls).toEqual([]);
    expect(fs.statCalls).toEqual([]);
    expect(fs.accessCalls).toEqual([]);
  });
});
