import { runWithAbortSignal } from "../../src/utils/AbortContext";
import { describe, expect, test } from "bun:test";
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

// Failure-order matrix for a shared-storage batch that overwrites existing files. The previous
// content is saved (`<backup>.part` renamed to `.bak`), the new content is pushed to a separate
// hidden `.automobile-<id>.part` and renamed into place. In every order a pre-existing file must
// end up as its original content: the destination is only ever written by a rename of a COMPLETE
// pushed temp or of a COMPLETE saved copy, never copied over, deleted, or pushed to directly.

const androidDevice: BootedDevice = {
  deviceId: "emulator-5554",
  name: "Pixel",
  platform: "android",
};
const DIR = "/storage/emulated/0/Download/ns";
const MARKER = "AUTOMOBILE_SHARED_STORAGE_BACKUP";

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

const fileAt = (name: string) => ({ sourcePath: `/fixtures/${name}`, destinationPath: name });
const path = (name: string) => `${DIR}/${name}`;
const q = (name: string) => shellQuote(path(name));

/** Ids: both saved-copy paths are planned first (t-1, t-2), then each push temp (t-3, t-4). */
const BACKUP_A = ".automobile-t-1.bak";
const BACKUP_B = ".automobile-t-2.bak";
const TEMP_A = ".automobile-t-3.part";
const TEMP_B = ".automobile-t-4.part";

