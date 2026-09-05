import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { DefaultFileDownloader } from "../../src/utils/FileDownloader";
import { FakeFileDownloader } from "../fakes/FakeFileDownloader";

type NodeHttpDownloader = {
  downloadWithNodeHttp(
    url: string,
    destination: string,
    redirectCount: number,
    signal?: AbortSignal,
  ): Promise<void>;
};

const asNodeHttpDownloader = (downloader: DefaultFileDownloader): NodeHttpDownloader =>
  downloader as unknown as NodeHttpDownloader;

/**
 * Starts a bare TCP server that writes HTTP/1.1 response headers plus
 * `sentBytes` of a declared `declaredLength`-byte body, then gracefully
 * half-closes the socket (FIN, not RST) before the body completes —
 * simulating a peer that closes the connection mid-body (issue #6131).
 *
 * A real `http.createServer` + `response.socket.destroy()` sends a TCP
 * RST, which Node's http client surfaces as a `request` "error" — the
 * pre-existing handler this bug report says is NOT the gap. A graceful
 * half-close only ever reaches the client as a `response` "aborted"/
 * "error"/"close" event, which is exactly the gap `downloadWithNodeHttp`
 * had: a repro that instead triggers `request` "error" would still pass
 * against the unfixed code and prove nothing.
 */
const createMidBodyCloseServer = async (
  sentBytes: number,
  declaredLength: number,
): Promise<{ url: string; close: () => Promise<void> }> => {
  const server = net.createServer((socket) => {
    socket.once("data", () => {
      socket.write(
        `HTTP/1.1 200 OK\r\nContent-Length: ${declaredLength}\r\nConnection: close\r\n\r\n`,
      );
      socket.write(Buffer.alloc(sentBytes, "a"));
      socket.end();
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected local TCP server to listen on a TCP address");
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

describe("DefaultFileDownloader downloadWithNodeHttp", function () {
  let tempDir: string | null = null;

  afterEach(async function () {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  test("rejects promptly and removes the partial file when the server closes mid-body", async function () {
    const server = await createMidBodyCloseServer(1000, 1_000_000);
    tempDir = await makeScratchTempDir("node-http-mid-close-");
    const destination = path.join(tempDir, "file.bin");
    const downloader = asNodeHttpDownloader(new DefaultFileDownloader());

    try {
      await expect(downloader.downloadWithNodeHttp(server.url, destination, 0)).rejects.toThrow();
    } finally {
      await server.close();
    }

    expect(await fs.stat(destination).catch(() => undefined)).toBeUndefined();
    // No attempt-unique temp file is left behind either.
    expect(await fs.readdir(tempDir)).toEqual([]);
  }, 2000);

  test("a failed attempt never removes a file another attempt already wrote to the same destination", async function () {
    // Regression guard: failure cleanup must only ever remove the failed
    // attempt's own temp file, never the shared `destination` — otherwise a
    // slow-to-settle failed attempt can delete a concurrent/retried
    // download's completed file out from under it (issue #6131 review).
    const server = await createMidBodyCloseServer(1000, 1_000_000);
    tempDir = await makeScratchTempDir("node-http-mid-close-race-");
    const destination = path.join(tempDir, "file.bin");
    const existingPayload = Buffer.from("already downloaded by another attempt");
    await fs.writeFile(destination, existingPayload);
    const downloader = asNodeHttpDownloader(new DefaultFileDownloader());

    try {
      await expect(downloader.downloadWithNodeHttp(server.url, destination, 0)).rejects.toThrow();
    } finally {
      await server.close();
    }

    expect(await fs.readFile(destination)).toEqual(existingPayload);
  }, 2000);

  test("resolves with the full file for a complete response", async function () {
    const payload = Buffer.from("complete download payload");
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { "content-length": String(payload.length) });
      response.end(payload);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Expected local HTTP server to listen on a TCP address");
    }
    const url = `http://127.0.0.1:${address.port}/payload`;

    tempDir = await makeScratchTempDir("node-http-complete-");
    const destination = path.join(tempDir, "file.bin");
    const downloader = asNodeHttpDownloader(new DefaultFileDownloader());

    try {
      await downloader.downloadWithNodeHttp(url, destination, 0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    expect(await fs.readFile(destination)).toEqual(payload);
  }, 2000);
});

const makeScratchTempDir = async (prefix: string): Promise<string> => {
  const scratchDir = path.join(process.cwd(), "scratch");
  await fs.mkdir(scratchDir, { recursive: true });
  return fs.mkdtemp(path.join(scratchDir, prefix));
};
