import { errorMessage } from "../describeUnknownError";
import { promises as fsPromises } from "node:fs";
import os from "node:os";
import { logger } from "../logger";

/**
 * Shared owner-only filesystem permission helpers.
 *
 * AutoMobile writes sensitive material to `~/.auto-mobile` — Unix control
 * sockets and screen recordings that routinely contain OTPs, credentials, and
 * PII. Left at the default umask (`0o755` dirs / `0o644` files) these are
 * world-readable and, for sockets on macOS, potentially `connect()`-able by any
 * local user (issue #4750). These helpers centralize the `0o700`/`0o600`
 * convention already used ad hoc across the repo (`tempDir.ts`,
 * `DefaultFileSystem.ts`, `daemon.ts`, `ScreenCaptureHelperProvider.ts`) so the
 * capture paths get the same restrictive modes.
 *
 * Cross-platform: Windows has no POSIX mode bits — `fs.chmod` there only toggles
 * the read-only attribute — so the chmod syscalls are skipped on `win32` to
 * avoid clobbering writability. Access control on Windows is handled by ACLs,
 * outside the scope of these bits.
 */

/** Owner-only directory permissions (`rwx------`). */
export const SECURE_DIR_MODE = 0o700;

/** Owner-only file permissions (`rw-------`). */
export const SECURE_FILE_MODE = 0o600;

const isWindows = (): boolean => os.platform() === "win32";

/**
 * Seam over the owner-only permission operations, so callers can inject a spy in
 * tests and assert the intended modes deterministically on any host OS.
 */
export interface SecurePermissions {
  /** Create `dirPath` (recursively) with owner-only (`0o700`) permissions. */
  ensureSecureDir(dirPath: string): Promise<void>;
  /** Restrict an existing file to owner-only (`0o600`) permissions. */
  secureFile(filePath: string): Promise<void>;
}

/**
 * Create a directory tree with owner-only permissions.
 *
 * `mkdir`'s `mode` is masked by the process umask and is ignored entirely for a
 * pre-existing directory, so on POSIX an explicit `chmod` follows to guarantee
 * `0o700` regardless of umask or prior state. Best-effort: a chmod failure is
 * logged but never aborts the caller's primary operation.
 */
export async function ensureSecureDir(dirPath: string): Promise<void> {
  await fsPromises.mkdir(dirPath, { recursive: true, mode: SECURE_DIR_MODE });
  if (isWindows()) {
    return;
  }
  try {
    await fsPromises.chmod(dirPath, SECURE_DIR_MODE);
  } catch (error) {
    // A directory we just created should always be chmod-able; if it is not
    // (e.g. a race with removal), the looser mode is a hardening gap, not a
    // functional failure — log and continue.
    logger.warn(`Failed to set 0o700 on directory ${dirPath}: ${normalize(error)}`, error);
  }
}

/**
 * Restrict an existing file to owner-only permissions.
 *
 * Best-effort: a finalized recording or a bound socket is already on disk, and a
 * chmod failure (missing file, unusual filesystem) must not fail the surrounding
 * capture/serve flow — it is logged so the hardening gap is traceable.
 */
export async function secureFile(filePath: string): Promise<void> {
  if (isWindows()) {
    return;
  }
  try {
    await fsPromises.chmod(filePath, SECURE_FILE_MODE);
  } catch (error) {
    logger.warn(`Failed to set 0o600 on file ${filePath}: ${normalize(error)}`, error);
  }
}

const normalize = (error: unknown): string =>
  errorMessage(error);

/** Default implementation backed by the real filesystem. */
export const defaultSecurePermissions: SecurePermissions = {
  ensureSecureDir,
  secureFile,
};