function setup(existingIndexes: number[]) {
  const executor = new FakeAdbExecutor();
  executor.setThrowOnAbortedSignal(true);
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
    files: string[],
    request: Partial<StageSharedStorageRequest> = {},
  ): Promise<unknown> =>
    service
      .stage({
        device: androidDevice,
        namespace: "ns",
        rollbackOnFailure: true,
        files: files.map(fileAt),
        ...request,
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
  return { executor, stage };
}

/** Commands with the nested `sh -c '...'` quoting undone, so inner paths read as plain quoted args. */
function plain(commands: string[]): string[] {
  return commands.map((command) => command.replaceAll(`'\\''`, "'"));
}

interface DestinationOps {
  /** Sources renamed onto the destination. */
  movedFrom: string[];
  /** Anything else that writes or deletes the destination. */
  other: string[];
}

/** Everything the executed commands do to `destination`. */
function operationsOn(commands: string[], destination: string): DestinationOps {
  const ops: DestinationOps = { movedFrom: [], other: [] };
  for (const command of plain(commands)) {
    for (const match of command.matchAll(/mv -f '([^']+)' '([^']+)'/g)) {
      if (match[2] === destination) {
        ops.movedFrom.push(match[1]);
      }
    }
    for (const match of command.matchAll(/cp '([^']+)' '([^']+)'/g)) {
      if (match[2] === destination) {
        ops.other.push(`cp ${match[1]}`);
      }
    }
    for (const match of command.matchAll(/rm -f ((?:'[^']+' ?)+)/g)) {
      if (match[1].includes(`'${destination}'`)) {
        ops.other.push(`rm ${destination}`);
      }
    }
    if (command.startsWith("push ") && command.endsWith(` ${destination}`)) {
      ops.other.push("push");
    }
  }
  return ops;
}

/** Every path a `shell rm -f` removed, one list per command. */
function removals(commands: string[]): string[][] {
  return plain(commands)
    .filter((command) => command.startsWith("shell rm -f "))
    .map((command) => [...command.matchAll(/'([^']+)'/g)].map((match) => match[1]));
}

const isPushTemp = (file: string) => /\/\.automobile-t-\d+\.part$/.test(file);
const isBackupArtifact = (file: string) => /\/\.automobile-t-\d+\.bak(\.part)?$/.test(file);

/** A removal command never mixes the two kinds of hidden file, so one cleanup cannot delete the other. */
function expectSeparateCleanups(commands: string[]) {
  for (const paths of removals(commands)) {
    const kinds = new Set(paths.map((file) => (isPushTemp(file) ? "push" : "backup")));
    expect(kinds.size).toBeLessThanOrEqual(1);
    for (const file of paths) {
      if (!isPushTemp(file)) {
        expect(isBackupArtifact(file) || !file.includes(".automobile-")).toBe(true);
      }
    }
  }
}

describe("shared-storage failure-order matrix (existing a.txt and b.txt)", () => {
  test("backup copy fails part-way: originals untouched, no restore, every temp removed", async () => {
    const { executor, stage } = setup([]);
    executor.setCommandError(MARKER, new Error("cp failed part-way"));

    const error = await stage(["a.txt", "b.txt"]);

    expect((error as Error).message).toContain("failed for previous-content backup");
    const commands = executor.getExecutedCommands();
    expect(commands.filter((command) => command.startsWith("push "))).toEqual([]);
    for (const name of ["a.txt", "b.txt"]) {
      expect(operationsOn(commands, path(name))).toEqual({ movedFrom: [], other: [] });
    }
    // Every candidate saved copy and its in-progress `.part` is removed; no push temp exists yet.
    expect(removals(commands)).toEqual([
      [BACKUP_A, `${BACKUP_A}.part`, BACKUP_B, `${BACKUP_B}.part`].map(path),
    ]);
    expectSeparateCleanups(commands);
  });

  test("push cut off on b.txt: b.txt untouched, its saved copy discarded not restored, a.txt restored", async () => {
    const { executor, stage } = setup([0, 1]);
    executor.setCommandError("push /fixtures/b.txt", new Error("push cut off"));

    const error = await stage(["a.txt", "b.txt"]);

    expect((error as Error).message).toContain("Rolled back: a.txt. Rollback failures: none.");
    const commands = executor.getExecutedCommands();
    expect(operationsOn(commands, path("b.txt"))).toEqual({ movedFrom: [], other: [] });
    // a.txt was committed by its own complete temp, then put back from its complete saved copy.
    expect(operationsOn(commands, path("a.txt"))).toEqual({
      movedFrom: [path(TEMP_A), path(BACKUP_A)],
      other: [],
    });
    expect(removals(commands)).toEqual([[path(TEMP_B)], [path(BACKUP_B)]]);
    expectSeparateCleanups(commands);
  });

  test("rename of b.txt's pushed temp fails after a completed backup: both are restored", async () => {
    const { executor, stage } = setup([0, 1]);
    executor.setCommandError(`mv -f ${q(TEMP_B)}`, new Error("rename failed"));

    const error = await stage(["a.txt", "b.txt"]);

    expect((error as Error).message).toContain("Rolled back: b.txt, a.txt.");
    const commands = executor.getExecutedCommands();
    // The failed rename never wrote b.txt; the restore puts back byte-identical saved content.
    expect(operationsOn(commands, path("b.txt")).other).toEqual([]);
    expect(operationsOn(commands, path("a.txt")).movedFrom).toEqual([path(TEMP_A), path(BACKUP_A)]);
    expect(removals(commands)).toContainEqual([path(TEMP_B)]);
    expectSeparateCleanups(commands);
  });

  test("file 1 committed, then file 2's rename fails: file 1 is restored, not deleted", async () => {
    const { executor, stage } = setup([0]);
    executor.setCommandError(`mv -f ${q(TEMP_B)}`, new Error("rename failed"));

    const error = await stage(["a.txt", "b.txt"]);

    expect((error as Error).message).toContain("Rolled back: a.txt.");
    const commands = executor.getExecutedCommands();
    expect(operationsOn(commands, path("a.txt")).other).toEqual([]);
    expect(operationsOn(commands, path("a.txt")).movedFrom).toEqual([path(TEMP_A), path(BACKUP_A)]);
    expectSeparateCleanups(commands);
  });

  describe("cancellation", () => {
    async function stageCancelledAfter(
      pattern: string,
      files: string[],
      existing: number[],
    ): Promise<{ commands: string[]; error: unknown }> {
      const { executor, stage } = setup(existing);
      const controller = new AbortController();
      executor.abortAfterCommand(pattern, controller);
      const error = await runWithAbortSignal(controller.signal, () =>
        stage(files, { signal: controller.signal }),
      );
      expect(controller.signal.aborted).toBe(true);
      return { commands: executor.getExecutedCommands(), error };
    }

    test("abort right after the backups are saved: nothing pushed, saved copies discarded", async () => {
      const { commands, error } = await stageCancelledAfter(MARKER, ["a.txt", "b.txt"], [0, 1]);

      expect(error).toBeInstanceOf(Error);
      expect(commands.filter((command) => command.startsWith("push "))).toEqual([]);
      for (const name of ["a.txt", "b.txt"]) {
        expect(operationsOn(commands, path(name))).toEqual({ movedFrom: [], other: [] });
      }
      expect(removals(commands)).toEqual([[path(BACKUP_A), path(BACKUP_B)]]);
      expectSeparateCleanups(commands);
    });

    test("abort right after b.txt's push: temp removed, destination ends as its saved copy", async () => {
      const { commands } = await stageCancelledAfter(
        "push /fixtures/b.txt",
        ["a.txt", "b.txt"],
        [0, 1],
      );

      const onB = operationsOn(commands, path("b.txt"));
      expect(onB.other).toEqual([]);
      // The fake records the rejected rename attempt too; whether or not it ran, the last write to
      // the destination is the restore of its complete saved copy.
      expect(onB.movedFrom.at(-1)).toBe(path(BACKUP_B));
      expect(removals(commands)).toContainEqual([path(TEMP_B)]);
      // a.txt, committed earlier, is put back from its complete saved copy.
      expect(operationsOn(commands, path("a.txt")).movedFrom).toEqual([
        path(TEMP_A),
        path(BACKUP_A),
      ]);
      expectSeparateCleanups(commands);
    });

    test("abort right after b.png's rename: the replaced file is restored from its saved copy", async () => {
      const { commands } = await stageCancelledAfter(
        `shell mv -f ${shellQuote(path(TEMP_B))}`,
        ["a.png", "b.png"],
        [0, 1],
      );

      for (const name of ["a.png", "b.png"]) {
        const ops = operationsOn(commands, path(name));
        expect(ops.other).toEqual([]);
        // The last write to each destination is the restore of its complete saved copy.
        expect(ops.movedFrom.at(-1)).toBe(path(name === "a.png" ? BACKUP_A : BACKUP_B));
      }
      expectSeparateCleanups(commands);
    });
  });

  test("a clean run only ever removes saved copies, and never moves one", async () => {
    const { executor, stage } = setup([0, 1]);

    expect(await stage(["a.txt", "b.txt"])).toBeUndefined();

    const commands = executor.getExecutedCommands();
    expect(operationsOn(commands, path("a.txt")).movedFrom).toEqual([path(TEMP_A)]);
    expect(operationsOn(commands, path("b.txt")).movedFrom).toEqual([path(TEMP_B)]);
    expect(removals(commands)).toEqual([[path(BACKUP_A), path(BACKUP_B)]]);
  });
});
