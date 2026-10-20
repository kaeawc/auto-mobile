import { describe, expect, test } from "bun:test";
import type { TerminalReleaseJournalDirectory } from "../../src/daemon/terminalReleaseJournal";

export interface TerminalReleaseJournalDirectoryHarness {
  files: TerminalReleaseJournalDirectory;
  /** An existing-or-creatable directory owned by this run (no leading file system state). */
  root: string;
  join(...segments: string[]): string;
  dispose?(): Promise<void>;
}

/**
 * Shared behavioural contract for {@link TerminalReleaseJournalDirectory} (#11868): the fake and
 * nodeTerminalReleaseJournalFileSystem (over a private mkdtemp directory) agree on missing-file
 * reads, durable append and replace, idempotent remove, and sorted directory listings.
 */
export function runTerminalReleaseJournalDirectoryContract(
  name: string,
  make: () => Promise<TerminalReleaseJournalDirectoryHarness>,
): void {
  const withHarness = async (
    body: (harness: TerminalReleaseJournalDirectoryHarness) => void,
  ): Promise<void> => {
    const harness = await make();
    try {
      body(harness);
    } finally {
      await harness.dispose?.();
    }
  };

  describe(`${name} TerminalReleaseJournalDirectory contract`, () => {
    test("reading a missing file is undefined, not an error", () =>
      withHarness(({ files, join, root }) => {
        expect(files.readText(join(root, "missing.jsonl"))).toBeUndefined();
      }));

    test("append creates the file and later appends concatenate in order", () =>
      withHarness(({ files, join, root }) => {
        const file = join(root, "journal", "a.jsonl");
        files.appendDurable(file, "one\n");
        files.appendDurable(file, "two\n", false);

        expect(files.readText(file)).toBe("one\ntwo\n");
      }));

    test("replace swaps the whole contents", () =>
      withHarness(({ files, join, root }) => {
        const file = join(root, "journal", "a.jsonl");
        files.appendDurable(file, "old\n");
        files.replaceDurable(file, "new\n");

        expect(files.readText(file)).toBe("new\n");
      }));

    test("remove deletes the file and a missing file is not an error", () =>
      withHarness(({ files, join, root }) => {
        const file = join(root, "journal", "a.jsonl");
        files.appendDurable(file, "x\n");
        files.remove(file);
        files.remove(file);

        expect(files.readText(file)).toBeUndefined();
      }));

    test("listing a missing directory is empty", () =>
      withHarness(({ files, join, root }) => {
        expect(files.listNames(join(root, "nowhere"))).toEqual([]);
      }));

    test("listing returns sorted direct file names only", () =>
      withHarness(({ files, join, root }) => {
        const dir = join(root, "journal");
        files.appendDurable(join(dir, "b.jsonl"), "b\n");
        files.appendDurable(join(dir, "a.jsonl"), "a\n");
        files.appendDurable(join(root, "other", "c.jsonl"), "c\n");

        expect(files.listNames(dir)).toEqual(["a.jsonl", "b.jsonl"]);
      }));

    test("a removed file leaves the listing", () =>
      withHarness(({ files, join, root }) => {
        const dir = join(root, "journal");
        files.appendDurable(join(dir, "a.jsonl"), "a\n");
        files.appendDurable(join(dir, "b.jsonl"), "b\n");
        files.remove(join(dir, "a.jsonl"));

        expect(files.listNames(dir)).toEqual(["b.jsonl"]);
      }));
  });
}
