import type { AndroidArtifactHost } from "../../src/features/action/AndroidArtifactHost";

/** In-memory {@link AndroidArtifactHost}: directories, APK sets and scratch files are maps. */
export class FakeAndroidArtifactHost implements AndroidArtifactHost {
  /** Directory path -> the APK paths `listApks` returns for it. */
  readonly directories = new Map<string, string[]>();
  /** APK set path -> whether it holds a base split. */
  readonly apkSets = new Map<string, boolean>();
  /** Secret files written, by path. */
  readonly secretFiles = new Map<string, string>();
  readonly extracted: Array<{ apkSet: string; destination: string }> = [];
  readonly createdScratchDirs: string[] = [];
  readonly removedDirs: string[] = [];
  private scratchCount = 0;

  async isDirectory(target: string): Promise<boolean> {
    return this.directories.has(target);
  }

  async listApks(directory: string): Promise<string[]> {
    return [...(this.directories.get(directory) ?? [])];
  }

  async createScratchDir(): Promise<string> {
    const dir = `/scratch/install-${++this.scratchCount}`;
    this.createdScratchDirs.push(dir);
    return dir;
  }

  async writeSecretFile(target: string, content: string): Promise<void> {
    this.secretFiles.set(target, content);
  }

  async extractBaseApk(apkSet: string, destination: string): Promise<boolean> {
    this.extracted.push({ apkSet, destination });
    return this.apkSets.get(apkSet) ?? true;
  }

  async removeDir(target: string): Promise<void> {
    this.removedDirs.push(target);
  }
}
