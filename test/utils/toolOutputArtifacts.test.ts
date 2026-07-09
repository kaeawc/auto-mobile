import { describe, expect, test } from "bun:test";
import path from "node:path";
import { ActionableError } from "../../src/models";
import {
  parseToolOutputsDirConfig,
  validateToolOutputsDirForWrite,
  type ToolOutputsDirFileSystem,
} from "../../src/utils/toolOutputArtifacts";

class FakeToolOutputsDirFileSystem implements ToolOutputsDirFileSystem {
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
    expect(parseToolOutputsDirConfig(
      ["--tool-outputs-dir", "artifacts"],
      {},
      "/launch"
    )).toBe(path.join("/launch", "artifacts"));
  });

  test("supports the singular CLI alias", () => {
    expect(parseToolOutputsDirConfig(
      ["--tool-output-dir", "artifacts"],
      {},
      "/launch"
    )).toBe(path.join("/launch", "artifacts"));
  });

  test("CLI flag wins over environment variable", () => {
    expect(parseToolOutputsDirConfig(
      ["--tool-outputs-dir", "cli-artifacts"],
      { AUTOMOBILE_TOOL_OUTPUTS_DIR: "env-artifacts" },
      "/launch"
    )).toBe(path.join("/launch", "cli-artifacts"));
  });

  test("resolves environment variable paths to absolute paths from the launch working directory", () => {
    expect(parseToolOutputsDirConfig(
      [],
      { AUTOMOBILE_TOOL_OUTPUTS_DIR: "env-artifacts" },
      "/launch"
    )).toBe(path.join("/launch", "env-artifacts"));
  });

  test("ignores blank configured values", () => {
    expect(parseToolOutputsDirConfig(
      ["--tool-outputs-dir", "   "],
      { AUTOMOBILE_TOOL_OUTPUTS_DIR: "   " },
      "/launch"
    )).toBeUndefined();
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

  test("throws an actionable error when the path is not a directory", async () => {
    const fs = new FakeToolOutputsDirFileSystem();
    fs.isDirectory = false;

    await expect(validateToolOutputsDirForWrite("/artifact-file", fs))
      .rejects.toThrow(ActionableError);
    await expect(validateToolOutputsDirForWrite("/artifact-file", fs))
      .rejects.toThrow("not a directory");
  });

  test("throws an actionable error when the directory cannot be created", async () => {
    const fs = new FakeToolOutputsDirFileSystem();
    fs.ensureDirError = new Error("permission denied");

    await expect(validateToolOutputsDirForWrite("/locked", fs))
      .rejects.toThrow(ActionableError);
    await expect(validateToolOutputsDirForWrite("/locked", fs))
      .rejects.toThrow("Failed to create tool outputs directory");
  });

  test("throws an actionable error when the directory is not writable", async () => {
    const fs = new FakeToolOutputsDirFileSystem();
    fs.accessError = new Error("EACCES");

    await expect(validateToolOutputsDirForWrite("/readonly", fs))
      .rejects.toThrow(ActionableError);
    await expect(validateToolOutputsDirForWrite("/readonly", fs))
      .rejects.toThrow("not writable");
  });

  test("revalidates on every write attempt", async () => {
    const fs = new FakeToolOutputsDirFileSystem();

    await validateToolOutputsDirForWrite("/artifacts", fs);
    await validateToolOutputsDirForWrite("/artifacts", fs);

    expect(fs.ensureDirCalls).toEqual(["/artifacts", "/artifacts"]);
    expect(fs.statCalls).toEqual(["/artifacts", "/artifacts"]);
    expect(fs.accessCalls).toEqual(["/artifacts", "/artifacts"]);
  });
});
