import { createHash } from "crypto";
import { promises as fs } from "fs";
import { join, relative } from "path";
import { sortedReaddir } from "../io";

interface AppBundleHasherDependencies {
  readDir: (path: string) => Promise<string[]>;
  stat: (path: string) => Promise<{ isDirectory: () => boolean; isFile: () => boolean }>;
  lstat: (path: string) => Promise<{
    isDirectory: () => boolean;
    isFile: () => boolean;
    isSymbolicLink: () => boolean;
  }>;
  readLink: (path: string) => Promise<string>;
  readFile: (path: string) => Promise<Buffer>;
}

const defaultDependencies: AppBundleHasherDependencies = {
  readDir: async (path) => sortedReaddir(path),
  stat: async (path) => fs.stat(path),
  lstat: async (path) => fs.lstat(path),
  readLink: async (path) => fs.readlink(path),
  readFile: async (path) => fs.readFile(path),
};

const skipPathSegment = (segment: string): boolean =>
  segment === "_CodeSignature" || segment === "SC_Info";

const skipFileName = (name: string): boolean =>
  name === "embedded.mobileprovision" || name === "PkgInfo" || name.endsWith(".xcent");

const shouldSkipPath = (relativePath: string): boolean => {
  const segments = relativePath.split("/").filter(Boolean);
  if (segments.some((segment) => skipPathSegment(segment))) {
    return true;
  }
  const fileName = segments[segments.length - 1] ?? "";
  return skipFileName(fileName);
};

interface AppBundleHasherOptions {
  includeSigningMetadata?: boolean;
  lengthPrefixed?: boolean;
  /** Seal entry types and link targets without following symlinks; implies length framing. */
  sealLinks?: boolean;
}

interface BundleEntry {
  relativePath: string;
  type: "file" | "directory" | "symlink" | "other";
}

const collectPaths = async (
  root: string,
  current: string,
  deps: AppBundleHasherDependencies,
  output: BundleEntry[],
  options: AppBundleHasherOptions,
): Promise<void> => {
  const entries = await deps.readDir(current);
  entries.sort();
  for (const entry of entries) {
    const fullPath = join(current, entry);
    const linkStats = options.sealLinks ? await deps.lstat(fullPath) : undefined;
    const stats = linkStats ?? (await deps.stat(fullPath));
    const relPath = relative(root, fullPath).replace(/\\/g, "/");
    if (!options.includeSigningMetadata && shouldSkipPath(relPath)) {
      continue;
    }
    let type: BundleEntry["type"] = "other";
    if (linkStats?.isSymbolicLink()) {
      type = "symlink";
    } else if (stats.isDirectory()) {
      type = "directory";
      await collectPaths(root, fullPath, deps, output, options);
    } else if (stats.isFile()) {
      type = "file";
    }
    if (options.sealLinks || type === "file") {
      output.push({ relativePath: relPath, type });
    }
  }
};

export const hashAppBundle = async (
  bundlePath: string,
  deps: AppBundleHasherDependencies = defaultDependencies,
  options: AppBundleHasherOptions = {},
): Promise<string> => {
  if (options.sealLinks) {
    const root = await deps.lstat(bundlePath);
    if (!root.isDirectory()) {
      throw new Error("Sealed app bundle root must be a real directory");
    }
  }
  const hash = createHash("sha256");
  const entries: BundleEntry[] = [];
  await collectPaths(bundlePath, bundlePath, deps, entries, options);
  entries.sort((a, b) =>
    a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0,
  );
  for (const { relativePath, type } of entries) {
    const fullPath = join(bundlePath, relativePath);
    const fields: Buffer[] = options.sealLinks ? [Buffer.from(type, "utf8")] : [];
    fields.push(Buffer.from(relativePath, "utf8"));
    if (type === "file") {
      fields.push(await deps.readFile(fullPath));
    } else if (type === "symlink") {
      fields.push(Buffer.from(await deps.readLink(fullPath), "utf8"));
    }
    // Preserve the legacy digest for persisted app-content/compatibility hashes.
    // Security cache keys opt into unambiguous byte-length framing instead.
    for (const bytes of fields) {
      if (options.lengthPrefixed || options.sealLinks) {
        const length = Buffer.alloc(8);
        length.writeBigUInt64BE(BigInt(bytes.length));
        hash.update(length);
        hash.update(bytes);
      } else {
        hash.update(bytes);
        hash.update("\0");
      }
    }
  }
  return hash.digest("hex");
};
