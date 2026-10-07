import { logger } from "../../src/utils/logger";
import { runWithAbortSignal } from "../../src/utils/AbortContext";
import { describe, expect, spyOn, test } from "bun:test";
import {
  createSharedStorageServiceForTesting,
  type SharedStorageFileSystem,
  type StageSharedStorageRequest,
} from "../../src/server/sharedStorageService";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeTimer } from "../fakes/FakeTimer";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";
import { shellQuote } from "../../src/utils/shellQuote";
import type { BootedDevice } from "../../src/models";

// A push is staged to a hidden temp and renamed into place, so an aborted transfer never leaves a
// truncated file at the destination; the media-scan URI is percent-encoded per path segment.

const androidDevice: BootedDevice = {
  deviceId: "emulator-5554",
  name: "Pixel",
  platform: "android",
};
const DIR = "/storage/emulated/0/Download/ns";
const MARKER = "AUTOMOBILE_SHARED_STORAGE_BACKUP";
const SCAN = "am broadcast --user 0 -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d";

const fileSystem: SharedStorageFileSystem = {
  stat: async () => ({ size: 3, isFile: () => true }),
  mkdtemp: async () => "/fake/unused",
  writeFileBuffer: async () => {},
  rm: async () => {},
};

function execResult(stdout: string) {
  return {
    stdout,
    stderr: "",
    toString: () => stdout,
    trim: () => stdout.trim(),
    includes: (text: string) => stdout.includes(text),
  };
}

function setup() {
  const executor = new FakeAdbExecutor();
  executor.setCommandResponse("content query", execResult("Row: 0 _id=42"));
  const service = createSharedStorageServiceForTesting({
    adbFactory: { create: () => executor },
    fileSystem,
    timer: new FakeTimer(),
    idGenerator: new CountingIdGenerator("t"),
  });
  const stage = (
    request: Partial<StageSharedStorageRequest> & Pick<StageSharedStorageRequest, "files">,
  ) => service.stage({ device: androidDevice, namespace: "ns", ...request });
  return { executor, stage };
}

function fileAt(name: string) {
  return { sourcePath: `/fixtures/${name}`, destinationPath: name };
}

const q = (path: string) => shellQuote(path);

