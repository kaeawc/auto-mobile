import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { LmkPressureBinaryProvider } from "../../../src/features/deviceCondition/lmkPressureBinaryProvider";
import type { LmkPressureFileSystem } from "../../../src/features/deviceCondition/NodeLmkPressureFileSystem";
import type { ChecksumCalculator, Sha256Source } from "../../../src/utils/ChecksumCalculator";
import type { FileDownloader } from "../../../src/utils/FileDownloader";
import { CountingIdGenerator } from "../../../src/utils/IdGenerator";
import { FakeTimer } from "../../fakes/FakeTimer";

const CACHE = "/cache/lmk-pressure";
const ARM_BYTES = "arm64 payload";
const X86_BYTES = "x86_64 payload";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

class MemoryFileSystem implements LmkPressureFileSystem {
  readonly files = new Map<string, string>();
  readonly dirs = new Set<string>();
  async readText(path: string): Promise<string | null> {
    return this.files.get(path) ?? null;
  }
  async writeText(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }
  async remove(path: string): Promise<void> {
    this.files.delete(path);
  }
  async rename(from: string, to: string): Promise<void> {
    const content = this.files.get(from);
    if (content === undefined) {
      throw new Error(`ENOENT ${from}`);
    }
    this.files.delete(from);
    this.files.set(to, content);
  }
  async ensureDir(path: string): Promise<void> {
    this.dirs.add(path);
  }
  async fileSize(path: string): Promise<number | null> {
    const content = this.files.get(path);
    return content === undefined ? null : Buffer.byteLength(content);
  }
}

class MemoryDownloader implements FileDownloader {
  readonly urls: string[] = [];
  bodies = new Map<string, string>();
  release: (() => void) | null = null;
  private gate: Promise<void> | null = null;
  constructor(private readonly fs: MemoryFileSystem) {}
  hold(): void {
    this.gate = new Promise((resolve) => {
      this.release = resolve;
    });
  }
  async download(url: string, destination: string): Promise<void> {
    this.urls.push(url);
    if (this.gate) {
      await this.gate;
    }
    const body = this.bodies.get(url);
    if (body === undefined) {
      throw new Error(`404 ${url}`);
    }
    this.fs.files.set(destination, body);
  }
}

class ContentChecksum implements ChecksumCalculator {
  constructor(private readonly fs: MemoryFileSystem) {}
  async computeFileSha256(path: string): Promise<{ checksum: string; source: Sha256Source }> {
    return { checksum: sha(this.fs.files.get(path) ?? ""), source: "node" };
  }
}

function setup(checksums: Partial<Record<"arm64-v8a" | "x86_64", string>> = {}) {
  const fs = new MemoryFileSystem();
  const downloader = new MemoryDownloader(fs);
  downloader.bodies.set("https://assets/arm64-v8a", ARM_BYTES);
  downloader.bodies.set("https://assets/x86_64", X86_BYTES);
  const provider = new LmkPressureBinaryProvider({
    fileSystem: fs,
    downloader,
    checksumCalculator: new ContentChecksum(fs),
    timer: new FakeTimer(),
    cacheDir: CACHE,
    expectedChecksum: (abi) => checksums[abi] ?? "",
    releaseUrl: (abi) => `https://assets/${abi}`,
    idGenerator: new CountingIdGenerator("a"),
  });
  return { fs, downloader, provider };
}

