import { beforeEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { useScratchRoot } from "../../helpers/scratchRoot";
import { NodeCloneRelocationFileSystem } from "../../../src/features/iosTemplates/NodeCloneRelocationFileSystem";

const OLD = "E63A5A84-4C3D-4635-9BB6-9EEA7ABBDE77";
const NEW = "3CC91698-300E-4A9D-AF3B-8F8424E1FBF1";

let root: string;
const fs = new NodeCloneRelocationFileSystem();

const scratch = useScratchRoot("clone-relocation-");
beforeEach(() => {
  root = scratch.next();
});

function write(relative: string, content: string | Buffer): string {
  const path = join(root, relative);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
  return path;
}

test("scan lists files containing the needle and links whose target does", async () => {
  const hit = write(
    "var/db/lsd/store.csstore",
    Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(OLD), Buffer.from([0])]),
  );
  write("Library/other.plist", "no udid here");
  write("var/db/diagnostics/Persist/0001.tracev3", OLD);
  symlinkSync(`/Users/x/Library/Logs/CoreSimulator/${OLD}`, join(root, "Logs"));
  symlinkSync("relative/target", join(root, "Plain"));
  expect(await fs.scan(root, OLD, ["var/db/diagnostics"])).toEqual({
    files: [hit],
    links: [join(root, "Logs")],
  });
});

test("scan finds a needle that straddles a read-chunk boundary", async () => {
  const chunk = 1024 * 1024;
  const content = Buffer.alloc(chunk * 2 + 10, 0x61);
  Buffer.from(OLD).copy(content, chunk - 10);
  const path = write("big.bin", content);
  expect((await fs.scan(root, OLD, [])).files).toEqual([path]);
});

test("replaceInFile rewrites every occurrence and leaves other bytes untouched", async () => {
  const path = write(
    "a.bin",
    Buffer.concat([Buffer.from("x"), Buffer.from(OLD), Buffer.from([0xff]), Buffer.from(OLD)]),
  );
  await fs.replaceInFile(path, OLD, NEW);
  expect(readFileSync(path)).toEqual(
    Buffer.concat([Buffer.from("x"), Buffer.from(NEW), Buffer.from([0xff]), Buffer.from(NEW)]),
  );
});

test("replaceInFile refuses a length-changing rewrite", async () => {
  const path = write("a.bin", OLD);
  await expect(fs.replaceInFile(path, OLD, "short")).rejects.toThrow("length-changing");
});

test("retargetLink points the link at the clone", async () => {
  const link = join(root, "Logs");
  symlinkSync(`/Users/x/${OLD}/data/file`, link);
  await fs.retargetLink(link, OLD, NEW);
  expect(readlinkSync(link)).toBe(`/Users/x/${NEW}/data/file`);
});

test("exists is true for a file, false for a missing path", async () => {
  const path = write("db.sqlite", "x");
  expect(await fs.exists(path)).toBe(true);
  expect(await fs.exists(join(root, "missing.sqlite"))).toBe(false);
});

test("an aborted signal stops the scan", async () => {
  write("a", OLD);
  const controller = new AbortController();
  controller.abort(new Error("stop"));
  await expect(fs.scan(root, OLD, [], controller.signal)).rejects.toThrow("stop");
});
