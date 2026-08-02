import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

describe("packaged WebRTC runtime metadata", () => {
  test("reflect-metadata is a direct runtime dependency", async () => {
    const pkg = await Bun.file("package.json").json();

    expect(pkg.dependencies["reflect-metadata"]).toBeString();
  });

  test("the packaged entrypoint initializes runtime metadata first", async () => {
    const entrypoint = await Bun.file("src/index.ts").text();
    const executableBody = entrypoint.replace(/^#!.*\r?\n/, "");
    const firstImportLine = executableBody
      .split(/\r?\n/)
      .find(line => line.startsWith("import "));

    expect(firstImportLine).toBe('import "./runtime/reflectMetadata";');
  });

  test("runtime metadata initialization loads reflect-metadata", async () => {
    const runtimeInit = await Bun.file("src/runtime/reflectMetadata.ts").text();

    expect(runtimeInit.trim()).toBe('import "reflect-metadata";');
  });

  test("a bundled WebRTC startup path reaches WHIP publish", { timeout: 15_000 }, async () => {
    const workspaceScratch = join(import.meta.dir, "../../scratch");
    await mkdir(workspaceScratch, { recursive: true });
    const dir = await mkdtemp(join(workspaceScratch, "webrtc-bundle-"));
    try {
      const entrypoint = join(dir, "entry.ts");
      await writeFile(
        entrypoint,
        `
import "../../src/runtime/reflectMetadata.ts";
import { WebRtcPublisher, WhipClient } from "../../src/features/webrtc/index.ts";

class FakePeerConnection {
  connectionState = "connected";
  iceGatheringState = "complete";
  connectionStateChange = { subscribe: () => {} };
  iceGatheringStateChange = { watch: async () => {} };
  localDescription = { sdp: "v=0" };
  addTransceiver() {
    return { sender: { ssrc: 1, onPictureLossIndication: { subscribe: () => {} } } };
  }
  async createOffer() {
    return { type: "offer", sdp: "v=0" };
  }
  async setLocalDescription() {}
  async setRemoteDescription() {}
  async close() {}
}

const posts = [];
const publisher = new WebRtcPublisher(
  {
    streamId: "debug-1",
    whipEndpoint: "http://localhost:8000/api/v1/webrtc/whip?streamId=debug-1",
    maxReconnectAttempts: 1,
  },
  {
    createPeerConnection: () => new FakePeerConnection(),
    createWhipClient: options =>
      new WhipClient({
        ...options,
        fetchImpl: async (url, init) => {
          posts.push({ url, method: init.method });
          return {
            status: 201,
            ok: true,
            headers: { get: name => (name.toLowerCase() === "location" ? "/whip/resource/debug-1" : null) },
            text: async () => ["v=0", "m=video 9 UDP/TLS/RTP/SAVPF 96", "a=recvonly", "a=rtpmap:96 H264/90000", "a=fmtp:96 packetization-mode=1;profile-level-id=42e02a", ""].join("\\r\\n"),
          };
        },
      }),
  }
);

await publisher.start();
await publisher.stop();
if (!posts.some(post => post.method === "POST" && post.url.includes("streamId=debug-1"))) {
  throw new Error("WHIP POST was not reached");
}
console.log("ok");
`
      );

      const build = await Bun.build({
        entrypoints: [entrypoint],
        outdir: dir,
        target: "bun",
        format: "esm",
        minify: true,
      });
      expect(build.success).toBe(true);
      expect(build.outputs).toHaveLength(1);
      const bundledEntrypoint = build.outputs[0].path;

      const proc = Bun.spawn([process.execPath, bundledEntrypoint], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);

      expect(stderr).toBe("");
      expect(stdout.trim()).toBe("ok");
      expect(exitCode).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
