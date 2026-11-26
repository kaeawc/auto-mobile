import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { defaultIdGenerator, type IdGenerator } from "../../../utils/IdGenerator";
import { getTempDir } from "../../../utils/tempDir";
import { logger } from "../../../utils/logger";
import { errorMessage } from "../../../utils/describeUnknownError";

/** What a device-wide activation changed in one simulator's launchd environment (#19047). */
export interface IosCameraPosterActivation {
  /** The gate library path inserted into `DYLD_INSERT_LIBRARIES`. */
  gate: string;
}

/**
 * Records which simulators have the device-wide poster turned on, so every clear path and the
 * next daemon start can undo it, and keeps the gate library at a path no cache cleanup removes.
 */
export interface IosCameraPosterActivationStore {
  read(udid: string): IosCameraPosterActivation | undefined;
  write(udid: string, activation: IosCameraPosterActivation): void;
  remove(udid: string): void;
  list(): string[];
  /** Copies a built gate to the stable path launchd names and returns that path. */
  installGate(built: string): string;
}

export interface ActivationFileSystem {
  mkdirSync(path: string, options: { recursive: true; mode: number }): unknown;
  readFileSync(path: string, encoding: "utf8"): string;
  writeFileSync(path: string, data: string): void;
  renameSync(from: string, to: string): void;
  rmSync(path: string, options: { force: true }): void;
  readdirSync(path: string): string[];
  copyFileSync(from: string, to: string): void;
  existsSync(path: string): boolean;
}

const nodeFileSystem: ActivationFileSystem = {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  rmSync,
  readdirSync,
  copyFileSync,
  existsSync,
};

export const IOS_CAMERA_POSTER_GATE_FILE = "libAMCameraPosterGate.dylib";
const RECORD_SUFFIX = ".json";

function isActivation(value: unknown): value is IosCameraPosterActivation {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.gate === "string";
}

/**
 * Lives beside, not inside, the `ios-camera-poster` build cache: the gate a running simulator's
 * launchd names must never disappear with a cache entry, or every new process there fails to load.
 */
export class FileIosCameraPosterActivationStore implements IosCameraPosterActivationStore {
  constructor(
    private readonly directory: () => string = () => getTempDir("ios-camera-poster-active"),
    private readonly fs: ActivationFileSystem = nodeFileSystem,
    private readonly ids: IdGenerator = defaultIdGenerator,
  ) {}

  read(udid: string): IosCameraPosterActivation | undefined {
    const path = this.recordPath(udid);
    if (!this.fs.existsSync(path)) {
      return undefined;
    }
    try {
      const parsed: unknown = JSON.parse(this.fs.readFileSync(path, "utf8"));
      if (isActivation(parsed)) {
        return { gate: parsed.gate };
      }
      logger.warn(`Dropping a malformed camera poster activation record for ${udid}`);
    } catch (error) {
      logger.warn(
        `Dropping an unreadable camera poster activation record for ${udid}: ${errorMessage(error)}`,
        error,
      );
    }
    // A record that cannot be read describes no activation; keeping it would fail every read.
    this.remove(udid);
    return undefined;
  }

  write(udid: string, activation: IosCameraPosterActivation): void {
    this.atomicWrite(this.recordPath(udid), (partial) =>
      this.fs.writeFileSync(partial, JSON.stringify(activation)),
    );
  }

  remove(udid: string): void {
    this.fs.rmSync(this.recordPath(udid), { force: true });
  }

  list(): string[] {
    const directory = this.devicesDirectory();
    if (!this.fs.existsSync(directory)) {
      return [];
    }
    return this.fs
      .readdirSync(directory)
      .filter((name) => name.endsWith(RECORD_SUFFIX))
      .map((name) => basename(name, RECORD_SUFFIX));
  }

  installGate(built: string): string {
    const target = join(this.directory(), IOS_CAMERA_POSTER_GATE_FILE);
    // Atomic: a process starting mid-copy maps the old file or the new one, never a partial.
    this.atomicWrite(target, (partial) => this.fs.copyFileSync(built, partial));
    return target;
  }

  private atomicWrite(target: string, writePartial: (partial: string) => void): void {
    const partial = `${target}.${this.ids.next()}.tmp`;
    this.fs.mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writePartial(partial);
    this.fs.renameSync(partial, target);
  }

  private devicesDirectory(): string {
    return join(this.directory(), "devices");
  }

  private recordPath(udid: string): string {
    return join(this.devicesDirectory(), `${udid}${RECORD_SUFFIX}`);
  }
}

export const iosCameraPosterActivationStore: IosCameraPosterActivationStore =
  new FileIosCameraPosterActivationStore();
