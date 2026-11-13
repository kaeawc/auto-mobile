import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  DhuScreenshotHashSource,
  headUnitScreenshotDirectories,
} from "../../../src/features/androidAuto/HeadUnitScreenshotHash";
import { FakeFileSystem } from "../../fakes/FakeFileSystem";
import { FakeIdGenerator } from "../../fakes/FakeIdGenerator";
import { FakeTimer } from "../../fakes/FakeTimer";

const DIRECTORY = path.join("tmp", "dhu");
const FILE = path.join(DIRECTORY, "automobile-head-unit-capture-1.png");

interface Head {
  /** What the DHU reports; `undefined` models a console that cannot tell. */
  videoFocus?: boolean;
}

function setup(
  onScreenshot: (files: FakeFileSystem, file: string, head: Head) => void,
  options: { head?: Head; directories?: string[] } = {},
) {
  const files = new FakeFileSystem();
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const commands: string[] = [];
  const head = options.head ?? {};
  const source = new DhuScreenshotHashSource(
    {
      sendCommand: (command) => {
        commands.push(command);
        onScreenshot(files, command.slice("screenshot ".length), head);
      },
      isRunning: () => true,
      ...("videoFocus" in head ? { hasVideoFocus: () => head.videoFocus ?? true } : {}),
    },
    {
      files,
      timer,
      ids: new FakeIdGenerator(["capture-1"]),
      directories: options.directories ?? [DIRECTORY],
      timing: { pollMs: 50, timeoutMs: 500 },
    },
  );
  return { files, commands, source, timer };
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

  test("sends nothing and returns at once while the DHU reports no video focus", async () => {
    const { commands, source, timer } = setup(() => {}, { head: { videoFocus: false } });
    expect(await source.hash()).toBeUndefined();
    expect(commands).toEqual([]);
    expect(timer.now()).toBe(0);
  });

  test("stops waiting as soon as the DHU refuses the capture for lack of video focus", async () => {
    const { commands, source, timer } = setup(
      (_fs, _file, head) => {
        head.videoFocus = false;
      },
      { head: { videoFocus: true } },
    );
    expect(await source.hash()).toBeUndefined();
    expect(commands).toEqual([`screenshot ${FILE}`]);
    expect(timer.now()).toBe(50);
  });

  test("a temp directory with a space falls back to the next space-free directory", async () => {
    const fallback = path.join("Users", "Public");
    const { commands, source } = setup((fs, file) => fs.setFile(file, "png-bytes"), {
      directories: [path.join("Users", "First Last", "Temp"), fallback],
    });
    expect(await source.hash()).toBeDefined();
    expect(commands).toEqual([
      `screenshot ${path.join(fallback, "automobile-head-unit-capture-1.png")}`,
    ]);
  });

  test("sends no command when every directory has whitespace", async () => {
    const { commands, source, timer } = setup(() => {}, {
      directories: [path.join("Users", "First Last", "Temp")],
    });
    expect(await source.hash()).toBeUndefined();
    expect(commands).toEqual([]);
    expect(timer.now()).toBe(0);
  });
});

describe("headUnitScreenshotDirectories", () => {
  test("prefers the temp directory and adds %PUBLIC% when set", () => {
    expect(headUnitScreenshotDirectories("/tmp", {})).toEqual(["/tmp"]);
    expect(
      headUnitScreenshotDirectories("C:\\Users\\First Last\\Temp", { PUBLIC: "C:\\Users\\Public" }),
    ).toEqual(["C:\\Users\\First Last\\Temp", "C:\\Users\\Public"]);
  });
});
