import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseStringPromise } from "xml2js";
import type { ViewHierarchyResult } from "../../src/models";

/** Same xml2js attribute/child representation used by AndroidHierarchyFallback. */
export async function capturedLauncherHierarchy(file: string): Promise<ViewHierarchyResult> {
  return await parseStringPromise(
    readFileSync(join(import.meta.dir, "../fixtures", file), "utf8"),
    {
      explicitArray: true,
    },
  );
}
