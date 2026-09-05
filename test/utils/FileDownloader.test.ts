import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { DefaultFileDownloader } from "../../src/utils/FileDownloader";
import { FakeFileDownloader } from "../fakes/FakeFileDownloader";

type PipeResponseToFile = {
  pipeResponseToFile(response: Readable, destination: string, url: string): Promise<void>;
};

const asPipeResponseToFile = (downloader: DefaultFileDownloader): PipeResponseToFile =>
  downloader as unknown as PipeResponseToFile;

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
    // data, then is destroyed WITHOUT ending and WITHOUT an error — the
    // exact shape of a peer closing the connection before Content-Length
    // bytes arrive with no socket-level error surfacing. Only a 'close'
    // event fires here, never 'error', so this exercises `stream.pipeline`
    // itself detecting the premature EOF (`ERR_STREAM_PREMATURE_CLOSE`)
    // rather than an error listener relaying a supplied error message. A
    // fix that only listens for response 'error'/'aborted' would still
    // hang on this input. The pre-fix implementation
    // (`response.pipe(fileStream)`, settling only on the file stream's
    // 'finish'/'error') never observes this and hangs forever; verified
    // directly against the pre-fix code, which timed out well past this
    // test's bound.
    //
    // The destroy is scheduled AFTER `pipeResponseToFile` is called (not
    // before) so the source is destroyed while `stream.pipeline` is
    // actively consuming it, not before piping even starts — otherwise an
    // implementation that merely checks `response.destroyed` at entry
    // (and still hangs on a genuine mid-stream close) would also pass.
    const response = createFakeResponse();
    response.push(Buffer.from("partial body"));

    tempDir = await makeScratchTempDir("pipe-response-mid-close-");
    const destination = path.join(tempDir, "file.bin");
    const downloader = asPipeResponseToFile(new DefaultFileDownloader());

    const result = downloader.pipeResponseToFile(response, destination, "https://example.com/file");
    queueMicrotask(() => response.destroy());

    await expect(result).rejects.toThrow(/premature close/i);

    expect(await fs.stat(destination).catch(() => undefined)).toBeUndefined();
    // No attempt-unique temp file is left behind either.
    expect(await fs.readdir(tempDir)).toEqual([]);
  }, 500);

  test("a failed attempt never removes a file another attempt already wrote to the same destination", async function () {
    // Regression guard: failure cleanup must only ever remove the failed
    // attempt's own temp file, never the shared `destination` — otherwise a
    // slow-to-settle failed attempt can delete a concurrent/retried
    // download's completed file out from under it (issue #6131 review).
    // Same close-only, destroy-after-start shape as above: no error
    // emitted, only 'close', and destroyed while piping is in progress.
    const response = createFakeResponse();
    response.push(Buffer.from("partial body"));

    tempDir = await makeScratchTempDir("pipe-response-mid-close-race-");
    const destination = path.join(tempDir, "file.bin");
    const existingPayload = Buffer.from("already downloaded by another attempt");
    await fs.writeFile(destination, existingPayload);
    const downloader = asPipeResponseToFile(new DefaultFileDownloader());

    const result = downloader.pipeResponseToFile(response, destination, "https://example.com/file");
    queueMicrotask(() => response.destroy());

    await expect(result).rejects.toThrow(/premature close/i);

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

// A real-socket end-to-end test of downloadWithNodeHttp lives in
// test/utils/FileDownloaderNodeHttp.integration.test.ts — real loopback I/O
// belongs in the integration lane, not this hermetic unit-test file.

const makeScratchTempDir = async (prefix: string): Promise<string> => {
  const scratchDir = path.join(process.cwd(), "scratch");
  await fs.mkdir(scratchDir, { recursive: true });
  return fs.mkdtemp(path.join(scratchDir, prefix));
};
