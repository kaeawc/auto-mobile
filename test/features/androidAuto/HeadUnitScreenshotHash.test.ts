import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import path from "node:path";
import { DhuScreenshotHashSource } from "../../../src/features/androidAuto/HeadUnitScreenshotHash";
import { FakeFileSystem } from "../../fakes/FakeFileSystem";
import { FakeIdGenerator } from "../../fakes/FakeIdGenerator";
import { FakeTimer } from "../../fakes/FakeTimer";

const DIRECTORY = path.join("tmp", "dhu");
const FILE = path.join(DIRECTORY, "automobile-head-unit-capture-1.png");

function setup(onScreenshot: (files: FakeFileSystem, file: string) => void) {
  const files = new FakeFileSystem();
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const commands: string[] = [];
  const source = new DhuScreenshotHashSource(
    {
      sendCommand: (command) => {
        commands.push(command);
        onScreenshot(files, command.slice("screenshot ".length));
      },
      isRunning: () => true,
    },
    {
      files,
      timer,
      ids: new FakeIdGenerator(["capture-1"]),
      directory: DIRECTORY,
      timing: { pollMs: 50, timeoutMs: 500 },
    },
  );
  return { files, commands, source };
}

describe("DhuScreenshotHashSource", () => {
  test("asks the DHU for a capture and hashes it once written, then removes it", async () => {
    const { files, commands, source } = setup((fs, file) => fs.setFile(file, "png-bytes"));
    const hash = await source.hash();
    expect(commands).toEqual([`screenshot ${FILE}`]);
    expect(hash).toBe(createHash("sha256").update("png-bytes").digest("hex"));
    expect(await files.pathExists(FILE)).toBe(false);
  });

  test("no capture before the timeout is no evidence", async () => {
    const { source } = setup(() => {});
    expect(await source.hash()).toBeUndefined();
  });
});
