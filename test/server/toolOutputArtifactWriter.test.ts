import { describe, expect, test } from "bun:test";
import path from "node:path";
import {
  JsonToolOutputArtifactWriter,
  type ToolOutputArtifactDirectoryEntry,
  type ToolOutputArtifactFileSystem,
} from "../../src/server/toolOutputArtifactWriter";
import { stringifyToolResponse } from "../../src/utils/toolUtils";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";
import { DAEMON_LAUNCH_CWD_ENV } from "../../src/utils/workingDirectory";
import { ToolOutputArtifactLedger } from "../../src/server/toolOutputArtifactLedger";
import { createHash } from "node:crypto";

class FakeArtifactFileSystem implements ToolOutputArtifactFileSystem {
  ensureCalls: string[] = [];
  assertWritableCalls: string[] = [];
  writes: Array<{ path: string; content: string; mode: number }> = [];
  entries: ToolOutputArtifactDirectoryEntry[] = [];
  listCalls: string[] = [];
  deleteCalls: string[] = [];
  writeError: Error | undefined;

  ensureDirectory(dirPath: string): void {
    this.ensureCalls.push(dirPath);
  }

  assertWritableDirectory(dirPath: string): void {
    this.assertWritableCalls.push(dirPath);
  }

  writeFileExclusive(filePath: string, content: string, mode: number): void {
    if (this.writeError) {
      throw this.writeError;
    }
    this.writes.push({ path: filePath, content, mode });
  }

  listFiles(dirPath: string): ToolOutputArtifactDirectoryEntry[] {
    this.listCalls.push(dirPath);
    return this.entries;
  }

  deleteFile(filePath: string): void {
    this.deleteCalls.push(filePath);
  }
}

