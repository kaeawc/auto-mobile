import { describe, expect, test } from "bun:test";
import type { ScreenshotFileWriter } from "../../src/features/observe/screenshot/ScreenshotFileWriter";

export interface ScreenshotFileWriterHandle {
  writer: ScreenshotFileWriter;
  /** A directory that exists for the writer to create captures in. */
  root: string;
  /** Whether a capture currently exists at the path. */
  exists(filePath: string): Promise<boolean>;
  dispose?: () => Promise<void>;
}

/**
 * Shared behavioural contract for {@link ScreenshotFileWriter} (#11868): a write is exclusive
 * (never overwrites a capture), and removal is best-effort and idempotent.
 */
export const runScreenshotFileWriterContract = (
  description: string,
  setup: () => Promise<ScreenshotFileWriterHandle>,
): void => {
  const withHandle = async (body: (handle: ScreenshotFileWriterHandle) => Promise<void>) => {
    const handle = await setup();
    try {
      await body(handle);
    } finally {
      await handle.dispose?.();
    }
  };

  describe(`ScreenshotFileWriter contract: ${description}`, () => {
    test("write creates the capture", async () => {
      await withHandle(async ({ writer, root, exists }) => {
        const target = `${root}/a.png`;

        await writer.write(target, Buffer.from([1, 2, 3]));

        expect(await exists(target)).toBe(true);
      });
    });

    test("write refuses to overwrite an existing capture", async () => {
      await withHandle(async ({ writer, root }) => {
        const target = `${root}/a.png`;
        await writer.write(target, Buffer.from([1]));

        await expect(writer.write(target, Buffer.from([2]))).rejects.toThrow();
      });
    });

    test("remove deletes the capture so the path is writable again", async () => {
      await withHandle(async ({ writer, root, exists }) => {
        const target = `${root}/a.png`;
        await writer.write(target, Buffer.from([1]));

        await writer.remove(target);

        expect(await exists(target)).toBe(false);
        await writer.write(target, Buffer.from([2]));
        expect(await exists(target)).toBe(true);
      });
    });

    test("remove of a missing capture resolves without error", async () => {
      await withHandle(async ({ writer, root }) => {
        await writer.remove(`${root}/never-written.png`);
      });
    });
  });
};
