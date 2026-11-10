import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { exportPrototypeWeb } from "../../src/server/prototypeWebExport";
import { NodePrototypeWebExportFiles } from "../../src/server/NodePrototypeWebExportFiles";
import { CountingIdGenerator } from "../../src/utils/CountingIdGenerator";

// The real Node adapter over a private mkdtemp directory removed afterwards (#17733).
const PAGE = new TextEncoder().encode("<!doctype html><html><body>page</body></html>");
const isWindows = process.platform === "win32";
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

let root: string;
let files: NodePrototypeWebExportFiles;

const text = async (filePath: string) => await readFile(filePath, "utf8");

describe("NodePrototypeWebExportFiles", () => {
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "am-proto-web-export-"));
    files = new NodePrototypeWebExportFiles(new CountingIdGenerator("t"));
  });

  afterEach(async () => {
    await chmod(root, 0o755).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });

  test("an exclusive write creates missing parents and never clobbers an existing file", async () => {
    const target = path.join(root, "nested", "page.html");
    await files.write(target, PAGE, { exclusive: true });
    expect(await text(target)).toBe(new TextDecoder().decode(PAGE));
    expect(await files.kind(target)).toBe("file");
    expect(await files.kind(path.dirname(target))).toBe("directory");
    expect(await files.kind(path.join(root, "missing.html"))).toBeUndefined();

    await writeFile(target, "keep");
    await expect(files.write(target, PAGE, { exclusive: true })).rejects.toMatchObject({
      code: "EEXIST",
    });
    expect(await text(target)).toBe("keep");
  });

  test("an overwrite replaces the file and leaves no temp file behind", async () => {
    const target = path.join(root, "page.html");
    await writeFile(target, "old");
    await files.write(target, PAGE, { exclusive: false });
    expect(await text(target)).toBe(new TextDecoder().decode(PAGE));
    expect(await readdir(root)).toEqual(["page.html"]);
  });

  test.skipIf(isWindows)(
    "an overwrite replaces a symlink at the path instead of writing through it",
    async () => {
      const victim = path.join(root, "victim.txt");
      await writeFile(victim, "do not touch");
      const link = path.join(root, "page.html");
      await symlink(victim, link);

      await expect(files.write(link, PAGE, { exclusive: true })).rejects.toMatchObject({
        code: "EEXIST",
      });
      await files.write(link, PAGE, { exclusive: false });
      expect(await text(victim)).toBe("do not touch");
      expect((await lstat(link)).isSymbolicLink()).toBe(false);
      expect(await text(link)).toBe(new TextDecoder().decode(PAGE));
      expect((await readdir(root)).sort()).toEqual(["page.html", "victim.txt"]);
    },
  );

  test.skipIf(isWindows)(
    "exportPrototypeWeb with overwrite leaves a symlink's target alone",
    async () => {
      const victim = path.join(root, "victim.html");
      await writeFile(victim, "do not touch");
      const link = path.join(root, "page.html");
      await symlink(victim, link);
      const result = await exportPrototypeWeb(
        { id: "checkout", outputPath: link, overwrite: true },
        {
          readWeb: async () => ({
            uri: "automobile:prototype/checkout/web",
            text: new TextDecoder().decode(PAGE),
            _meta: { frame: "pixel-9", revision: 1, variants: ["checkout"], rendererVersion: "1" },
          }),
          files,
        },
      );
      expect(result.path).toBe(link);
      expect(await text(victim)).toBe("do not touch");
      expect(await text(link)).toBe(new TextDecoder().decode(PAGE));
    },
  );

  test("a parent that is a file fails the write without leaving a temp file", async () => {
    const blocker = path.join(root, "blocker");
    await writeFile(blocker, "file, not a directory");
    for (const exclusive of [true, false]) {
      await expect(
        files.write(path.join(blocker, "page.html"), PAGE, { exclusive }),
      ).rejects.toMatchObject({ code: expect.stringMatching(/^(ENOTDIR|EEXIST|ENOENT)$/) });
    }
    expect(await readdir(root)).toEqual(["blocker"]);
  });

  test.skipIf(isWindows || isRoot)(
    "a read-only directory fails both writes and keeps the existing file",
    async () => {
      const locked = path.join(root, "locked");
      await mkdir(locked);
      const target = path.join(locked, "page.html");
      await writeFile(target, "old");
      await chmod(locked, 0o555);
      for (const exclusive of [true, false]) {
        await expect(files.write(target, PAGE, { exclusive })).rejects.toMatchObject({
          code: expect.stringMatching(/^(EACCES|EPERM|EEXIST)$/),
        });
      }
      await chmod(locked, 0o755);
      expect(await text(target)).toBe("old");
      expect(await readdir(locked)).toEqual(["page.html"]);
    },
  );
});
