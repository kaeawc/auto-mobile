import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readRegularFileCapped } from "../../../src/features/audio/defaultEmulatorAudioService";

describe("readRegularFileCapped", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "audio-read-"));
    writeFileSync(path.join(dir, "ten.bin"), Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("reads a file at or under the cap", async () => {
    const bytes = await readRegularFileCapped(path.join(dir, "ten.bin"), 10);
    expect(Array.from(bytes)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  test("refuses a file once the bytes read pass the cap", async () => {
    await expect(readRegularFileCapped(path.join(dir, "ten.bin"), 9)).rejects.toThrow(
      "larger than the 9-byte limit",
    );
  });

  test("refuses anything that is not a regular file", async () => {
    await expect(readRegularFileCapped(dir, 1_000)).rejects.toThrow("not a regular file");
  });
});
