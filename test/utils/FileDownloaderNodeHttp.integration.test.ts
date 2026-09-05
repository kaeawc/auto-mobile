import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { DefaultFileDownloader } from "../../src/utils/FileDownloader";

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
  });
});