describe("JsonToolOutputArtifactWriter", () => {
  test("writes JSON artifacts with deterministic metadata and validates per call", () => {
    const fileSystem = new FakeArtifactFileSystem();
    const idGenerator = new FakeIdGenerator(["id/1", "id/2"]);
    const timer = new FakeTimer();
    timer.setCurrentTime(1234);
    const outputDirectory = path.resolve("/tmp/auto-mobile artifacts");
    const writer = new JsonToolOutputArtifactWriter({
      outputDirectory,
      fileSystem,
      idGenerator,
      timer,
    });

    const first = writer.writeJsonArtifact({
      tool: "tapOn",
      payload: "ObserveResult",
      data: { viewHierarchy: { hierarchy: { node: { text: "Hello" } } } },
    });
    const second = writer.writeJsonArtifact({
      tool: "tapOn",
      payload: "ObserveResult",
      data: { isDiff: true, changed: [] },
    });

    const firstPath = path.join(outputDirectory, "1234-tapOn-id_1.json");
    const secondPath = path.join(outputDirectory, "1234-tapOn-id_2.json");
    expect(fileSystem.ensureCalls).toEqual([outputDirectory, outputDirectory]);
    expect(fileSystem.assertWritableCalls).toEqual([outputDirectory, outputDirectory]);
    expect(fileSystem.writes[0]).toEqual({
      path: firstPath,
      content: stringifyToolResponse({ viewHierarchy: { hierarchy: { node: { text: "Hello" } } } }),
      mode: 0o600,
    });
    expect(first).toEqual({
      artifact: {
        path: firstPath,
        format: "json",
        payload: "ObserveResult",
        bytes: Buffer.byteLength(fileSystem.writes[0].content, "utf8"),
        tool: "tapOn",
        resourceUri: "automobile:tool-output/1234-tapOn-id_1.json",
      },
    });
    expect(second.artifact.path).toBe(secondPath);
    // The companion resource URI carries only the file basename so a client can
    // fetch the spilled JSON in-band (issue #5882), never the host path.
    expect(second.artifact.resourceUri).toBe("automobile:tool-output/1234-tapOn-id_2.json");
    expect(fileSystem.listCalls).toEqual([]);
    expect(fileSystem.deleteCalls).toEqual([]);
  });

  test("records every issued artifact in the provenance ledger (#5917)", () => {
    const fileSystem = new FakeArtifactFileSystem();
    const ledger = new ToolOutputArtifactLedger();
    const timer = new FakeTimer();
    timer.setCurrentTime(1234);
    const outputDirectory = path.resolve("/tmp/auto-mobile artifacts");
    const writer = new JsonToolOutputArtifactWriter({
      outputDirectory,
      fileSystem,
      idGenerator: new FakeIdGenerator(["id-1", "id-2"]),
      timer,
      ledger,
    });

    const first = writer.writeJsonArtifact({
      tool: "observe",
      payload: "ObserveResult",
      data: { updatedAt: 1 },
    });
    writer.writeJsonArtifact({
      tool: "observe",
      payload: "ObserveResult",
      data: { updatedAt: 2 },
    });

    // Only the exact files the writer created are resolvable; a shape-valid
    // sibling it never wrote is not. Each entry carries the SHA-256 of the exact
    // bytes written, so the resource can authorize reads by content.
    const firstHash = createHash("sha256")
      .update(stringifyToolResponse({ updatedAt: 1 }), "utf8")
      .digest("hex");
    expect(ledger.resolve("1234-observe-id-1.json")).toEqual({
      path: first.artifact.path,
      sha256: firstHash,
    });
    expect(ledger.resolve("1234-observe-id-2.json")?.sha256).toBe(
      createHash("sha256")
        .update(stringifyToolResponse({ updatedAt: 2 }), "utf8")
        .digest("hex"),
    );
    expect(ledger.resolve("1234-observe-unwritten.json")).toBeUndefined();
  });

  test("forgets pruned artifacts from the provenance ledger (#5917)", () => {
    const fileSystem = new FakeArtifactFileSystem();
    const ledger = new ToolOutputArtifactLedger();
    const outputDirectory = path.resolve("/tmp/auto-mobile artifacts");
    const stalePath = path.join(outputDirectory, "old-observe.json");
    ledger.record(stalePath);
    fileSystem.entries = [
      { path: stalePath, name: "old-observe.json", isFile: true, mtimeMs: 1_000 },
    ];
    const timer = new FakeTimer();
    timer.setCurrentTime(10_000);
    const writer = new JsonToolOutputArtifactWriter({
      outputDirectory,
      fileSystem,
      idGenerator: new FakeIdGenerator(["id"]),
      timer,
      ledger,
      retention: { maxAgeMs: 1_000, maxFiles: 500, overflowMinAgeMs: 500 },
    });

    expect(ledger.resolve("old-observe.json")?.path).toBe(stalePath);

    writer.writeJsonArtifact({ tool: "observe", payload: "ObserveResult", data: { updatedAt: 1 } });

    expect(fileSystem.deleteCalls).toEqual([stalePath]);
    // A pruned file is no longer resolvable through the ledger.
    expect(ledger.resolve("old-observe.json")).toBeUndefined();
  });

  test("prunes stale JSON artifacts when retention is configured", () => {
    const fileSystem = new FakeArtifactFileSystem();
    const outputDirectory = path.resolve("/tmp/auto-mobile artifacts");
    fileSystem.entries = [
      {
        path: path.join(outputDirectory, "old-observe.json"),
        name: "old-observe.json",
        isFile: true,
        mtimeMs: 1_000,
      },
      {
        path: path.join(outputDirectory, "recent-observe.json"),
        name: "recent-observe.json",
        isFile: true,
        mtimeMs: 9_500,
      },
      {
        path: path.join(outputDirectory, "old-note.txt"),
        name: "old-note.txt",
        isFile: true,
        mtimeMs: 1_000,
      },
      {
        path: path.join(outputDirectory, "nested"),
        name: "nested",
        isFile: false,
        mtimeMs: 1_000,
      },
    ];
    const timer = new FakeTimer();
    timer.setCurrentTime(10_000);
    const writer = new JsonToolOutputArtifactWriter({
      outputDirectory,
      fileSystem,
      idGenerator: new FakeIdGenerator(["id"]),
      timer,
      retention: { maxAgeMs: 1_000, maxFiles: 500, overflowMinAgeMs: 500 },
    });

    writer.writeJsonArtifact({
      tool: "observe",
      payload: "ObserveResult",
      data: { updatedAt: 1 },
    });

    expect(fileSystem.listCalls).toEqual([outputDirectory]);
    expect(fileSystem.deleteCalls).toEqual([path.join(outputDirectory, "old-observe.json")]);
    expect(fileSystem.writes).toHaveLength(1);
  });

  test("prunes file-count overflow only after the overflow age gate", () => {
    const fileSystem = new FakeArtifactFileSystem();
    const outputDirectory = path.resolve("/tmp/auto-mobile artifacts");
    fileSystem.entries = [
      {
        path: path.join(outputDirectory, "older-observe.json"),
        name: "older-observe.json",
        isFile: true,
        mtimeMs: 1_000,
      },
      {
        path: path.join(outputDirectory, "fresh-observe.json"),
        name: "fresh-observe.json",
        isFile: true,
        mtimeMs: 9_900,
      },
    ];
    const timer = new FakeTimer();
    timer.setCurrentTime(10_000);
    const writer = new JsonToolOutputArtifactWriter({
      outputDirectory,
      fileSystem,
      idGenerator: new FakeIdGenerator(["id"]),
      timer,
      retention: { maxAgeMs: 20_000, maxFiles: 1, overflowMinAgeMs: 5_000 },
    });

    writer.writeJsonArtifact({
      tool: "observe",
      payload: "ObserveResult",
      data: { updatedAt: 1 },
    });

    expect(fileSystem.deleteCalls).toEqual([path.join(outputDirectory, "older-observe.json")]);
  });

  test("resolves relative artifact directories from the daemon launch cwd", () => {
    const originalLaunchCwd = process.env[DAEMON_LAUNCH_CWD_ENV];
    const launchCwd = path.resolve("workspace/project");
    const expectedDir = path.join(launchCwd, "scratch/artifacts");
    process.env[DAEMON_LAUNCH_CWD_ENV] = launchCwd;
    try {
      const fileSystem = new FakeArtifactFileSystem();
      const writer = new JsonToolOutputArtifactWriter({
        outputDirectory: "scratch/artifacts",
        fileSystem,
        idGenerator: new FakeIdGenerator(["id"]),
        timer: new FakeTimer(),
      });

      const metadata = writer.writeJsonArtifact({
        tool: "observe",
        payload: "ObserveResult",
        data: { updatedAt: 1 },
      });

      expect(fileSystem.ensureCalls).toEqual([expectedDir]);
      expect(metadata.artifact.path).toBe(path.join(expectedDir, "0-observe-id.json"));
    } finally {
      if (originalLaunchCwd === undefined) {
        delete process.env[DAEMON_LAUNCH_CWD_ENV];
      } else {
        process.env[DAEMON_LAUNCH_CWD_ENV] = originalLaunchCwd;
      }
    }
  });

  test("write failures surface as actionable artifact failures", () => {
    const fileSystem = new FakeArtifactFileSystem();
    fileSystem.writeError = new Error("disk full");
    const writer = new JsonToolOutputArtifactWriter({
      outputDirectory: "/tmp/artifacts",
      fileSystem,
      idGenerator: new FakeIdGenerator(["id"]),
      timer: new FakeTimer(),
    });

    expect(() =>
      writer.writeJsonArtifact({
        tool: "observe",
        payload: "ObserveResult",
        data: { updatedAt: 1 },
      }),
    ).toThrow("Failed to write ObserveResult artifact for observe: disk full");
  });
});
