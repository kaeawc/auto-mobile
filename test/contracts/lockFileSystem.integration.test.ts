import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { nodeLockFileSystem } from "../../src/utils/lockFileSystem";
import { FakeLockFileSystem } from "../fakes/FakeLockFileSystem";
import { runLockFileSystemContract } from "./LockFileSystemContract";

runLockFileSystemContract("FakeLockFileSystem", async () => {
  const fileSystem = new FakeLockFileSystem();
  fileSystem.mkdir("/root");
  return { fileSystem, root: "/root" };
});

// Real side: the node-backed lock filesystem over a private mkdtemp directory (#11868).
runLockFileSystemContract("nodeLockFileSystem (temp directory)", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "am-lock-fs-contract-"));
  return {
    fileSystem: nodeLockFileSystem,
    root,
    dispose: () => rm(root, { recursive: true, force: true }),
  };
});
