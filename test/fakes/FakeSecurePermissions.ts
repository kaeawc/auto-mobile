import { promises as fsPromises } from "node:fs";
import type { SecurePermissions } from "../../src/utils/filesystem/securePermissions";

/**
 * Spy implementation of {@link SecurePermissions} for deterministic assertions on
 * any host OS (including windows-latest, where real POSIX mode bits are absent).
 *
 * By default it still creates directories on disk (so callers that immediately
 * write into them keep working) but records every call so tests can assert that
 * the owner-only hardening was requested for the right paths.
 */
export class FakeSecurePermissions implements SecurePermissions {
  readonly ensureSecureDirCalls: string[] = [];
  readonly secureFileCalls: string[] = [];

  constructor(private readonly createDirsOnDisk: boolean = true) {}

  async ensureSecureDir(dirPath: string): Promise<void> {
    this.ensureSecureDirCalls.push(dirPath);
    if (this.createDirsOnDisk) {
      await fsPromises.mkdir(dirPath, { recursive: true });
    }
  }

  async secureFile(filePath: string): Promise<void> {
    this.secureFileCalls.push(filePath);
  }
}
