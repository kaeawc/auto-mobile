import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { Readable } from "node:stream";
import { DefaultFileDownloader } from "../../src/utils/FileDownloader";
import { FakeFileDownloader } from "../fakes/FakeFileDownloader";

type PipeResponseToFile = {
  pipeResponseToFile(response: Readable, destination: string, url: string): Promise<void>;
};

const asPipeResponseToFile = (downloader: DefaultFileDownloader): PipeResponseToFile =>
  downloader as unknown as PipeResponseToFile;

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
 * A minimal stand-in for `http.IncomingMessage` that lets a test control
 * exactly when the body stream ends, errors, or is destroyed without
 * ending — deterministically, with no real socket involved.
 *
 * Node's real `IncomingMessage` always carries an internal 'error'
 * listener wired up by the http client's socket plumbing, so a premature
 * close never crashes the process even though `response.pipe(dest)`
 * itself adds no listener. A bare `new Readable()` has none, so it would
 * throw an unhandled 'error' the instant `destroy(err)` is called; the
 * no-op listener below reproduces that internal safety net so the fake
 * behaves like a real response stream in this one respect.
 */
const createFakeResponse = (): Readable => {
  const response = new Readable({ read() {} });
  response.on("error", () => {
    // Real IncomingMessage instances never throw an unhandled error for a
    // premature close; see the comment above.
  });
  return response;
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

describe("DefaultFileDownloader pipeResponseToFile", function () {
  let tempDir: string | null = null;

  afterEach(async function () {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  test("rejects promptly and removes the partial file when the response closes mid-body", async function () {
    // Regression repro for issue #6131: the response stream receives some
    // data, then is destroyed WITHOUT ending — the exact shape of a peer
    // closing the connection before Content-Length bytes arrive. The
    // pre-fix implementation (`response.pipe(fileStream)`, settling only
    // on the file stream's 'finish'/'error') never observes this and
    // hangs forever; verified directly against the pre-fix code, which
    // timed out well past this test's bound.
    const response = createFakeResponse();
    response.push(Buffer.from("partial body"));
    queueMicrotask(() => response.destroy(new Error("simulated premature close")));

    tempDir = await makeScratchTempDir("pipe-response-mid-close-");
    const destination = path.join(tempDir, "file.bin");
    const downloader = asPipeResponseToFile(new DefaultFileDownloader());

    await expect(
      downloader.pipeResponseToFile(response, destination, "https://example.com/file"),
    ).rejects.toThrow(/premature close/i);

    expect(await fs.stat(destination).catch(() => undefined)).toBeUndefined();
    // No attempt-unique temp file is left behind either.
    expect(await fs.readdir(tempDir)).toEqual([]);
  }, 500);

  test("a failed attempt never removes a file another attempt already wrote to the same destination", async function () {
    // Regression guard: failure cleanup must only ever remove the failed
    // attempt's own temp file, never the shared `destination` — otherwise a
    // slow-to-settle failed attempt can delete a concurrent/retried
    // download's completed file out from under it (issue #6131 review).
    const response = createFakeResponse();
    response.push(Buffer.from("partial body"));
    queueMicrotask(() => response.destroy(new Error("simulated premature close")));

    tempDir = await makeScratchTempDir("pipe-response-mid-close-race-");
    const destination = path.join(tempDir, "file.bin");
    const existingPayload = Buffer.from("already downloaded by another attempt");
    await fs.writeFile(destination, existingPayload);
    const downloader = asPipeResponseToFile(new DefaultFileDownloader());

    await expect(
      downloader.pipeResponseToFile(response, destination, "https://example.com/file"),
    ).rejects.toThrow(/premature close/i);

    expect(await fs.readFile(destination)).toEqual(existingPayload);
  }, 500);

  test("resolves and writes the full file for a complete response", async function () {
    const payload = Buffer.from("complete download payload");
    const response = createFakeResponse();
    response.push(payload);
    response.push(null);

    tempDir = await makeScratchTempDir("pipe-response-complete-");
    const destination = path.join(tempDir, "file.bin");
    const downloader = asPipeResponseToFile(new DefaultFileDownloader());

    await downloader.pipeResponseToFile(response, destination, "https://example.com/file");

    expect(await fs.readFile(destination)).toEqual(payload);
    // No leftover attempt-unique temp file after a successful rename.
    expect(await fs.readdir(tempDir)).toEqual(["file.bin"]);
  }, 500);
});

describe("DefaultFileDownloader downloadWithNodeHttp (end to end, real socket)", function () {
  let tempDir: string | null = null;

  afterEach(async function () {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  test("resolves with the full file for a complete real HTTP response", async function () {
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
    // Calls the private downloadWithNodeHttp directly so the test exercises
    // the Node HTTP fallback path itself, bypassing the curl/wget tiers
    // that download() would otherwise prefer on a host that has them.
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
