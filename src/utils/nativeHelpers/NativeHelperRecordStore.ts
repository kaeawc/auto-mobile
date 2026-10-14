import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sortedReaddirSync } from "../io";
import { getTempDir } from "../tempDir";
import { logger, type Logger } from "../logger";
import { errorMessage } from "../describeUnknownError";

export interface NativeHelperRecord {
  version: 1;
  kind: "iproxy" | "ios-capture-helper" | "adb";
  pid: number;
  startIdentity: string;
  processGroup: boolean;
  ownerPid: number;
  ownerStartIdentity: string;
  recordedAtMs: number;
}

export interface NativeHelperRecordStore {
  write(record: NativeHelperRecord): void;
  remove(pid: number): void;
  list(): NativeHelperRecord[];
}

let writeSequence = 0;

/** Corrupt records are warned about and left untouched: no age guess can authorize a kill. */
export class FileNativeHelperRecordStore implements NativeHelperRecordStore {
  corruptRecordsSkipped = 0;
  constructor(private readonly log: Logger = logger) {}

  private directory(): string {
    const directory = getTempDir("native-helpers");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    return directory;
  }

  write(record: NativeHelperRecord): void {
    const path = join(this.directory(), `${record.pid}.json`);
    // A process-local sequence plus the writer pid is sufficient for synchronous atomic writes.
    const temporaryPath = `${path}.${process.pid}.${++writeSequence}.tmp`;
    try {
      writeFileSync(temporaryPath, JSON.stringify(record), { mode: 0o600, flag: "wx" });
      renameSync(temporaryPath, path);
    } finally {
      this.removeFile(temporaryPath);
    }
  }

  remove(pid: number): void {
    this.removeFile(join(this.directory(), `${pid}.json`));
  }

  list(): NativeHelperRecord[] {
    const directory = this.directory();
    this.corruptRecordsSkipped = 0;
    const records: NativeHelperRecord[] = [];
    for (const file of sortedReaddirSync(directory)) {
      if (!file.endsWith(".json")) {
        continue;
      }
      try {
        const record: unknown = JSON.parse(readFileSync(join(directory, file), "utf8"));
        if (!isNativeHelperRecord(record) || file !== `${record.pid}.json`) {
          this.corruptRecordsSkipped++;
          this.log.warn(`[NATIVE_HELPERS] Skipping corrupt record ${file}`);
          continue;
        }
        records.push(record);
      } catch (error) {
        if (isMissingFile(error)) {
          // An exiting child or another sweep may remove a record during listing.
          this.log.debug(`[NATIVE_HELPERS] Record ${file} disappeared during listing`);
        } else {
          this.corruptRecordsSkipped++;
          this.log.warn(
            `[NATIVE_HELPERS] Skipping unreadable record ${file}: ${errorMessage(error)}`,
            error,
          );
        }
      }
    }
    return records;
  }

  private removeFile(path: string): void {
    try {
      unlinkSync(path);
    } catch (error) {
      if (!isMissingFile(error)) {
        throw error;
      }
      // Atomic rename and concurrent child-exit cleanup commonly leave no file to unlink.
      this.log.debug(`[NATIVE_HELPERS] File already absent: ${path}`);
    }
  }
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export function isNativeHelperRecord(value: unknown): value is NativeHelperRecord {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record.version === 1 &&
    typeof record.kind === "string" &&
    ["iproxy", "ios-capture-helper", "adb"].includes(record.kind) &&
    [record.pid, record.ownerPid].every(isRecordPid) &&
    [record.startIdentity, record.ownerStartIdentity].every(isRecordIdentity) &&
    typeof record.processGroup === "boolean" &&
    typeof record.recordedAtMs === "number" &&
    Number.isFinite(record.recordedAtMs)
  );
}

function isRecordPid(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 1;
}

function isRecordIdentity(value: unknown): boolean {
  return typeof value === "string" && value.length > 0;
}
