import { describe, expect, test } from "bun:test";
import path from "node:path";
import {
  DirectoryFixtureCaptureWriter,
  type CaptureFileSystem,
} from "../../../src/utils/fixtureCapture/FixtureCaptureWriter";
import type { ToolCallCapture } from "../../../src/utils/fixtureCapture/fixtureCaptureFormat";
import { FakeIdGenerator } from "../../fakes/FakeIdGenerator";
import { FakeTimer } from "../../fakes/FakeTimer";

class FakeCaptureFileSystem implements CaptureFileSystem {
  readonly dirs: string[] = [];
  readonly files = new Map<string, string>();
  failWrites = false;

  async mkdir(dir: string): Promise<unknown> {
    this.dirs.push(dir);
    return undefined;
  }

  async writeFile(file: string, contents: string): Promise<void> {
    if (this.failWrites) {
      throw new Error("EACCES");
    }
    this.files.set(file, contents);
  }
}

const capture: ToolCallCapture = {
  provenance: {
    schemaVersion: 1,
    tool: { name: "observe" },
    captureDate: "2026-11-19T12:00:00.000Z",
    automobileVersion: "0.0.96+gabc1234",
    sourceTreeState: "clean",
  },
  commands: [
    { index: 0, argv: ["adb", "devices"], exitCode: 0, durationMs: 3, stdout: "x", stderr: "" },
  ],
};

function writerWith(fs: FakeCaptureFileSystem): DirectoryFixtureCaptureWriter {
  const timer = new FakeTimer();
  timer.setCurrentTime(1000);
  return new DirectoryFixtureCaptureWriter("/captures", timer, new FakeIdGenerator(["id1"]), fs);
}

describe("DirectoryFixtureCaptureWriter", () => {
  test("writes provenance.json and commands.json into one directory per tool call", async () => {
    const fs = new FakeCaptureFileSystem();
    await writerWith(fs).write(capture);
    const dir = path.join("/captures", "observe_1000_id1");
    expect(fs.dirs).toEqual([dir]);
    expect(JSON.parse(fs.files.get(path.join(dir, "provenance.json")) ?? "")).toEqual(
      capture.provenance,
    );
    expect(JSON.parse(fs.files.get(path.join(dir, "commands.json")) ?? "")).toEqual(
      capture.commands,
    );
  });

  test("never throws when the directory cannot be written", async () => {
    const fs = new FakeCaptureFileSystem();
    fs.failWrites = true;
    await writerWith(fs).write(capture);
    expect(fs.files.size).toBe(0);
  });
});
