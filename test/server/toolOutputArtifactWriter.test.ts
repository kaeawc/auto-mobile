import { describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
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
import { logger } from "../../src/utils/logger";

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
  /**
   * A spill artifact is advertised as the COMPLETE payload, so the writer — not
   * each call site — is the single place that decides how it is serialized. The
   * `extras`-stripping serializer is the daemon's INLINE observation rendering
   * only; if the writer ever adopts it as its default, an extras-heavy payload
   * spills to a file with the very bytes that triggered the spill missing, and
   * they then exist nowhere at all (#6870 review, PRRT_kwDOP-GF5M6h5Djd).
   */
  test("round-trips `extras` for every caller, whatever the spill path", () => {
    const cases: Array<{ name: string; input: Record<string, unknown> }> = [
      {
        name: "observation-only spill (no `serialized`)",
        input: {
          tool: "observe",
          payload: "ObserveResult",
          data: { elements: [{ text: "Submit", extras: { role: "button" } }] },
        },
      },
      {
        name: "whole-response spill (no `serialized`)",
        input: {
          tool: "tapOn",
          payload: "ToolResponse",
          data: { success: true, detail: { extras: { accessibility: "x" } } },
        },
      },
    ];

    for (const { name, input } of cases) {
      const fileSystem = new FakeArtifactFileSystem();
      const timer = new FakeTimer();
      timer.setCurrentTime(1234);
      const writer = new JsonToolOutputArtifactWriter({
        outputDirectory: path.resolve("/tmp/auto-mobile artifacts"),
        fileSystem,
        idGenerator: new FakeIdGenerator(["id-1"]),
        timer,
      });

      writer.writeJsonArtifact(input as never);

      expect(JSON.parse(fileSystem.writes[0].content), name).toEqual(input.data as never);
    }
  });

  test("writes JSON artifacts with deterministic metadata and caches directory validation", () => {
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
    expect(fileSystem.ensureCalls).toEqual([outputDirectory]);
    expect(fileSystem.assertWritableCalls).toEqual([outputDirectory]);
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

  test("bounds directory validation and prune passes across repeated writes", () => {
    const fileSystem = new FakeArtifactFileSystem();
    const timer = new FakeTimer();
    const writer = new JsonToolOutputArtifactWriter({
      outputDirectory: "/tmp/artifacts",
      fileSystem,
      idGenerator: new FakeIdGenerator(Array.from({ length: 100 }, (_, index) => `id-${index}`)),
      timer,
      retention: { maxAgeMs: 1_000, maxFiles: 500, overflowMinAgeMs: 500 },
    });

    for (let index = 0; index < 100; index += 1) {
      writer.writeJsonArtifact({ tool: "observe", payload: "ObserveResult", data: { index } });
    }

    expect(fileSystem.ensureCalls).toHaveLength(1);
    expect(fileSystem.assertWritableCalls).toHaveLength(1);
    expect(fileSystem.listCalls).toHaveLength(1);
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
    const stalePath = path.join(outputDirectory, "1000000000000-observe-old.json");
    ledger.record(stalePath);
    fileSystem.entries = [
      { path: stalePath, name: "1000000000000-observe-old.json", isFile: true, mtimeMs: 1_000 },
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

    expect(ledger.resolve("1000000000000-observe-old.json")?.path).toBe(stalePath);

    writer.writeJsonArtifact({ tool: "observe", payload: "ObserveResult", data: { updatedAt: 1 } });

    expect(fileSystem.deleteCalls).toEqual([stalePath]);
    // A pruned file is no longer resolvable through the ledger.
    expect(ledger.resolve("1000000000000-observe-old.json")).toBeUndefined();
  });

  test("prunes expired files again after the timer interval", () => {
    const fileSystem = new FakeArtifactFileSystem();
    const timer = new FakeTimer();
    timer.setCurrentTime(10_000);
    const outputDirectory = path.resolve("/tmp/auto-mobile artifacts");
    const stalePath = path.join(outputDirectory, "1000000000000-observe-old.json");
    const writer = new JsonToolOutputArtifactWriter({
      outputDirectory,
      fileSystem,
      idGenerator: new FakeIdGenerator(["one", "two"]),
      timer,
      retention: { maxAgeMs: 1_000, maxFiles: 500, overflowMinAgeMs: 500 },
    });
    writer.writeJsonArtifact({ tool: "observe", payload: "ObserveResult", data: {} });
    fileSystem.entries = [
      { path: stalePath, name: "1000000000000-observe-old.json", isFile: true, mtimeMs: 1_000 },
    ];
    timer.advanceTime(60_000);
    writer.writeJsonArtifact({ tool: "observe", payload: "ObserveResult", data: {} });
    expect(fileSystem.listCalls).toHaveLength(2);
    expect(fileSystem.deleteCalls).toEqual([stalePath]);
  });

  test("logs a concurrent ENOENT prune race at debug", () => {
    const fileSystem = new FakeArtifactFileSystem();
    const stalePath = "/tmp/artifacts/1000000000004-observe-stale.json";
    fileSystem.entries = [
      { path: stalePath, name: "1000000000004-observe-stale.json", isFile: true, mtimeMs: 0 },
    ];
    fileSystem.deleteFile = () => {
      throw Object.assign(new Error("gone"), { code: "ENOENT" });
    };
    const debug = spyOn(logger, "debug").mockImplementation(() => {});
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const timer = new FakeTimer();
      timer.setCurrentTime(10);
      const writer = new JsonToolOutputArtifactWriter({
        outputDirectory: "/tmp/artifacts",
        fileSystem,
        idGenerator: new FakeIdGenerator(["id"]),
        timer,
        retention: { maxAgeMs: 1, maxFiles: 500, overflowMinAgeMs: 1 },
      });
      writer.writeJsonArtifact({ tool: "observe", payload: "ObserveResult", data: {} });
      expect(debug).toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      debug.mockRestore();
      warn.mockRestore();
    }
  });

  test("prunes stale JSON artifacts when retention is configured", () => {
    const fileSystem = new FakeArtifactFileSystem();
    const outputDirectory = path.resolve("/tmp/auto-mobile artifacts");
    fileSystem.entries = [
      {
        path: path.join(outputDirectory, "1000000000000-observe-old.json"),
        name: "1000000000000-observe-old.json",
        isFile: true,
        mtimeMs: 1_000,
      },
      {
        path: path.join(outputDirectory, "1000000000001-observe-recent.json"),
        name: "1000000000001-observe-recent.json",
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
    expect(fileSystem.deleteCalls).toEqual([
      path.join(outputDirectory, "1000000000000-observe-old.json"),
    ]);
    expect(fileSystem.writes).toHaveLength(1);
  });

  // #10078: the output directory may be a user-chosen directory with unrelated
  // content, so the prune may only delete files shaped like the writer's own.
  describe("retention prune is limited to files the writer issued (#10078)", () => {
    const outputDirectory = path.resolve("/tmp/auto-mobile artifacts");
    const expiredEntry = (name: string): ToolOutputArtifactDirectoryEntry => ({
      path: path.join(outputDirectory, name),
      name,
      isFile: true,
      mtimeMs: 1_000,
    });
    const writerFor = (
      fileSystem: ToolOutputArtifactFileSystem,
      options: { ledger?: ToolOutputArtifactLedger; maxFiles?: number } = {},
    ) => {
      const timer = new FakeTimer();
      timer.setCurrentTime(10_000);
      return new JsonToolOutputArtifactWriter({
        outputDirectory,
        fileSystem,
        idGenerator: new FakeIdGenerator(["id"]),
        timer,
        ledger: options.ledger ?? new ToolOutputArtifactLedger(),
        retention: { maxAgeMs: 1_000, maxFiles: options.maxFiles ?? 500, overflowMinAgeMs: 500 },
      });
    };
    const write = (writer: JsonToolOutputArtifactWriter) =>
      writer.writeJsonArtifact({ tool: "observe", payload: "ObserveResult", data: {} });

    test("leaves expired foreign JSON files alone and deletes only the writer-shaped one", () => {
      const fileSystem = new FakeArtifactFileSystem();
      fileSystem.entries = [
        expiredEntry("package.json"),
        expiredEntry("old-observe.json"),
        expiredEntry("2024-01-15-report.json"),
        expiredEntry("1-note.json"),
        expiredEntry("1700000000000-fixture.json"),
        expiredEntry("1700000000000-observe-abc.json"),
      ];

      write(writerFor(fileSystem));

      expect(fileSystem.deleteCalls).toEqual([
        path.join(outputDirectory, "1700000000000-observe-abc.json"),
      ]);
    });

    test("counts only writer-shaped files toward the maxFiles overflow", () => {
      const fileSystem = new FakeArtifactFileSystem();
      // Fresh enough to dodge the age rule (maxAge 1000 at now 10000) but older
      // than the overflow gate (500).
      const fresh = (name: string, mtimeMs: number) => ({ ...expiredEntry(name), mtimeMs });
      fileSystem.entries = [
        fresh("a.json", 9_100),
        fresh("b.json", 9_100),
        fresh("c.json", 9_100),
        fresh("1700000000001-observe-one.json", 9_200),
        fresh("1700000000002-observe-two.json", 9_300),
      ];

      // Two issued files with maxFiles 1: exactly one overflows. The three
      // foreign files must not inflate the count or be deleted.
      write(writerFor(fileSystem, { maxFiles: 1 }));

      expect(fileSystem.deleteCalls).toEqual([
        path.join(outputDirectory, "1700000000001-observe-one.json"),
      ]);
    });

    test("prunes a file this process recorded in the ledger even if its name is off-shape", () => {
      const fileSystem = new FakeArtifactFileSystem();
      const ledger = new ToolOutputArtifactLedger();
      const issued = expiredEntry("1234-my-tool-id.json");
      const lookalike = expiredEntry("5678-my-tool-id.json");
      ledger.record(issued.path);
      fileSystem.entries = [issued, lookalike];

      write(writerFor(fileSystem, { ledger }));

      expect(fileSystem.deleteCalls).toEqual([issued.path]);
    });

    test("on a real directory, foreign files survive and issued files are pruned", () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "am-artifact-prune-"));
      try {
        const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
        const seed = (name: string) => {
          const filePath = path.join(dir, name);
          fs.writeFileSync(filePath, "{}");
          fs.utimesSync(filePath, old, old);
          return filePath;
        };
        const foreign = ["package.json", "old-observe.json", "2024-01-15-report.json"].map(seed);
        const issued = seed("1700000000000-observe-abc.json");
        const timer = new FakeTimer();
        timer.setCurrentTime(Date.now());
        const writer = new JsonToolOutputArtifactWriter({
          outputDirectory: dir,
          idGenerator: new FakeIdGenerator(["id"]),
          timer,
          ledger: new ToolOutputArtifactLedger(),
          retention: { maxAgeMs: 24 * 60 * 60 * 1000, maxFiles: 500, overflowMinAgeMs: 1000 },
        });

        write(writer);

        for (const filePath of foreign) {
          expect(fs.existsSync(filePath), filePath).toBe(true);
        }
        expect(fs.existsSync(issued)).toBe(false);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  test("prunes file-count overflow only after the overflow age gate", () => {
    const fileSystem = new FakeArtifactFileSystem();
    const outputDirectory = path.resolve("/tmp/auto-mobile artifacts");
    fileSystem.entries = [
      {
        path: path.join(outputDirectory, "1000000000002-observe-older.json"),
        name: "1000000000002-observe-older.json",
        isFile: true,
        mtimeMs: 1_000,
      },
      {
        path: path.join(outputDirectory, "1000000000003-observe-fresh.json"),
        name: "1000000000003-observe-fresh.json",
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

    expect(fileSystem.deleteCalls).toEqual([
      path.join(outputDirectory, "1000000000002-observe-older.json"),
    ]);
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
