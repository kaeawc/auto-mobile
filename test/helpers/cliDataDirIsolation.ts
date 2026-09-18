import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface IsolatedCliDataDir {
  dataDir: string;
  restore(): void;
}

/**
 * Point AUTOMOBILE_DATA_DIR at a fresh temp directory so CLI tests never read
 * or write the real developer or CI machine's ~/.auto-mobile data.
 */
export function isolateCliDataDir(prefix = "automobile-cli-test-"): IsolatedCliDataDir {
  const previousDataDir = process.env.AUTOMOBILE_DATA_DIR;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.env.AUTOMOBILE_DATA_DIR = dataDir;

  return {
    dataDir,
    restore(): void {
      if (previousDataDir === undefined) {
        delete process.env.AUTOMOBILE_DATA_DIR;
      } else {
        process.env.AUTOMOBILE_DATA_DIR = previousDataDir;
      }
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
