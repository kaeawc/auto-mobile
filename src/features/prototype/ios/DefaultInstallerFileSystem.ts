import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { InstallerFileSystem } from "./iosPrototypeInstaller";

export class DefaultInstallerFileSystem implements InstallerFileSystem {
  mkdtemp(): Promise<string> {
    return mkdtemp(path.posix.join(tmpdir(), "automobile-prototype-"));
  }
  cp(source: string, destination: string): Promise<void> {
    return cp(source, destination, { recursive: true });
  }
  writeFile(path: string, data: string | Buffer): Promise<void> {
    return writeFile(path, data);
  }
  async mkdir(path: string): Promise<void> {
    await mkdir(path, { recursive: true });
  }
  rm(path: string): Promise<void> {
    return rm(path, { recursive: true, force: true });
  }
}
