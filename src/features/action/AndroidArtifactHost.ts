import AdmZip from "adm-zip";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { sortedReaddirEntries } from "../../utils/io";

/**
 * Host filesystem steps the Android bundle and split-APK install routes need: telling a split
 * directory from a file, listing its APKs, a private scratch directory (built APK sets, the
 * extracted base split, keystore password files) and pulling the base split out of an APK set.
 */
export interface AndroidArtifactHost {
  isDirectory(target: string): Promise<boolean>;
  /** Absolute paths of the `.apk` files directly inside `directory`, sorted by name. */
  listApks(directory: string): Promise<string[]>;
  /** A new private (0700) scratch directory. */
  createScratchDir(): Promise<string>;
  /** Write a secret readable only by this user (0600), with no trailing newline. */
  writeSecretFile(target: string, content: string): Promise<void>;
  /**
   * Copy the base split (`splits/base-master.apk`, else `universal.apk` or the first
   * standalone APK) out of an APK set to `destination`. False when the set has none.
   */
  extractBaseApk(apkSet: string, destination: string): Promise<boolean>;
  removeDir(target: string): Promise<void>;
}

const BASE_SPLIT_ENTRY = /^splits\/base-master(?:_\d+)?\.apk$/;
const STANDALONE_ENTRY = /^standalones\/[^/]+\.apk$/;

/** Pick the APK set entry aapt should read the package name from. */
export function baseApkEntryName(entryNames: readonly string[]): string | undefined {
  const sorted = [...entryNames].sort();
  return (
    sorted.find((name) => BASE_SPLIT_ENTRY.test(name)) ??
    sorted.find((name) => name === "universal.apk") ??
    sorted.find((name) => STANDALONE_ENTRY.test(name))
  );
}

export class DefaultAndroidArtifactHost implements AndroidArtifactHost {
  async isDirectory(target: string): Promise<boolean> {
    try {
      return (await stat(target)).isDirectory();
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        // A missing path is simply not a split directory; the caller rejects its extension.
        return false;
      }
      throw error;
    }
  }

  async listApks(directory: string): Promise<string[]> {
    const entries = await sortedReaddirEntries(directory);
    return entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".apk"))
      .map((entry) => path.join(directory, entry.name));
  }

  async createScratchDir(): Promise<string> {
    return mkdtemp(path.join(tmpdir(), "automobile-android-install-"));
  }

  async writeSecretFile(target: string, content: string): Promise<void> {
    await writeFile(target, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
  }

  async extractBaseApk(apkSet: string, destination: string): Promise<boolean> {
    const zip = new AdmZip(apkSet);
    const entryName = baseApkEntryName(zip.getEntries().map((entry) => entry.entryName));
    const bytes = entryName === undefined ? null : zip.readFile(entryName);
    if (!bytes) {
      return false;
    }
    // Only the selected entry's bytes are written, to a path this process chose.
    await writeFile(destination, bytes, { flag: "wx" });
    return true;
  }

  async removeDir(target: string): Promise<void> {
    await rm(target, { recursive: true, force: true });
  }
}