describe("sharedStorageService pushes through a hidden temp file", () => {
  test("pushes beside the destination, then renames into place (one extra adb call per file)", async () => {
    const { executor, stage } = setup();

    await stage({ files: [fileAt("docs/a.txt")] });

    const temp = `${DIR}/docs/.automobile-t-1.part`;
    // Before: resolve user, mkdir x2, push. After: the same plus one `mv -f` per file.
    expect(executor.getExecutedCommands()).toEqual([
      "shell am get-current-user",
      `shell mkdir -p ${q(DIR)}`,
      `shell mkdir -p ${q(`${DIR}/docs`)}`,
      `push /fixtures/docs/a.txt ${temp}`,
      `shell mv -f ${q(temp)} ${q(`${DIR}/docs/a.txt`)}`,
    ]);
    // Hidden and non-media, so MediaStore never lists the in-flight copy.
    expect(temp).toMatch(/\/\.[^/]+\.part$/);
  });

  test("scans and queries the final destination, never the temp copy", async () => {
    const { executor, stage } = setup();

    await stage({ files: [fileAt("pic.png")] });

    const commands = executor.getExecutedCommands();
    const mv = commands.findIndex((command) => command.startsWith("shell mv -f"));
    const scan = commands.findIndex((command) => command.includes("MEDIA_SCANNER_SCAN_FILE"));
    expect(mv).toBeGreaterThan(-1);
    expect(scan).toBeGreaterThan(mv);
    expect(commands[scan]).toContain(`file://${DIR}/pic.png`);
    expect(commands.filter((command) => command.includes(".part"))).toHaveLength(2);
  });

  test("a push that fails removes the temp and never touches the destination", async () => {
    const { executor, stage } = setup();
    executor.setCommandError("push /fixtures/only.txt", new Error("push cut off"));

    await expect(stage({ files: [fileAt("only.txt")] })).rejects.toThrow("push cut off");

    const commands = executor.getExecutedCommands();
    expect(commands.slice(-2)).toEqual([
      `push /fixtures/only.txt ${DIR}/.automobile-t-1.part`,
      `shell rm -f ${q(`${DIR}/.automobile-t-1.part`)}`,
    ]);
    expect(commands.filter((command) => command.includes(" mv "))).toEqual([]);
    expect(commands.some((command) => command.includes(q(`${DIR}/only.txt`)))).toBe(false);
  });

  test("a batch without rollback keeps committed files and removes only the failed temp", async () => {
    const { executor, stage } = setup();
    executor.setCommandError("push /fixtures/b.txt", new Error("push cut off"));

    await expect(stage({ files: [fileAt("a.txt"), fileAt("b.txt")] })).rejects.toThrow(
      "push cut off",
    );

    const commands = executor.getExecutedCommands();
    expect(commands).toContain(
      `shell mv -f ${q(`${DIR}/.automobile-t-1.part`)} ${q(`${DIR}/a.txt`)}`,
    );
    expect(commands.at(-1)).toBe(`shell rm -f ${q(`${DIR}/.automobile-t-2.part`)}`);
    expect(commands.filter((command) => command.startsWith("shell rm -f"))).toHaveLength(1);
  });

  test("a failed rename removes the temp and reports the rename failure", async () => {
    const { executor, stage } = setup();
    executor.setCommandError("mv -f", new Error("rename denied"));

    await expect(stage({ files: [fileAt("only.txt")] })).rejects.toThrow("rename denied");

    expect(executor.getExecutedCommands().at(-1)).toBe(
      `shell rm -f ${q(`${DIR}/.automobile-t-1.part`)}`,
    );
  });

  test("a cancelled transfer removes the temp with a bounded, cancellation-detached command", async () => {
    const { executor, stage } = setup();
    executor.setThrowOnAbortedSignal(true);
    const controller = new AbortController();
    executor.abortAfterCommand("push /fixtures/only.txt", controller);

    await expect(
      runWithAbortSignal(controller.signal, () =>
        stage({ files: [fileAt("only.txt")], signal: controller.signal }),
      ),
    ).rejects.toThrow();

    expect(controller.signal.aborted).toBe(true);
    const cleanup = executor
      .getCommandCalls()
      .find((call) => call.command.startsWith("shell rm -f"));
    expect(cleanup?.command).toBe(`shell rm -f ${q(`${DIR}/.automobile-t-1.part`)}`);
    expect(cleanup?.timeoutMs).toBe(5000);
    expect(cleanup?.signal).toBeUndefined();
  });

  test("a failed temp cleanup is logged and does not replace the original error", async () => {
    const { executor, stage } = setup();
    executor.setCommandError("push /fixtures/only.txt", new Error("push cut off"));
    executor.setCommandError("shell rm -f", new Error("device unavailable"));
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      await expect(stage({ files: [fileAt("only.txt")] })).rejects.toThrow("push cut off");
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("sharedStorageService with rollback", () => {
  test("a transfer cut off on an overwritten file leaves it untouched and restores earlier ones", async () => {
    const executor = new FakeAdbExecutor();
    executor.setCommandResponse("content query", execResult("Row: 0 _id=42"));
    // Both destinations already exist, so both have saved copies.
    executor.setCommandResponse(MARKER, execResult(`${MARKER}:0\n${MARKER}:1\n`));
    executor.setCommandError("push /fixtures/b.txt", new Error("push cut off"));
    const service = createSharedStorageServiceForTesting({
      adbFactory: { create: () => executor },
      fileSystem,
      timer: new FakeTimer(),
      idGenerator: new CountingIdGenerator("t"),
    });

    await expect(
      service.stage({
        device: androidDevice,
        namespace: "ns",
        rollbackOnFailure: true,
        files: [fileAt("a.txt"), fileAt("b.txt")],
      }),
    ).rejects.toThrow("Rolled back: a.txt. Rollback failures: none.");

    const commands = executor.getExecutedCommands();
    // The saved copy is taken once with `cp`; the staged push is a separate host-to-device copy.
    expect(commands.filter((command) => command.includes(MARKER))).toHaveLength(1);
    // b.txt was never renamed over, so its saved copy is discarded rather than restored.
    expect(
      commands.filter((command) => command.includes(`mv -f ${q(`${DIR}/.automobile-t-2.bak`)}`)),
    ).toEqual([]);
    expect(commands).toContain(`shell rm -f ${q(`${DIR}/.automobile-t-2.bak`)}`);
  });
});

describe("media-scan file URI", () => {
  async function scanUriFor(destinationPath: string, indexMedia = true): Promise<string> {
    const { executor, stage } = setup();
    await stage({ files: [fileAt(destinationPath)], indexMedia });
    const scan = executor
      .getExecutedCommands()
      .find((command) => command.includes("MEDIA_SCANNER_SCAN_FILE"));
    return scan?.slice(scan.indexOf(" -d ") + 4) ?? "";
  }

  test("percent-encodes spaces, #, ? and % in the file name", async () => {
    expect(await scanUriFor("a b#c?d%e.png")).toBe(q(`file://${DIR}/a%20b%23c%3Fd%25e.png`));
  });

  test("encodes each segment and keeps the / separators", async () => {
    expect(await scanUriFor("my dir/sub #1/x y.mp4")).toBe(
      q(`file://${DIR}/my%20dir/sub%20%231/x%20y.mp4`),
    );
  });

  test("encodes non-ASCII as UTF-8 and leaves plain names unchanged", async () => {
    expect(await scanUriFor("café.png")).toBe(q(`file://${DIR}/caf%C3%A9.png`));
    expect(await scanUriFor("plain-name_1.png")).toBe(q(`file://${DIR}/plain-name_1.png`));
  });

  test("does not throw on a lone surrogate", async () => {
    expect(await scanUriFor("bad\ud800.png")).toBe(q(`file://${DIR}/bad%EF%BF%BD.png`));
  });

  test("the rollback rescan of a restored file uses the encoded URI too", async () => {
    const executor = new FakeAdbExecutor();
    executor.setCommandResponse("content query", execResult("Row: 0 _id=42"));
    executor.setCommandResponse(MARKER, execResult(`${MARKER}:0\n`));
    executor.setCommandError("push /fixtures/b.txt", new Error("push failed"));
    const service = createSharedStorageServiceForTesting({
      adbFactory: { create: () => executor },
      fileSystem,
      timer: new FakeTimer(),
      idGenerator: new CountingIdGenerator("t"),
    });

    await expect(
      service.stage({
        device: androidDevice,
        namespace: "ns",
        rollbackOnFailure: true,
        files: [fileAt("a b#1.png"), fileAt("b.txt")],
      }),
    ).rejects.toThrow("Rolled back: a b#1.png.");

    const restore = executor
      .getExecutedCommands()
      .find((command) => command.includes("sh -c") && command.includes("MEDIA_SCANNER_SCAN_FILE"));
    expect(restore).toContain(`${SCAN} `);
    expect(restore).toContain(`file://${DIR}/a%20b%231.png`);
  });
});
