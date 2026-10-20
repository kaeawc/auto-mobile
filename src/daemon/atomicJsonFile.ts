import { closeSync, openSync, renameSync, unlinkSync, writeFileSync } from "node:fs";

export interface AtomicPidFileWriteSyncDependencies {
  createTemporaryPath: (pidFilePath: string) => string;
  writeTemporaryFile: (temporaryPath: string, contents: string) => void;
  replaceFile: (temporaryPath: string, pidFilePath: string) => void;
  removeTemporaryFile: (temporaryPath: string) => void;
}

let pidFileTemporaryPathSequence = 0;

export function createPidFileTemporaryPath(pidFilePath: string): string {
  pidFileTemporaryPathSequence += 1;
  return `${pidFilePath}.${process.pid}.${pidFileTemporaryPathSequence}.tmp`;
}

export const defaultAtomicPidFileWriteSyncDependencies: AtomicPidFileWriteSyncDependencies = {
  createTemporaryPath: createPidFileTemporaryPath,
  writeTemporaryFile: (temporaryPath, contents) => {
    writeFileSync(temporaryPath, contents, { encoding: "utf-8", mode: 0o600 });
  },
  replaceFile: renameSync,
  removeTemporaryFile: unlinkSync,
};

/** Publish a JSON sidecar using the same owner-only atomic writer as PID records. */
export function writeJsonFileAtomicSync(
  pidFilePath: string,
  data: unknown,
  dependencies: AtomicPidFileWriteSyncDependencies = defaultAtomicPidFileWriteSyncDependencies,
): void {
  writeSerializedJsonFileAtomicSync(pidFilePath, () => JSON.stringify(data, null, 2), dependencies);
}

function writeSerializedJsonFileAtomicSync(
  pidFilePath: string,
  contents: () => string,
  dependencies: AtomicPidFileWriteSyncDependencies,
): void {
  const temporaryPath = dependencies.createTemporaryPath(pidFilePath);
  try {
    dependencies.writeTemporaryFile(temporaryPath, contents());
    dependencies.replaceFile(temporaryPath, pidFilePath);
  } catch (writeError) {
    try {
      dependencies.removeTemporaryFile(temporaryPath);
    } catch (cleanupError) {
      if (
        typeof cleanupError !== "object" ||
        cleanupError === null ||
        !("code" in cleanupError) ||
        cleanupError.code !== "ENOENT"
      ) {
        throw new AggregateError(
          [writeError, cleanupError],
          `Failed to publish JSON file ${pidFilePath} and remove its temporary file`,
        );
      }
    }
    throw writeError;
  }
}

/** Exclusive creation prevents planted temporary symlinks or loose-mode files being reused. */
export function writePrivateJsonFileAtomicSync(
  filePath: string,
  data: unknown,
  createTemporaryPath = createPidFileTemporaryPath,
): void {
  const contents = JSON.stringify(data, null, 2);
  const temporaryPath = createTemporaryPath(filePath);
  // Open before the cleanup scope: an EEXIST path belongs to someone else.
  const descriptor = openSync(temporaryPath, "wx", 0o600);
  writeSerializedJsonFileAtomicSync(filePath, () => contents, {
    createTemporaryPath: () => temporaryPath,
    writeTemporaryFile: (_path, contents) => {
      try {
        writeFileSync(descriptor, contents, "utf8");
      } finally {
        closeSync(descriptor);
      }
    },
    replaceFile: renameSync,
    removeTemporaryFile: unlinkSync,
  });
}
