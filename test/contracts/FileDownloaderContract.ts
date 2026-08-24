import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { FileDownloader } from "../../src/utils/FileDownloader";

export const runFileDownloaderContract = (
  description: string,
  makeDownloader: (payload: Buffer) => FileDownloader,
): void => {
  describe(`FileDownloader contract: ${description}`, function () {
    let tempDir: string | null = null;

    afterEach(async function () {
      if (tempDir) {
        await fs.rm(tempDir, { recursive: true, force: true });
        tempDir = null;
      }
    });

    test("writes the downloaded payload to the requested destination", async function () {
      const payload = Buffer.from("download contract payload");
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "auto-mobile-download-contract-"));
      const destination = path.join(tempDir, "nested", "payload.txt");
      const downloader = makeDownloader(payload);
      const server = await createPayloadServer(payload);

      try {
        await downloader.download(server.url, destination);
        expect(await fs.readFile(destination)).toEqual(payload);
      } finally {
        await server.close();
      }
    });

    test("rejects an already-aborted download without writing a destination", async function () {
      const controller = new AbortController();
      controller.abort();
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "auto-mobile-download-contract-"));
      const destination = path.join(tempDir, "payload.txt");

      await expect(
        makeDownloader(Buffer.from("payload")).download(
          "https://example.invalid/payload",
          destination,
          controller.signal,
        ),
      ).rejects.toThrow(/aborted/i);
      expect(await fs.stat(destination).catch(() => undefined)).toBeUndefined();
    });

    test("rejects a download aborted after it starts without writing a destination", async function () {
      const controller = new AbortController();
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "auto-mobile-download-contract-"));
      const destination = path.join(tempDir, "payload.txt");
      const download = makeDownloader(Buffer.from("payload")).download(
        "https://example.invalid/payload",
        destination,
        controller.signal,
      );

      controller.abort();

      await expect(download).rejects.toThrow(/aborted/i);
      expect(await fs.stat(destination).catch(() => undefined)).toBeUndefined();
    });
  });
};

const createPayloadServer = async (
  payload: Buffer,
): Promise<{ url: string; close: () => Promise<void> }> => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, {
      "content-length": String(payload.length),
      "content-type": "application/octet-stream",
    });
    response.end(payload);
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected local HTTP server to listen on a TCP address");
  }

  return {
    url: `http://127.0.0.1:${address.port}/payload`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  };
};
