import { logger } from "../../src/utils/logger";
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
    expect(mutating(commands).at(-1)).toBe(
      rollbackScript(
        [q("second.png")],
        [
          `mv -f ${shellQuote(backup)} ${q("first.png")} && ${SCAN} ${shellQuote(`file://${DIR}/first.png`)} >/dev/null`,
        ],
      ),
    );
    // The overwritten file is never passed to a plain delete.
    expect(commands.filter((command) => command.startsWith("shell rm -f"))).toEqual([]);
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

  test("restores an overwritten file whose own push failed midway", async () => {
    const { executor, stage } = setup([1]);
    executor.setCommandError("push /fixtures/b.txt", new Error("push cut off"));

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
    expect(commands.filter((command) => command.includes(" mv "))).toEqual([]);
    expect(commands.at(-1)).toBe(`shell rm -f ${shellQuote(`${DIR}/.automobile-t-2.bak`)}`);
  });

  test("keeps the saved copy when its restore fails", async () => {
    const { executor, stage } = setup([0]);
    executor.setCommandError("push /fixtures/second.txt", new Error("push failed"));
    executor.setCommandError("mv -f", new Error("device unavailable"));
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      await expect(stage({ files: [fileAt("first.txt"), fileAt("second.txt")] })).rejects.toThrow(
        /Rolled back: none\. Rollback failures: first\.txt: .*device unavailable/,
      );
    } finally {
      warn.mockRestore();
    }

    expect(
      executor.getExecutedCommands().filter((command) => command.startsWith("shell rm -f")),
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
    expect(commands.filter((command) => command.includes(" mv "))).toEqual([]);
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
      `shell rm -f ${shellQuote(`${DIR}/.automobile-t-1.bak`)} ${shellQuote(`${DIR}/.automobile-t-2.bak`)}`,
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

      const withoutProbe = after.filter((command) => !command.includes(MARKER));
      expect(withoutProbe).toEqual(before);
      expect(after).toHaveLength(before.length + 1);
    });

    test("a single-file batch sends the previous commands", async () => {
      const files = [fileAt("only.png")];
      expect(await commandsFor({ files })).toEqual(
        await commandsFor({ files, rollbackOnFailure: false }),
      );
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
});
