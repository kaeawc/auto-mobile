import { describe, expect, test } from "bun:test";
import {
  JsonToolOutputArtifactWriter,
  type ToolOutputArtifactFileSystem,
} from "../../src/server/toolOutputArtifactWriter";
import { stringifyToolResponse } from "../../src/utils/toolUtils";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";
import { DAEMON_LAUNCH_CWD_ENV } from "../../src/utils/workingDirectory";

class FakeArtifactFileSystem implements ToolOutputArtifactFileSystem {
  ensureCalls: string[] = [];
  assertWritableCalls: string[] = [];
  writes: Array<{ path: string; content: string; mode: number }> = [];
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
}

describe("JsonToolOutputArtifactWriter", () => {
  test("writes JSON artifacts with deterministic metadata and validates per call", () => {
    const fileSystem = new FakeArtifactFileSystem();
    const idGenerator = new FakeIdGenerator(["id/1", "id/2"]);
    const timer = new FakeTimer();
    timer.setCurrentTime(1234);
    const writer = new JsonToolOutputArtifactWriter({
      outputDirectory: "/tmp/auto-mobile artifacts",
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

    expect(fileSystem.ensureCalls).toEqual(["/tmp/auto-mobile artifacts", "/tmp/auto-mobile artifacts"]);
    expect(fileSystem.assertWritableCalls).toEqual(["/tmp/auto-mobile artifacts", "/tmp/auto-mobile artifacts"]);
    expect(fileSystem.writes[0]).toEqual({
      path: "/tmp/auto-mobile artifacts/1234-tapOn-id_1.json",
      content: stringifyToolResponse({ viewHierarchy: { hierarchy: { node: { text: "Hello" } } } }),
      mode: 0o600,
    });
    expect(first).toEqual({
      artifact: {
        path: "/tmp/auto-mobile artifacts/1234-tapOn-id_1.json",
        format: "json",
        payload: "ObserveResult",
        bytes: Buffer.byteLength(fileSystem.writes[0].content, "utf8"),
        tool: "tapOn",
      },
    });
    expect(second.artifact.path).toBe("/tmp/auto-mobile artifacts/1234-tapOn-id_2.json");
  });

  test("resolves relative artifact directories from the daemon launch cwd", () => {
    const originalLaunchCwd = process.env[DAEMON_LAUNCH_CWD_ENV];
    process.env[DAEMON_LAUNCH_CWD_ENV] = "/workspace/project";
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

      expect(fileSystem.ensureCalls).toEqual(["/workspace/project/scratch/artifacts"]);
      expect(metadata.artifact.path).toBe("/workspace/project/scratch/artifacts/0-observe-id.json");
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

    expect(() => writer.writeJsonArtifact({
      tool: "observe",
      payload: "ObserveResult",
      data: { updatedAt: 1 },
    })).toThrow("Failed to write ObserveResult artifact for observe: disk full");
  });
});
