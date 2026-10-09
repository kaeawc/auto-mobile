import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { DefaultFileDownloader } from "../../src/utils/FileDownloader";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";

type NodeHttpDownloader = {
  onFirstResponseByte?: () => void;
};

const asNodeHttpDownloader = (downloader: DefaultFileDownloader): NodeHttpDownloader =>
  downloader as unknown as NodeHttpDownloader;

// Real loopback socket I/O belongs in the integration lane, not the
// hermetic unit lane (scripts/test-ts.sh classifies by *.integration.test.ts
// suffix). The deterministic fake-stream coverage of the response-close
// regression (issue #6131) lives in test/utils/FileDownloader.test.ts; this
// file only exercises the Node HTTP fallback end to end over a real socket.
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

    const scratchDir = path.join(process.cwd(), "scratch");
    await fs.mkdir(scratchDir, { recursive: true });
    tempDir = await fs.mkdtemp(path.join(scratchDir, "node-http-complete-"));
    const destination = path.join(tempDir, "file.bin");
    // Force the command transports to report unavailable so this exercises
    // the Node fallback through the same atomic contract as curl and wget.
    const unavailable = async (command: string): Promise<void> => {
      throw Object.assign(new Error(`${command} not found`), { code: "ENOENT" });
    };
    const downloader = new DefaultFileDownloader(new CountingIdGenerator("node"), unavailable);

    try {
      await downloader.download(url, destination);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    expect(await fs.readFile(destination)).toEqual(payload);
    expect((await fs.readdir(tempDir)).filter((entry) => entry.includes(".download-")).length).toBe(
      0,
    );
  });

  test("rejects promptly and removes the partial file when a real socket closes mid-body", async function () {
    // Regression coverage for issue #6131 through the real public entry
    // point: test/utils/FileDownloader.test.ts exercises the internal
    // `pipeResponseToFile` helper directly with a fake stream, which would
    // not catch a regression that restored `response.pipe` inside
    // `downloadWithNodeHttp` itself (the actual wiring a caller goes
    // through). This test drives a real loopback HTTP response that
    // announces more bytes than it sends and then destroys the underlying
    // socket — a real premature close, with no error ever surfacing on the
    // response — so it proves the `downloadWithNodeHttp` -> `pipeResponseToFile`
    // wiring, not just the helper in isolation, detects it.
    const partial = Buffer.from("partial body");
    let markFirstByteReceived!: () => void;
    const firstByteReceived = new Promise<void>((resolve) => {
      markFirstByteReceived = resolve;
    });
    const server = http.createServer((request, response) => {
      response.writeHead(200, { "content-length": String(partial.length * 5) });
      // Gate the socket destruction on the client observing the first body
      // chunk, making the mid-body close deterministic without a timer.
      response.write(partial, () => {
        void firstByteReceived.then(() => request.socket.destroy());
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Expected local HTTP server to listen on a TCP address");
    }
    const url = `http://127.0.0.1:${address.port}/payload`;

    const scratchDir = path.join(process.cwd(), "scratch");
    await fs.mkdir(scratchDir, { recursive: true });
    tempDir = await fs.mkdtemp(path.join(scratchDir, "node-http-mid-close-"));
    const destination = path.join(tempDir, "file.bin");
    const existingPayload = Buffer.from("previous complete download");
    await fs.writeFile(destination, existingPayload);
    const unavailable = async (command: string): Promise<void> => {
      throw Object.assign(new Error(`${command} not found`), { code: "ENOENT" });
    };
    const downloader = new DefaultFileDownloader(new CountingIdGenerator("node"), unavailable);
    const responseObserver = asNodeHttpDownloader(downloader);
    responseObserver.onFirstResponseByte = markFirstByteReceived;

    try {
      // The runtimes word a real mid-body socket close differently: Node's
      // `ERR_STREAM_PREMATURE_CLOSE` "Premature close", Bun 1.3's "socket
      // connection was closed unexpectedly", and Bun 1.4's http "aborted" (the
      // message Node's http emits for an aborted response). Match all three so
      // this test asserts the underlying condition (an unterminated response
      // body) rather than one runtime's exact wording.
      await expect(downloader.download(url, destination)).rejects.toThrow(
        /premature close|closed unexpectedly|\baborted\b/i,
      );
      expect(await fs.readFile(destination)).toEqual(existingPayload);
      expect(
        (await fs.readdir(tempDir)).filter((entry) => entry.includes(".download-")).length,
      ).toBe(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 5000);
});
