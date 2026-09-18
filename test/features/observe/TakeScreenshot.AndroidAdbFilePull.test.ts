import { describe, expect, test } from "bun:test";
import { promises as fsPromises } from "node:fs";
import os from "node:os";
import path from "node:path";
import { TakeScreenshot } from "../../../src/features/observe/TakeScreenshot";
import { OPERATION_CANCELLED_MESSAGE } from "../../../src/utils/constants";
import { shellQuote } from "../../../src/utils/shellQuote";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeIdGenerator } from "../../fakes/FakeIdGenerator";
import { FakeTimer } from "../../fakes/FakeTimer";
import { androidFilePullDevice } from "./takeScreenshotTestHelpers";

describe("Android file-pull screenshots", function () {
  test("rejects a quiet screencap failure before pulling a stale frame and cleans up", async function () {
    const fakeAdb = new FakeAdbExecutor();
    fakeAdb.setCommandResponse("screencap -p", { stdout: "AM_SCREENCAP_RC:1", stderr: "" });
    const screenshot = new TakeScreenshot(
      androidFilePullDevice,
      new FakeAdbClientFactory(fakeAdb),
      new FakeTimer(),
      new FakeIdGenerator(["quiet-failure"]),
    );
    await expect(
      (screenshot as any).captureScreenshotFilePull(path.join(os.tmpdir(), "quiet-failure.png"), {
        format: "png",
      }),
    ).rejects.toThrow("Screencap failed");
    const commands = fakeAdb.getExecutedCommands();
    expect(commands.some((command) => command.startsWith("pull "))).toBe(false);
    expect(commands).toContain(`shell rm -f ${shellQuote("/sdcard/screenshot_quiet-failure.png")}`);
  });

  test("uses and removes a unique device-side file for every successful file pull", async function () {
    const fakeAdb = new FakeAdbExecutor();
    fakeAdb.setCommandResponse("screencap -p", { stdout: "AM_SCREENCAP_RC:0", stderr: "" });
    const localDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "auto-mobile-screenshot-"));
    const screenshot = new TakeScreenshot(
      androidFilePullDevice,
      new FakeAdbClientFactory(fakeAdb),
      new FakeTimer(),
      new FakeIdGenerator(["first", "second"]),
    );
    const firstPath = path.join(localDir, "first.png");
    const secondPath = path.join(localDir, "second.png");
    try {
      await fsPromises.writeFile(`${firstPath}.temp`, "first");
      await (screenshot as any).captureScreenshotFilePull(firstPath, { format: "png" });
      await fsPromises.writeFile(`${secondPath}.temp`, "second");
      await (screenshot as any).captureScreenshotFilePull(secondPath, { format: "png" });
      const commands = fakeAdb.getExecutedCommands();
      const screencaps = commands.filter((command) => command.includes("screencap -p"));
      const removals = commands.filter((command) => command.startsWith("shell rm -f "));
      const pulls = commands.filter((command) => command.startsWith("pull "));
      expect(screencaps).toHaveLength(2);
      expect(screencaps[0]).toContain("/sdcard/screenshot_first.png");
      expect(screencaps[1]).toContain("/sdcard/screenshot_second.png");
      expect(removals).toEqual([
        `shell rm -f ${shellQuote("/sdcard/screenshot_first.png")}`,
        `shell rm -f ${shellQuote("/sdcard/screenshot_second.png")}`,
      ]);
      expect(pulls).toEqual([
        `pull /sdcard/screenshot_first.png ${firstPath}.temp`,
        `pull /sdcard/screenshot_second.png ${secondPath}.temp`,
      ]);
    } finally {
      await fsPromises.rm(localDir, { recursive: true, force: true });
    }
  });

  test("cancels after pulling without leaving a stale final screenshot", async function () {
    const fakeAdb = new FakeAdbExecutor();
    fakeAdb.setCommandResponse("screencap -p", { stdout: "AM_SCREENCAP_RC:0", stderr: "" });
    const controller = new AbortController();
    fakeAdb.abortAfterCommand("pull ", controller);
    const localDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "auto-mobile-screenshot-"));
    const finalPath = path.join(localDir, "cancelled.png");
    const screenshot = new TakeScreenshot(
      androidFilePullDevice,
      new FakeAdbClientFactory(fakeAdb),
      new FakeTimer(),
      new FakeIdGenerator(["cancelled"]),
    );
    try {
      await fsPromises.writeFile(`${finalPath}.temp`, "pulled frame");
      await expect(
        (screenshot as any).captureScreenshotFilePull(
          finalPath,
          { format: "png" },
          controller.signal,
        ),
      ).resolves.toEqual({ success: false, error: OPERATION_CANCELLED_MESSAGE });
      await expect(fsPromises.access(finalPath)).rejects.toThrow();
      await expect(fsPromises.access(`${finalPath}.temp`)).rejects.toThrow();
      expect(fakeAdb.getExecutedCommands()).toContain(
        `shell rm -f ${shellQuote("/sdcard/screenshot_cancelled.png")}`,
      );
    } finally {
      await fsPromises.rm(localDir, { recursive: true, force: true });
    }
  });

  test("sanitizes malicious device temp ids and preserves pull argv boundaries", async function () {
    const fakeAdb = new FakeAdbExecutor();
    fakeAdb.setCommandResponse("screencap -p", { stdout: "AM_SCREENCAP_RC:0", stderr: "" });
    const localDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "auto-mobile-screenshot-"));
    const screenshot = new TakeScreenshot(
      androidFilePullDevice,
      new FakeAdbClientFactory(fakeAdb),
      new FakeTimer(),
      new FakeIdGenerator(["../evil id; rm -rf /"]),
    );
    const finalPath = path.join(localDir, "malicious.png");
    const tempFile = "/sdcard/screenshot_evilidrm-rf.png";
    try {
      await fsPromises.writeFile(`${finalPath}.temp`, "pulled frame");
      await (screenshot as any).captureScreenshotFilePull(finalPath, { format: "png" });
      const commands = fakeAdb.getExecutedCommands();
      expect(commands).toContain(
        `shell "screencap -p ${shellQuote(tempFile)} ; echo AM_SCREENCAP_RC:$?"`,
      );
      expect(commands).toContain(`shell rm -f ${shellQuote(tempFile)}`);
      expect(fakeAdb.getExecutedArgv()).toContainEqual(["pull", tempFile, `${finalPath}.temp`]);
    } finally {
      await fsPromises.rm(localDir, { recursive: true, force: true });
    }
  });

  test("sanitizes normal ids and falls back to a fresh id when empty", function () {
    const screenshot = new TakeScreenshot(
      androidFilePullDevice,
      new FakeAdbClientFactory(new FakeAdbExecutor()),
      new FakeTimer(),
      new FakeIdGenerator(["fallback/id"]),
    );
    expect((screenshot as any).sanitizeDeviceTempId("normal-id../!")).toBe("normal-id");
    expect((screenshot as any).sanitizeDeviceTempId(";../")).toBe("fallbackid");
  });
});
