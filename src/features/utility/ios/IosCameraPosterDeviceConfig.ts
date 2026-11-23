import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultIdGenerator, type IdGenerator } from "../../../utils/IdGenerator";
import { getTempDir } from "../../../utils/tempDir";
import type { IosCameraPoster } from "./IosCameraPosterRegistry";

/** The synchronous file operations the config mirror needs; registry calls are synchronous. */
export interface PosterConfigFileSystem {
  mkdirSync(path: string, options: { recursive: true; mode: number }): unknown;
  writeFileSync(path: string, data: string): void;
  renameSync(from: string, to: string): void;
  rmSync(path: string, options: { force: true; recursive?: boolean }): void;
}

const nodeFileSystem: PosterConfigFileSystem = { mkdirSync, writeFileSync, renameSync, rmSync };

/**
 * The per-simulator JSON file a device-wide poster boot environment names in
 * `AM_CAMERA_POSTER_CONFIG` (#19047). The poster library reads it when each app process starts, so
 * writing it changes the poster for the next launch of any app and removing it turns the camera
 * back off, with no reboot.
 */
export class IosCameraPosterDeviceConfig {
  constructor(
    private readonly directory: () => string = () => getTempDir("ios-camera-poster/devices"),
    private readonly fs: PosterConfigFileSystem = nodeFileSystem,
    private readonly ids: IdGenerator = defaultIdGenerator,
  ) {}

  path(udid: string): string {
    return join(this.directory(), `${udid}.json`);
  }

  /** Atomic: an app starting mid-write reads the old file or the new one, never a partial. */
  write(udid: string, poster: IosCameraPoster): void {
    const target = this.path(udid);
    const partial = `${target}.${this.ids.next()}.tmp`;
    this.fs.mkdirSync(this.directory(), { recursive: true, mode: 0o700 });
    // A QR record injects its payload (the library renders the code with a quiet zone).
    this.fs.writeFileSync(
      partial,
      JSON.stringify(poster.kind === "qr" ? { qr: poster.text } : { path: poster.path }),
    );
    this.fs.renameSync(partial, target);
  }

  remove(udid: string): void {
    this.fs.rmSync(this.path(udid), { force: true });
  }

  /** Drop files a previous daemon left: its registry, and so its posters, did not survive. */
  removeAll(): void {
    this.fs.rmSync(this.directory(), { force: true, recursive: true });
  }
}

export const iosCameraPosterDeviceConfig = new IosCameraPosterDeviceConfig();
