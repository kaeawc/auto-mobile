import { afterEach } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodePrototypeAssetFileReader } from "../../src/features/prototype/prototypeAssetUploader";
import { FakePrototypeAssetFileReader } from "../fakes/FakePrototypeAssetFileReader";
import { runPrototypeAssetFileReaderContract } from "./PrototypeAssetFileReaderContract";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

runPrototypeAssetFileReaderContract(
  "nodePrototypeAssetFileReader over a temp directory",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "prototype-asset-reader-"));
    tempDirs.push(root);
    return {
      reader: nodePrototypeAssetFileReader,
      addFile: async (name, bytes) => {
        const path = join(root, name);
        await writeFile(path, bytes);
        return path;
      },
      addDirectory: async (name) => {
        const path = join(root, name);
        await mkdir(path);
        return path;
      },
      missingPath: (name) => join(root, name),
    };
  },
);

runPrototypeAssetFileReaderContract("FakePrototypeAssetFileReader", async () => {
  const reader = new FakePrototypeAssetFileReader();
  return {
    reader,
    addFile: async (name, bytes) => {
      reader.addFile(`/assets/${name}`, bytes);
      return `/assets/${name}`;
    },
    addDirectory: async (name) => {
      reader.addDirectory(`/assets/${name}`);
      return `/assets/${name}`;
    },
    missingPath: (name) => `/assets/${name}`,
  };
});
