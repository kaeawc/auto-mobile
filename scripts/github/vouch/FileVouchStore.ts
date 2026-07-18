/**
 * A file-backed store for the vouch trust graph, for the GitHub-Action path where
 * the graph lives as a committed JSON file in the repo rather than in SQLite.
 *
 * Reads tolerate a missing file (fresh graph); writes are pretty-printed and
 * diff-friendly so the committed graph is reviewable in git history.
 */

import { promises as fs } from "fs";
import * as path from "path";
import { parseVouchState, stringifyVouchState } from "./VouchSnapshot";
import { emptyVouchState, type VouchState } from "./types";

/** A load/save seam over the trust graph, backed by a file or anything else. */
export interface VouchStateStore {
  load(): Promise<VouchState>;
  save(state: VouchState): Promise<void>;
}

export class FileVouchStore implements VouchStateStore {
  constructor(private readonly filePath: string) {}

  /** Load the graph, returning an empty graph if the file does not yet exist. */
  async load(): Promise<VouchState> {
    let contents: string;
    try {
      contents = await fs.readFile(this.filePath, "utf8");
    } catch (error) {
      // A missing graph file is the expected cold-start case: start empty.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return emptyVouchState();
      }
      throw error;
    }
    return parseVouchState(contents);
  }

  /** Persist the graph, creating the parent directory if needed. */
  async save(state: VouchState): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, stringifyVouchState(state), "utf8");
  }
}
