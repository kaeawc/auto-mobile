/**
 * Where profiling tools put binary artifacts (`.hprof`, `.memgraph`). Injectable
 * so tests never touch the host file system.
 */
export interface ProfilingArtifactStore {
  /** A fresh host path for `kind`'s artifact, with its directory already created. */
  allocatePath(kind: "heapDump", id: string, extension: string): Promise<string>;
  /** Size of the file at `path` in bytes; 0 when it does not exist. */
  sizeOf(path: string): Promise<number>;
  /** Delete a partial or unwanted artifact; absence is not an error. */
  remove(path: string): Promise<void>;
}
