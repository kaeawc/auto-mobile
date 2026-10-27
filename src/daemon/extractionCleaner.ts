import { rm } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { isPathInside } from "../utils/filesystem/pathContainment";

export interface ExtractionCleaner {
  removeExtractionForEntryScript(entryScript: string): Promise<boolean>;
}

/** Exported for tests. */
export function resolveExtractionRootForEntryScript(entryScript: string): string | null {
  const resolved = resolve(entryScript);
  const parts = resolved.split(sep);
  const nodeModulesIndex = parts.lastIndexOf("node_modules");
  if (nodeModulesIndex <= 0) {
    return null;
  }

  const packagePath = parts.slice(nodeModulesIndex + 1, nodeModulesIndex + 3).join("/");
  if (packagePath !== "@kaeawc/auto-mobile") {
    return null;
  }

  const root = parts.slice(0, nodeModulesIndex).join(sep) || sep;
  if (root === sep) {
    return null;
  }

  const tempRoot = resolve(tmpdir());
  if (!isPathInside(tempRoot, root, { allowEqual: false })) {
    return null;
  }
  return root;
}

export const fileSystemExtractionCleaner: ExtractionCleaner = {
  async removeExtractionForEntryScript(entryScript: string): Promise<boolean> {
    const extractionRoot = resolveExtractionRootForEntryScript(entryScript);
    if (!extractionRoot) {
      return false;
    }

    await rm(extractionRoot, { recursive: true, force: true });
    return true;
  },
};
