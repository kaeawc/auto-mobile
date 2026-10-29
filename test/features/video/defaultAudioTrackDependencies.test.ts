import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openFileBackedPcm } from "../../../src/features/video/defaultAudioTrackDependencies";

let dir = "";

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "pcm-file-"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("openFileBackedPcm", () => {
  test("appends PCM and resolves close with the bytes written, once", async () => {
    const path = join(dir, "a.pcm");
    const file = openFileBackedPcm(path);
    file.write(Uint8Array.from([1, 2]));
    file.write(Uint8Array.from([3]));
    expect(await file.close()).toBe(3);
    expect(await file.close()).toBe(3);
    expect(Array.from(readFileSync(path))).toEqual([1, 2, 3]);
  });

  test("an open error is kept and rejects close instead of escaping", async () => {
    const file = openFileBackedPcm(join(dir, "missing", "a.pcm"));
    file.write(Uint8Array.from([1, 2]));
    await expect(file.close()).rejects.toMatchObject({ code: "ENOENT" });
  });
});
