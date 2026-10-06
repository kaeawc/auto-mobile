import { logger } from "../../src/utils/logger";
import { describe, expect, spyOn, test } from "bun:test";
import {
  createSharedStorageServiceForTesting,
  SHARED_STORAGE_PUSH_TIMEOUT_MS,
  type SharedStorageFileSystem,
  type StageSharedStorageRequest,
} from "../../src/server/sharedStorageService";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeTimer } from "../fakes/FakeTimer";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";
import { shellQuote } from "../../src/utils/shellQuote";
import type { BootedDevice } from "../../src/models";

// A failed batch must put back the files it overwrote instead of deleting them (#9965).

const androidDevice: BootedDevice = {
  deviceId: "emulator-5554",
  name: "Pixel",
  platform: "android",
};
const DIR = "/storage/emulated/0/Download/ns";
const MARKER = "AUTOMOBILE_SHARED_STORAGE_BACKUP";
const SCAN = "am broadcast --user 0 -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d";

function execResult(stdout: string) {
  return {
    stdout,
    stderr: "",
    toString: () => stdout,
    trim: () => stdout.trim(),
    includes: (text: string) => stdout.includes(text),
  };
}

const fileSystem: SharedStorageFileSystem = {
  stat: async () => ({ size: 3, isFile: () => true }),
  mkdtemp: async () => "/fake/unused",
  writeFileBuffer: async () => {},
  rm: async () => {},
};

function fileAt(name: string) {
  return { sourcePath: `/fixtures/${name}`, destinationPath: name };
}

function setup(existingIndexes: number[] = []) {
  const executor = new FakeAdbExecutor();
  executor.setCommandResponse("content query", execResult("Row: 0 _id=42"));
  if (existingIndexes.length > 0) {
    executor.setCommandResponse(
      MARKER,
      execResult(existingIndexes.map((index) => `${MARKER}:${index}\n`).join("")),
    );
  }
  const service = createSharedStorageServiceForTesting({
    adbFactory: { create: () => executor },
    fileSystem,
    timer: new FakeTimer(),
    idGenerator: new CountingIdGenerator("t"),
  });
  const stage = (
    request: Partial<StageSharedStorageRequest> & Pick<StageSharedStorageRequest, "files">,
  ) =>
    service.stage({ device: androidDevice, namespace: "ns", rollbackOnFailure: true, ...request });
  return { executor, stage };
}

function rollbackScript(created: string[], restores: string[]): string {
  const steps = [...(created.length > 0 ? [`rm -f ${created.join(" ")}`] : []), ...restores];
  return `shell sh -c ${shellQuote(`rc=0; ${steps.map((step) => `${step} || rc=1`).join("; ")}; exit $rc`)}`;
}

const q = (name: string) => shellQuote(`${DIR}/${name}`);
/** Commands that move a saved copy; the backup probe itself also renames its `.part`, so it is excluded. */
const savedCopyMoves = (commands: string[]) =>
  commands.filter(
    (command) =>
      !command.includes(MARKER) && command.includes(" mv -f ") && command.includes(".bak"),
  );
const mutating = (commands: string[]) =>
  commands.filter((command) => / (rm|mv) /.test(command) || command.includes("sh -c"));

