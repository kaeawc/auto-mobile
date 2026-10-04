import { FakeScreenshotPathProtection } from "../../fakes/FakeScreenshotPathProtection";
import { describe, expect, test } from "bun:test";
import path from "node:path";
import { TakeScreenshot } from "../../../src/features/observe/TakeScreenshot";
import type { ScreenshotFileWriter } from "../../../src/features/observe/screenshot/ScreenshotFileWriter";
import { OPERATION_CANCELLED_MESSAGE } from "../../../src/utils/constants";
import { shellQuote } from "../../../src/utils/shellQuote";
import { screenshotTempIdToken } from "../../../src/utils/screenshot/screenshotFormats";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeFileSystem } from "../../fakes/FakeFileSystem";
import { FakeIdGenerator } from "../../fakes/FakeIdGenerator";
import { FakeTimer } from "../../fakes/FakeTimer";
import { androidFilePullDevice } from "./takeScreenshotTestHelpers";

const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function writerFor(fileSystem: FakeFileSystem): ScreenshotFileWriter {
  return {
    async write(filePath, data) {
      fileSystem.setBinaryFile(filePath, data);
    },
    async remove(filePath) {
      await fileSystem.remove(filePath);
    },
  };
}

describe("Android file-pull screenshots", function () {
  test("rejects a quiet screencap failure before pulling a stale frame and cleans up", async function () {
    const fakeAdb = new FakeAdbExecutor();
    const fileSystem = new FakeFileSystem();
    fakeAdb.setCommandResponse("screencap -p", { stdout: "AM_SCREENCAP_RC:1", stderr: "" });
    const screenshot = new TakeScreenshot(
      androidFilePullDevice,
      new FakeAdbClientFactory(fakeAdb),
      new FakeTimer(),
      new FakeIdGenerator(["quiet-failure"]),
      writerFor(fileSystem),
      fileSystem,
      () => "/screenshots/cache",
      undefined,
      undefined,
      { pathProtection: new FakeScreenshotPathProtection(new FakeTimer()) },
    );
    await expect(
      (screenshot as any).captureScreenshotFilePull("/screenshots/quiet-failure.png", {
        format: "png",
      }),
    ).rejects.toThrow("Screencap failed");
    const commands = fakeAdb.getExecutedCommands();
    expect(commands.some((command) => command.startsWith("pull "))).toBe(false);
    const tempFile = `/sdcard/screenshot_${screenshotTempIdToken("quiet-failure")}.png`;
    expect(commands).toContain(`shell rm -f ${tempFile}`);
  });

  test("uses and removes a unique device-side file for every successful file pull", async function () {
    const fakeAdb = new FakeAdbExecutor();
    const fileSystem = new FakeFileSystem();
    fakeAdb.setCommandResponse("screencap -p", { stdout: "AM_SCREENCAP_RC:0", stderr: "" });
    const localDir = "/screenshots/file-pull";
    const screenshot = new TakeScreenshot(
      androidFilePullDevice,
      new FakeAdbClientFactory(fakeAdb),
      new FakeTimer(),
      new FakeIdGenerator(["first", "second"]),
      writerFor(fileSystem),
      fileSystem,
      () => "/screenshots/cache",
      undefined,
      undefined,
      { pathProtection: new FakeScreenshotPathProtection(new FakeTimer()) },
    );
    const firstPath = path.join(localDir, "first.png");
    const secondPath = path.join(localDir, "second.png");
    fileSystem.setBinaryFile(`${firstPath}.temp`, pngBytes);
    await (screenshot as any).captureScreenshotFilePull(firstPath, { format: "png" });
    fileSystem.setBinaryFile(`${secondPath}.temp`, pngBytes);
    await (screenshot as any).captureScreenshotFilePull(secondPath, { format: "png" });
    const commands = fakeAdb.getExecutedCommands();
    const screencaps = commands.filter((command) => command.includes("screencap -p"));
    const removals = commands.filter((command) => command.startsWith("shell rm -f "));
    const pulls = commands.filter((command) => command.startsWith("pull "));
    expect(screencaps).toHaveLength(2);
    const firstTempFile = `/sdcard/screenshot_${screenshotTempIdToken("first")}.png`;
    const secondTempFile = `/sdcard/screenshot_${screenshotTempIdToken("second")}.png`;
    expect(screencaps[0]).toContain(firstTempFile);
    expect(screencaps[1]).toContain(secondTempFile);
    expect(removals).toEqual([`shell rm -f ${firstTempFile}`, `shell rm -f ${secondTempFile}`]);
    expect(pulls).toEqual([
      `pull ${firstTempFile} ${firstPath}.temp`,
      `pull ${secondTempFile} ${secondPath}.temp`,
    ]);
    expect(fileSystem.existsSync(firstPath)).toBe(true);
    expect(fileSystem.existsSync(secondPath)).toBe(true);
    expect(fileSystem.existsSync(`${firstPath}.temp`)).toBe(false);
    expect(fileSystem.existsSync(`${secondPath}.temp`)).toBe(false);
  });

  test("cancels after pulling without leaving a stale final screenshot", async function () {
    const fakeAdb = new FakeAdbExecutor();
    const fileSystem = new FakeFileSystem();
    fakeAdb.setCommandResponse("screencap -p", { stdout: "AM_SCREENCAP_RC:0", stderr: "" });
    const controller = new AbortController();
    fakeAdb.abortAfterCommand("pull ", controller);
    const localDir = "/screenshots/file-pull";
    const finalPath = path.join(localDir, "cancelled.png");
    const screenshot = new TakeScreenshot(
      androidFilePullDevice,
      new FakeAdbClientFactory(fakeAdb),
      new FakeTimer(),
      new FakeIdGenerator(["cancelled"]),
      writerFor(fileSystem),
      fileSystem,
      () => "/screenshots/cache",
      undefined,
      undefined,
      { pathProtection: new FakeScreenshotPathProtection(new FakeTimer()) },
    );
    fileSystem.setBinaryFile(`${finalPath}.temp`, pngBytes);
    await expect(
      (screenshot as any).captureScreenshotFilePull(
        finalPath,
        { format: "png" },
        controller.signal,
      ),
    ).resolves.toEqual({ success: false, error: OPERATION_CANCELLED_MESSAGE });
    expect(fileSystem.existsSync(finalPath)).toBe(false);
    expect(fileSystem.existsSync(`${finalPath}.temp`)).toBe(false);
    expect(fakeAdb.getExecutedCommands()).toContain(
      `shell rm -f /sdcard/screenshot_${screenshotTempIdToken("cancelled")}.png`,
    );
  });

  test("sanitizes malicious device temp ids and preserves pull argv boundaries", async function () {
    const fakeAdb = new FakeAdbExecutor();
    const fileSystem = new FakeFileSystem();
    fakeAdb.setCommandResponse("screencap -p", { stdout: "AM_SCREENCAP_RC:0", stderr: "" });
    const localDir = "/screenshots/file-pull";
    const screenshot = new TakeScreenshot(
      androidFilePullDevice,
      new FakeAdbClientFactory(fakeAdb),
      new FakeTimer(),
      new FakeIdGenerator(["../evil id; rm -rf /"]),
      writerFor(fileSystem),
      fileSystem,
      () => "/screenshots/cache",
      undefined,
      undefined,
      { pathProtection: new FakeScreenshotPathProtection(new FakeTimer()) },
    );
    const finalPath = path.join(localDir, "malicious.png");
    const tempFile = `/sdcard/screenshot_${screenshotTempIdToken("../evil id; rm -rf /")}.png`;
    fileSystem.setBinaryFile(`${finalPath}.temp`, pngBytes);
    await (screenshot as any).captureScreenshotFilePull(finalPath, { format: "png" });
    const commands = fakeAdb.getExecutedCommands();
    expect(commands).toContain(
      `shell "screencap -p ${shellQuote(tempFile)} ; echo AM_SCREENCAP_RC:$?"`,
    );
    expect(commands).toContain(`shell rm -f ${tempFile}`);
    expect(fakeAdb.getExecutedArgv()).toContainEqual(["pull", tempFile, `${finalPath}.temp`]);
    expect(fileSystem.existsSync(finalPath)).toBe(true);
    expect(fileSystem.existsSync(`${finalPath}.temp`)).toBe(false);
  });

  test("preserves uniqueness when sanitized ids collide and never consumes a fallback id", function () {
    const fileSystem = new FakeFileSystem();
    const screenshot = new TakeScreenshot(
      androidFilePullDevice,
      new FakeAdbClientFactory(new FakeAdbExecutor()),
      new FakeTimer(),
      new FakeIdGenerator(["unused"]),
      undefined,
      fileSystem,
      () => "/screenshots/cache",
      undefined,
      undefined,
      { pathProtection: new FakeScreenshotPathProtection(new FakeTimer()) },
    );
    const first = (screenshot as any).sanitizeDeviceTempId("a_b");
    const second = (screenshot as any).sanitizeDeviceTempId("ab");
    expect(first.startsWith("ab-")).toBe(true);
    expect(second.startsWith("ab-")).toBe(true);
    expect(first).not.toBe(second);
    expect((screenshot as any).sanitizeDeviceTempId(";../")).toBe(screenshotTempIdToken(";../"));
  });
});
