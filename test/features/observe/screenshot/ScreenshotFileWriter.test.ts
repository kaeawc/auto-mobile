import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultScreenshotFileWriter } from "../../../../src/features/observe/screenshot/ScreenshotFileWriter";

describe("secure screenshot writer", () => {
  test("writes owner-only and refuses to replace an existing capture", async () => {
    const directory = await mkdtemp(join(tmpdir(), "automobile-shot-"));
    const target = join(directory, "capture.png");
    try {
      const pixels = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
      await defaultScreenshotFileWriter.write(target, pixels);
      expect(await readFile(target)).toEqual(pixels);
      if (process.platform !== "win32") {
        expect((await stat(target)).mode & 0o777).toBe(0o600);
      }
      await expect(
        defaultScreenshotFileWriter.write(target, Buffer.from("replacement")),
      ).rejects.toThrow();
      expect(await readFile(target)).toEqual(pixels);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
