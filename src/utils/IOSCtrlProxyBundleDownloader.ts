import * as fs from "fs/promises";
import * as path from "path";
import AdmZip from "adm-zip";
import { type FileDownloader, DefaultFileDownloader } from "./FileDownloader";
import { type ChecksumCalculator, type Sha256Source, DefaultChecksumCalculator } from "./ChecksumCalculator";
import { ensureSecureDir } from "./filesystem/securePermissions";
import { ActionableError } from "../models/ActionableError";

export type { Sha256Source };

/**
 * Defensive zip-slip containment check (issue #4761). adm-zip >= 0.5.10 already
 * sanitizes entry names in `extractAllTo` (`canonical` + `sanitize`), but this
 * bundle only reaches extraction on the unverified fallback/override paths, so a
 * malicious archive is worth a second, explicit gate: reject any entry that
 * resolves outside the destination BEFORE writing a single file. Belt-and-braces
 * on top of the library guard, independent of the installed adm-zip version.
 */
export function assertZipEntriesContained(zip: AdmZip, destination: string): void {
  const resolvedRoot = path.resolve(destination);
  for (const entry of zip.getEntries()) {
    const target = path.resolve(resolvedRoot, entry.entryName);
    const relative = path.relative(resolvedRoot, target);
    const escapes = relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative);
    if (escapes) {
      throw new ActionableError(
        `Refusing to extract CtrlProxy bundle: entry "${entry.entryName}" resolves outside the ` +
        `extraction directory ${resolvedRoot} (zip-slip / path traversal).`
      );
    }
  }
}

export interface CtrlProxyIosBundleDownloader {
  download(url: string, destination: string): Promise<void>;
  computeFileSha256(filePath: string): Promise<{ checksum: string; source: Sha256Source }>;
  extractBundle(bundlePath: string, destination: string): Promise<void>;
}

export class DefaultIOSCtrlProxyBundleDownloader implements CtrlProxyIosBundleDownloader {
  private readonly fileDownloader: FileDownloader;
  private readonly checksumCalculator: ChecksumCalculator;

  constructor(
    fileDownloader: FileDownloader = new DefaultFileDownloader(),
    checksumCalculator: ChecksumCalculator = new DefaultChecksumCalculator()
  ) {
    this.fileDownloader = fileDownloader;
    this.checksumCalculator = checksumCalculator;
  }

  public async download(url: string, destination: string): Promise<void> {
    return this.fileDownloader.download(url, destination);
  }

  public async computeFileSha256(filePath: string): Promise<{ checksum: string; source: Sha256Source }> {
    return this.checksumCalculator.computeFileSha256(filePath);
  }

  public async extractBundle(bundlePath: string, destination: string): Promise<void> {
    await fs.rm(destination, { recursive: true, force: true });
    // Owner-only (0o700) instead of the umask default: the extracted runner is
    // launched from here, so other uids must not be able to swap its binaries
    // between verification and launch (TOCTOU, issue #4759).
    await ensureSecureDir(destination);

    const zip = new AdmZip(bundlePath);
    assertZipEntriesContained(zip, destination);
    zip.extractAllTo(destination, true);
  }
}