describe("stageSharedStorage rollback of overwritten files", () => {
  test("restores an overwritten file, rescans it, and deletes only files the batch created", async () => {
    const { executor, stage } = setup([0]);
    executor.setCommandError("push /fixtures/third.png", new Error("push failed"));

    await expect(
      stage({ files: [fileAt("first.png"), fileAt("second.png"), fileAt("third.png")] }),
    ).rejects.toThrow(
      "failed for third.png: Android shared-storage operation failed: push failed " +
        "Rolled back: second.png, first.png. Rollback failures: none.",
    );

    const backup = `${DIR}/.automobile-t-1.bak`;
    const commands = executor.getExecutedCommands();
    // The restore is a pure rename: the MediaStore rescan is not part of the bounded restore.
    const restoreIndex = commands.indexOf(
      rollbackScript([q("second.png")], [`mv -f ${shellQuote(backup)} ${q("first.png")}`]),
    );
    expect(restoreIndex).toBeGreaterThan(-1);
    // The rescan runs afterwards, as its own best-effort command.
    expect(commands[restoreIndex + 1]).toBe(
      `shell sh -c ${shellQuote(`rc=0; ${SCAN} ${shellQuote(`file://${DIR}/first.png`)} >/dev/null || rc=1; exit $rc`)}`,
    );
    // The overwritten file is never passed to a plain delete; only the failed push's temp is.
    expect(commands.filter((command) => command.startsWith("shell rm -f"))).toEqual([
      `shell rm -f ${shellQuote(`${DIR}/.automobile-t-6.part`)}`,
    ]);
  });

  test("restores without a MediaStore rescan for a non-media file", async () => {
    const { executor, stage } = setup([0]);
    executor.setCommandError("push /fixtures/second.txt", new Error("push failed"));

    await expect(stage({ files: [fileAt("first.txt"), fileAt("second.txt")] })).rejects.toThrow(
      "Rolled back: first.txt.",
    );

    expect(mutating(executor.getExecutedCommands()).at(-1)).toBe(
      rollbackScript([], [`mv -f ${shellQuote(`${DIR}/.automobile-t-1.bak`)} ${q("first.txt")}`]),
    );
  });

  test("does not rescan restored media when indexing was opted out", async () => {
    const { executor, stage } = setup([0]);
    executor.setCommandError("push /fixtures/second.png", new Error("push failed"));

    await expect(
      stage({ indexMedia: false, files: [fileAt("first.png"), fileAt("second.png")] }),
    ).rejects.toThrow("Rolled back: first.png.");

    expect(mutating(executor.getExecutedCommands()).at(-1)).toBe(
      rollbackScript([], [`mv -f ${shellQuote(`${DIR}/.automobile-t-1.bak`)} ${q("first.png")}`]),
    );
  });

  test("leaves an overwritten file untouched when its own push is cut off", async () => {
    const { executor, stage } = setup([1]);
    executor.setCommandError("push /fixtures/b.txt", new Error("push cut off"));

    await expect(stage({ files: [fileAt("a.txt"), fileAt("b.txt")] })).rejects.toThrow(
      "Rolled back: a.txt. Rollback failures: none.",
    );

    const commands = executor.getExecutedCommands();
    // b.txt was never renamed over, so there is nothing to restore: no mv at all.
    expect(savedCopyMoves(commands)).toEqual([]);
    expect(commands.slice(-3)).toEqual([
      `shell rm -f ${shellQuote(`${DIR}/.automobile-t-4.part`)}`,
      `shell rm -f ${q("a.txt")}`,
      `shell rm -f ${shellQuote(`${DIR}/.automobile-t-2.bak`)}`,
    ]);
  });

  test("restores an overwritten file when its rename fails after the push", async () => {
    const { executor, stage } = setup([1]);
    executor.setCommandError(
      `mv -f ${shellQuote(`${DIR}/.automobile-t-4.part`)}`,
      new Error("rename cut off"),
    );

    await expect(stage({ files: [fileAt("a.txt"), fileAt("b.txt")] })).rejects.toThrow(
      "Rolled back: b.txt, a.txt. Rollback failures: none.",
    );

    expect(mutating(executor.getExecutedCommands()).at(-1)).toBe(
      rollbackScript(
        [q("a.txt")],
        [`mv -f ${shellQuote(`${DIR}/.automobile-t-2.bak`)} ${q("b.txt")}`],
      ),
    );
  });

  test("discards the saved copy of a file the batch never reached instead of restoring it", async () => {
    const { executor, stage } = setup([1]);
    executor.setCommandError("push /fixtures/a.txt", new Error("push failed"));

    await expect(stage({ files: [fileAt("a.txt"), fileAt("b.txt")] })).rejects.toThrow(
      "Rolled back: none. Rollback failures: none.",
    );

    const commands = executor.getExecutedCommands();
    expect(savedCopyMoves(commands)).toEqual([]);
    expect(commands.at(-1)).toBe(`shell rm -f ${shellQuote(`${DIR}/.automobile-t-2.bak`)}`);
  });

  test("keeps the saved copy when its restore fails", async () => {
    const { executor, stage } = setup([0]);
    executor.setCommandError("push /fixtures/second.txt", new Error("push failed"));
    // Only the restore of first.txt fails; its push-temp rename and the backup probe succeed.
    executor.setCommandError(
      // The restore is nested inside `sh -c '...'`, so its quotes appear escaped.
      shellQuote(`mv -f ${shellQuote(`${DIR}/.automobile-t-1.bak`)} ${q("first.txt")}`).slice(
        1,
        -1,
      ),
      new Error("device unavailable"),
    );
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      await expect(stage({ files: [fileAt("first.txt"), fileAt("second.txt")] })).rejects.toThrow(
        /Rolled back: none\. Rollback failures: first\.txt: .*device unavailable/,
      );
    } finally {
      warn.mockRestore();
    }

    expect(
      executor
        .getExecutedCommands()
        .filter((command) => command.startsWith("shell rm -f") && command.includes(".bak")),
    ).toEqual([]);
  });

  test("discards every saved copy once the whole batch commits", async () => {
    const { executor, stage } = setup([0, 2]);

    const result = await stage({
      files: [fileAt("first.png"), fileAt("second.png"), fileAt("third.png")],
    });

    expect(result.files.map((file) => file.destinationPath)).toEqual([
      "first.png",
      "second.png",
      "third.png",
    ]);
    const commands = executor.getExecutedCommands();
    // The saved copies are only ever removed, never moved back.
    expect(savedCopyMoves(commands)).toEqual([]);
    expect(commands.at(-1)).toBe(
      `shell rm -f ${shellQuote(`${DIR}/.automobile-t-1.bak`)} ${shellQuote(`${DIR}/.automobile-t-3.bak`)}`,
    );
  });

  test("saves copies as hidden non-media files beside the destination", async () => {
    const { executor, stage } = setup([0, 1]);

    await stage({
      files: [fileAt("docs/a.png"), fileAt("docs/deep/b.mp4")],
    });

    const probe = executor.getExecutedCommands().find((command) => command.includes(MARKER));
    expect(probe).toContain(shellQuote(`${DIR}/docs/.automobile-t-1.bak`));
    expect(probe).toContain(shellQuote(`${DIR}/docs/deep/.automobile-t-2.bak`));
    for (const match of probe?.match(/\.automobile-t-\d+\.bak/g) ?? []) {
      expect(match).not.toMatch(/\.(png|jpe?g|gif|webp|mp4|mp3|wav|m4a|mov)$/i);
    }
  });

  test("a failed backup probe removes any partial copies and writes nothing", async () => {
    const { executor, stage } = setup();
    executor.setCommandError(MARKER, new Error("cp failed"));

    await expect(stage({ files: [fileAt("a.txt"), fileAt("b.txt")] })).rejects.toThrow(
      "failed for previous-content backup: Android shared-storage operation failed: cp failed",
    );

    const commands = executor.getExecutedCommands();
    expect(commands.filter((command) => command.startsWith("push "))).toEqual([]);
    expect(commands.at(-1)).toBe(
      `shell rm -f ${[1, 2]
        .flatMap((n) => [`${DIR}/.automobile-t-${n}.bak`, `${DIR}/.automobile-t-${n}.bak.part`])
        .map(shellQuote)
        .join(" ")}`,
    );
  });

  test("probes existing files in chunks of 64", async () => {
    const { executor, stage } = setup();
    const files = Array.from({ length: 65 }, (_, index) => fileAt(`f-${index}.txt`));

    await stage({ files });

    const probes = executor.getExecutedCommands().filter((command) => command.includes(MARKER));
    expect(probes).toHaveLength(2);
    expect(probes[0]?.split(`echo ${MARKER}:`)).toHaveLength(65);
    expect(probes[1]?.split(`echo ${MARKER}:`)).toHaveLength(2);
  });

  describe("batches that overwrite nothing", () => {
    async function commandsFor(
      request: Partial<StageSharedStorageRequest> & Pick<StageSharedStorageRequest, "files">,
    ): Promise<string[]> {
      const { executor, stage } = setup();
      await stage(request);
      return executor.getExecutedCommands();
    }

    test("a multi-file batch adds only the probe to the previous commands", async () => {
      const files = [fileAt("first.png"), fileAt("second.png")];
      const before = await commandsFor({ files, rollbackOnFailure: false });
      const after = await commandsFor({ files });

      // Temp names draw ids after the backup plan, so only the id differs between the runs.
      const sameIds = (commands: string[]) =>
        commands.map((command) => command.replace(/\.automobile-t-\d+\.part/g, ".part"));
      const withoutProbe = after.filter((command) => !command.includes(MARKER));
      expect(sameIds(withoutProbe)).toEqual(sameIds(before));
      expect(after).toHaveLength(before.length + 1);
    });

    test("a single-file batch adds only the probe to the previous commands", async () => {
      const files = [fileAt("only.png")];
      const before = await commandsFor({ files, rollbackOnFailure: false });
      const after = await commandsFor({ files });

      const sameIds = (commands: string[]) =>
        commands.map((command) => command.replace(/\.automobile-t-\d+\.part/g, ".part"));
      const withoutProbe = after.filter((command) => !command.includes(MARKER));
      expect(sameIds(withoutProbe)).toEqual(sameIds(before));
      expect(after).toHaveLength(before.length + 1);
    });

    test("a reset batch sends the previous commands", async () => {
      const files = [fileAt("first.png"), fileAt("second.png")];
      expect(await commandsFor({ files, reset: true })).toEqual(
        await commandsFor({ files, reset: true, rollbackOnFailure: false }),
      );
    });

    test("a failed batch that created every file still removes them with a plain delete", async () => {
      const { executor, stage } = setup();
      executor.setCommandError("push /fixtures/third.txt", new Error("push failed"));

      await expect(
        stage({ files: [fileAt("first.txt"), fileAt("second.txt"), fileAt("third.txt")] }),
      ).rejects.toThrow("Rolled back: second.txt, first.txt.");

      expect(executor.getExecutedCommands().at(-1)).toBe(
        `shell rm -f ${q("second.txt")} ${q("first.txt")}`,
      );
    });
  });

  describe("a single-file batch (#9965)", () => {
    test("restores the file it overwrote when media indexing fails after its own commit", async () => {
      const { executor, stage } = setup([0]);
      // Only the initial indexing broadcast fails; the later restore rescan runs inside `sh -c`.
      executor.setCommandError("shell am broadcast", new Error("indexing failed"));

      await expect(stage({ files: [fileAt("only.png")] })).rejects.toThrow(
        "Rolled back: only.png. Rollback failures: none.",
      );

      const commands = executor.getExecutedCommands();
      expect(commands).toContain(
        rollbackScript([], [`mv -f ${shellQuote(`${DIR}/.automobile-t-1.bak`)} ${q("only.png")}`]),
      );
      // The overwritten destination is never deleted.
      expect(commands.filter((command) => command.includes(`rm -f ${q("only.png")}`))).toEqual([]);
    });

    test("still deletes a single file the batch created", async () => {
      const { executor, stage } = setup();
      executor.setCommandError("shell am broadcast", new Error("indexing failed"));

      await expect(stage({ files: [fileAt("only.png")] })).rejects.toThrow(
        "Rolled back: only.png. Rollback failures: none.",
      );

      expect(executor.getExecutedCommands()).toContain(`shell rm -f ${q("only.png")}`);
    });
  });

  describe("backup timeout", () => {
    const probeTimeouts = (executor: FakeAdbExecutor) =>
      executor
        .getCommandCalls()
        .filter((call) => call.command.includes(MARKER))
        .map((call) => call.timeoutMs);

    test("scales with the number of files copied, one push budget per file", async () => {
      const { executor, stage } = setup();

      await stage({ files: [fileAt("a.png"), fileAt("b.png")] });

      expect(probeTimeouts(executor)).toEqual([2 * SHARED_STORAGE_PUSH_TIMEOUT_MS]);
    });

    test("a single-file backup gets one push budget, not the 15 s default", async () => {
      const { executor, stage } = setup();

      await stage({ files: [fileAt("a.png")] });

      expect(probeTimeouts(executor)).toEqual([SHARED_STORAGE_PUSH_TIMEOUT_MS]);
    });

    test("each chunk of 64 is budgeted for its own size", async () => {
      const { executor, stage } = setup();

      await stage({
        files: Array.from({ length: 65 }, (_, index) => fileAt(`f-${index}.txt`)),
      });

      expect(probeTimeouts(executor)).toEqual([
        64 * SHARED_STORAGE_PUSH_TIMEOUT_MS,
        SHARED_STORAGE_PUSH_TIMEOUT_MS,
      ]);
    });
  });

  describe("rollback budget and re-index", () => {
    const restoreCalls = (executor: FakeAdbExecutor) =>
      executor
        .getCommandCalls()
        .filter(
          (call) =>
            call.command.includes("sh -c") &&
            !call.command.includes(MARKER) &&
            call.command.includes(".bak'") &&
            call.command.includes("mv -f"),
        );

    test("the restore command's budget grows with the number of restores", async () => {
      const { executor, stage } = setup(Array.from({ length: 11 }, (_, index) => index));
      const files = Array.from({ length: 12 }, (_, index) => fileAt(`f-${index}.png`));
      executor.setCommandError("push /fixtures/f-11.png", new Error("push failed"));

      await expect(stage({ files })).rejects.toThrow("Rollback failures: none.");

      const calls = restoreCalls(executor);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.command).not.toContain("am broadcast");
      expect(calls[0]?.timeoutMs).toBe(5000 + 11 * 500);
    });

    test("a delete-only rollback keeps the fixed 5 s bound", async () => {
      const { executor, stage } = setup();
      executor.setCommandError("push /fixtures/b.txt", new Error("push failed"));

      await expect(stage({ files: [fileAt("a.txt"), fileAt("b.txt")] })).rejects.toThrow(
        "Rolled back: a.txt.",
      );

      const removal = executor
        .getCommandCalls()
        .find((call) => call.command === `shell rm -f ${q("a.txt")}`);
      expect(removal?.timeoutMs).toBe(5000);
    });

    test("re-indexes every restored media file in one command after the restores", async () => {
      const { executor, stage } = setup([0, 1]);
      executor.setCommandError("push /fixtures/c.png", new Error("push failed"));

      await expect(
        stage({ files: [fileAt("a.png"), fileAt("b.png"), fileAt("c.png")] }),
      ).rejects.toThrow("Rolled back: b.png, a.png. Rollback failures: none.");

      const commands = executor.getExecutedCommands();
      const rescans = commands.filter((command) => command.includes("rc=0; am broadcast"));
      expect(rescans).toHaveLength(1);
      expect(rescans[0]).toContain(shellQuote(`file://${DIR}/b.png`));
      expect(rescans[0]).toContain(shellQuote(`file://${DIR}/a.png`));
      const rescanCall = executor.getCommandCalls().find((call) => call.command === rescans[0]);
      expect(rescanCall?.timeoutMs).toBe(2 * 3000);
      expect(commands.indexOf(rescans[0] ?? "")).toBeGreaterThan(
        commands.findIndex((command) => command.includes("rc=0; rm -f")),
      );
    });

    test("a failed re-index is a warning, never a failed restore", async () => {
      const { executor, stage } = setup([0]);
      executor.setCommandError("push /fixtures/b.txt", new Error("push failed"));
      executor.setCommandError("rc=0; am broadcast", new Error("am unavailable"));
      const warn = spyOn(logger, "warn").mockImplementation(() => {});
      let message = "";
      try {
        message = await stage({ files: [fileAt("a.png"), fileAt("b.txt")] }).then(
          () => "unexpected success",
          (error: unknown) => (error instanceof Error ? error.message : String(error)),
        );
        expect(warn).toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }

      expect(message).toContain("Rolled back: a.png. Rollback failures: none.");
      expect(message).toContain("Media re-index not confirmed for restored files: a.png.");
    });
  });

  test("names every file whose restore was not confirmed and the saved copy that may hold it", async () => {
    const { executor, stage } = setup([0, 1]);
    executor.setCommandError("push /fixtures/c.txt", new Error("push failed"));
    executor.setCommandError(
      // The restore is nested inside `sh -c '...'`, so its quotes appear escaped.
      shellQuote(`mv -f ${shellQuote(`${DIR}/.automobile-t-1.bak`)} ${q("a.txt")}`).slice(1, -1),
      new Error("device unavailable"),
    );
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    let message = "";
    try {
      message = await stage({ files: [fileAt("a.txt"), fileAt("b.txt"), fileAt("c.txt")] }).then(
        () => "unexpected success",
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );
    } finally {
      warn.mockRestore();
    }

    expect(message).toContain("Rolled back: none.");
    expect(message).toContain(
      `a.txt: restore not confirmed; its previous content may still be saved at ${DIR}/.automobile-t-1.bak`,
    );
    expect(message).toContain(
      `b.txt: restore not confirmed; its previous content may still be saved at ${DIR}/.automobile-t-2.bak`,
    );
  });
});
