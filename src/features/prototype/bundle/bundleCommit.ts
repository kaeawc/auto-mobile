import { dirname, join, resolve } from "node:path";
import { logger } from "../../../utils/logger";
import { errorMessage } from "../../../utils/describeUnknownError";
import type { PrototypeBundle } from "./bundleContract";
import { canonicalBundleFiles } from "./bundleExport";

/** The adapter MUST use exclusive O_NOFOLLOW file creation and lstat/open directory checks.
 * Parent is app-owned and callers serialize commits there; destination must be a fresh library ID.
 */
export interface BundleCommitFileSystem {
  assertRealDirectory(path: string): Promise<void>;
  assertAbsent(path: string): Promise<void>;
  makeStagingDirectory(parent: string, mode: number): Promise<string>;
  mkdir(path: string, mode: number): Promise<void>;
  writeExclusiveNoFollow(path: string, bytes: Uint8Array): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
}
export type BundleCommitResult =
  | { ok: true; destination: string }
  | { ok: false; code: "storage_failure"; message: string };
/** Stage a validated bundle, then publish by one same-volume rename. Never replaces an existing ID. */
export async function commitBundleToDirectory(
  bundle: PrototypeBundle,
  destDir: string,
  fs: BundleCommitFileSystem,
): Promise<BundleCommitResult> {
  let stage: string | undefined;
  try {
    const destination = resolve(destDir);
    const parent = dirname(destination);
    await fs.assertRealDirectory(parent);
    await fs.assertAbsent(destination);
    // Revalidate public mutable maps/spec before allowing any data to reach disk.
    const files = canonicalBundleFiles(
      {
        specBytes: bundle.spec,
        assets: (id) => bundle.assets.get(id),
        fonts: (id) => bundle.fonts.get(id),
      },
      bundle.requires,
    );
    const fresh = await fs.makeStagingDirectory(parent, 0o700);
    if (dirname(fresh) !== parent || fresh === destination) {
      throw new Error("Staging directory must be a fresh sibling of destination");
    }
    stage = fresh;
    await fs.assertRealDirectory(stage);
    for (const directory of ["assets", "fonts"]) {
      const path = join(stage, directory);
      await fs.mkdir(path, 0o700);
      await fs.assertRealDirectory(path);
    }
    for (const [path, bytes] of files) {
      await fs.writeExclusiveNoFollow(join(stage, path), bytes);
    }
    await fs.assertRealDirectory(parent);
    await fs.assertRealDirectory(stage);
    await fs.assertAbsent(destination);
    await fs.rename(stage, destination);
    return { ok: true, destination };
  } catch (error) {
    logger.warn("Failed to commit prototype bundle", error);
    if (stage) {
      await cleanStage(fs, stage);
    }
    return { ok: false, code: "storage_failure", message: errorMessage(error) };
  }
}
async function cleanStage(fs: BundleCommitFileSystem, stage: string): Promise<void> {
  try {
    await fs.remove(stage);
  } catch (error) {
    logger.warn("Failed to remove prototype bundle staging directory", error);
  }
}