describe("LmkPressureBinaryProvider (#16402)", () => {
  test("returns null without touching the network when the pinned release has no checksum", async () => {
    const { downloader, provider } = setup({ "arm64-v8a": sha(ARM_BYTES) });
    expect(await provider.ensure("x86_64")).toBeNull();
    expect(downloader.urls).toEqual([]);
  });

  test("downloads, verifies and caches each ABI under its own path", async () => {
    const { fs, downloader, provider } = setup({
      "arm64-v8a": sha(ARM_BYTES),
      x86_64: sha(X86_BYTES),
    });
    const arm = await provider.ensure("arm64-v8a");
    const x86 = await provider.ensure("x86_64");
    expect(arm).toBe(join(CACHE, "arm64-v8a", "lmk_pressure"));
    expect(x86).toBe(join(CACHE, "x86_64", "lmk_pressure"));
    expect(fs.files.get(arm ?? "")).toBe(ARM_BYTES);
    expect(fs.files.get(x86 ?? "")).toBe(X86_BYTES);
    expect(downloader.urls).toEqual(["https://assets/arm64-v8a", "https://assets/x86_64"]);
    expect(
      JSON.parse(fs.files.get(join(CACHE, "x86_64", "lmk-pressure.json")) ?? "{}"),
    ).toMatchObject({ sha256: sha(X86_BYTES), size: Buffer.byteLength(X86_BYTES) });
  });

  test("reuses a verified cached binary without downloading again", async () => {
    const { downloader, provider } = setup({ x86_64: sha(X86_BYTES) });
    const first = await provider.ensure("x86_64");
    const second = await provider.ensure("x86_64");
    expect(second).toBe(first);
    expect(downloader.urls).toEqual(["https://assets/x86_64"]);
  });

  test("re-downloads when the cached binary's size no longer matches its metadata", async () => {
    const { fs, downloader, provider } = setup({ x86_64: sha(X86_BYTES) });
    const path = (await provider.ensure("x86_64")) ?? "";
    fs.files.set(path, "truncated");
    expect(await provider.ensure("x86_64")).toBe(path);
    expect(fs.files.get(path)).toBe(X86_BYTES);
    expect(downloader.urls).toHaveLength(2);
  });

  test("re-downloads when the pinned checksum changed since the binary was cached", async () => {
    const checksums: Partial<Record<"arm64-v8a" | "x86_64", string>> = { x86_64: sha(X86_BYTES) };
    const { downloader, provider } = setup(checksums);
    await provider.ensure("x86_64");
    checksums.x86_64 = sha("next release");
    downloader.bodies.set("https://assets/x86_64", "next release");
    await provider.ensure("x86_64");
    expect(downloader.urls).toHaveLength(2);
  });

  test("a checksum mismatch throws and publishes nothing", async () => {
    const { fs, provider } = setup({ x86_64: sha("something else") });
    await expect(provider.ensure("x86_64")).rejects.toThrow(
      "memory-pressure binary checksum verification failed",
    );
    expect([...fs.files.keys()]).toEqual([]);
  });

  test("concurrent requests for one ABI share a single download", async () => {
    const { downloader, provider } = setup({ x86_64: sha(X86_BYTES) });
    downloader.hold();
    const both = Promise.all([provider.ensure("x86_64"), provider.ensure("x86_64")]);
    await Promise.resolve();
    downloader.release?.();
    const [a, b] = await both;
    expect(a).toBe(b);
    expect(downloader.urls).toEqual(["https://assets/x86_64"]);
  });

  test("separate providers downloading the same ABI at once both succeed (#16411 review)", async () => {
    const { fs, downloader, provider } = setup({ x86_64: sha(X86_BYTES) });
    // A second device's apply builds its own provider over the same cache directory.
    const other = new LmkPressureBinaryProvider({
      fileSystem: fs,
      downloader,
      checksumCalculator: new ContentChecksum(fs),
      timer: new FakeTimer(),
      cacheDir: CACHE,
      expectedChecksum: () => sha(X86_BYTES),
      releaseUrl: (abi) => `https://assets/${abi}`,
      idGenerator: new CountingIdGenerator("b"),
    });
    downloader.hold();
    const both = Promise.all([provider.ensure("x86_64"), other.ensure("x86_64")]);
    await Promise.resolve();
    downloader.release?.();
    const [a, b] = await both;
    expect(a).toBe(join(CACHE, "x86_64", "lmk_pressure"));
    expect(b).toBe(a);
    expect(fs.files.get(a ?? "")).toBe(X86_BYTES);
    expect([...fs.files.keys()].filter((path) => path.endsWith(".download"))).toEqual([]);
  });
});
