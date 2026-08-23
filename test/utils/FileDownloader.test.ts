import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { FakeFileDownloader } from "../fakes/FakeFileDownloader";

describe("FakeFileDownloader", function () {
  let tempDir: string | null = null;

  afterEach(async function () {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  test("should track downloaded urls and destinations", async function () {
    const downloader = new FakeFileDownloader();
    const url = "https://example.com/file.zip";
    tempDir = await makeScratchTempDir("fake-downloader-");
    const destination = path.join(tempDir, "nested", "file.zip");

    await downloader.download(url, destination);

    expect(downloader.downloadedUrls).toEqual([url]);
    expect(downloader.downloadedDestinations).toEqual([destination]);
    expect(await fs.readFile(destination)).toEqual(downloader.payload);
  });

  test("should throw configured error", async function () {
    const downloader = new FakeFileDownloader();
    downloader.shouldThrow = new Error("download failed");
    const destination = path.join(process.cwd(), "scratch", "fake-downloader-unused", "file.zip");

    await expect(downloader.download("https://example.com/file.zip", destination)).rejects.toThrow(
      "download failed",
    );
  });
});

const makeScratchTempDir = async (prefix: string): Promise<string> => {
  const scratchDir = path.join(process.cwd(), "scratch");
  await fs.mkdir(scratchDir, { recursive: true });
  return fs.mkdtemp(path.join(scratchDir, prefix));
};
