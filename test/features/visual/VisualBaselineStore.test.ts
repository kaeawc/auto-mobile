import { describe, expect, test } from "bun:test";
import path from "node:path";
import {
  FileVisualBaselineStore,
  type BaselineFs,
} from "../../../src/features/visual/VisualBaselineStore";
import type { VisualDeviceProfile } from "../../../src/features/visual/VisualDeviceProfile";

/** A flat in-memory file map standing in for node:fs/promises. */
class MemoryFs implements BaselineFs {
  readonly files = new Map<string, Buffer>();

  private missing(filePath: string): Error {
    return Object.assign(new Error(`ENOENT: ${filePath}`), { code: "ENOENT" });
  }

  async readFile(filePath: string): Promise<Buffer> {
    const value = this.files.get(filePath);
    if (value === undefined) {
      throw this.missing(filePath);
    }
    return value;
  }

  async writeFile(filePath: string, data: Buffer | string): Promise<void> {
    this.files.set(filePath, Buffer.from(data));
  }

  async mkdir(): Promise<void> {}

  async readdir(dirPath: string): Promise<string[]> {
    const prefix = `${dirPath}${path.sep}`;
    const entries = [...this.files.keys()]
      .filter((key) => key.startsWith(prefix))
      .map((key) => key.slice(prefix.length));
    if (entries.length === 0) {
      throw this.missing(dirPath);
    }
    return entries;
  }
}

const memoryFs = () => new MemoryFs();

/** The store joins with the platform separator, so expected paths do too (`\\` on Windows). */
const underRoot = (...segments: string[]) => path.join("/root", ...segments);

const LIGHT: VisualDeviceProfile = {
  platform: "ios",
  width: 1179,
  height: 2556,
  density: 3,
  fontScale: null,
  theme: "light",
};

describe("FileVisualBaselineStore (#14083)", () => {
  test("write then read round-trips the PNG and profile under a per-profile path", async () => {
    const fs = memoryFs();
    const store = new FileVisualBaselineStore(() => "/root", fs);
    const written = await store.write("login", LIGHT, Buffer.from("png"), "t0");
    expect(written.path).toBe(underRoot("login", "ios-1179x2556-d3-fna-light.png"));
    const read = await store.read("login", LIGHT);
    expect(read?.png.toString()).toBe("png");
    expect(read?.recordedAt).toBe("t0");
    expect(store.diffPath("login", LIGHT)).toBe(
      underRoot("login", "ios-1179x2556-d3-fna-light.diff.png"),
    );
  });

  test("a missing baseline reads as null and has no other profiles", async () => {
    const store = new FileVisualBaselineStore(() => "/root", memoryFs());
    expect(await store.read("login", LIGHT)).toBeNull();
    expect(await store.otherProfiles("login", LIGHT)).toEqual([]);
  });

  test("otherProfiles lists the profiles recorded besides this one", async () => {
    const store = new FileVisualBaselineStore(() => "/root", memoryFs());
    const dark = { ...LIGHT, theme: "dark" };
    await store.write("login", LIGHT, Buffer.from("a"), "t0");
    await store.write("login", dark, Buffer.from("b"), "t1");
    expect(await store.otherProfiles("login", LIGHT)).toEqual([dark]);
  });

  test("a corrupt sidecar is an error, not a silently different profile", async () => {
    const fs = memoryFs();
    const store = new FileVisualBaselineStore(() => "/root", fs);
    await store.write("login", LIGHT, Buffer.from("a"), "t0");
    fs.files.set(
      underRoot("login", "ios-1179x2556-d3-fna-light.json"),
      Buffer.from('{"profile":{}}'),
    );
    await expect(store.read("login", LIGHT)).rejects.toThrow();
  });

  test("names that could leave the baseline root are rejected", async () => {
    const store = new FileVisualBaselineStore(() => "/root", memoryFs());
    for (const name of ["../x", "a/b", ".hidden", "a..b", ""]) {
      await expect(store.read(name, LIGHT)).rejects.toThrow("Baseline name");
    }
  });
});
