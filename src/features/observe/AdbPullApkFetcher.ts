import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import type { ApkByteSource } from "../../utils/android-cmdline-tools/apkSigningBlock";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { shellQuote } from "../../utils/shellQuote";

const APK_PULL_TIMEOUT_MS = 120_000;

/** Gives access to the bytes of one on-device APK. */
export interface ApkFetcher {
  open(
    adb: AdbExecutor,
    remotePath: string,
    signal?: AbortSignal,
  ): Promise<{ source: ApkByteSource; dispose(): Promise<void> }>;
}

/** Pulls the APK to a temp file with `adb pull` and reads it with random access. */
export class AdbPullApkFetcher implements ApkFetcher {
  async open(adb: AdbExecutor, remotePath: string, signal?: AbortSignal) {
    const workDir = await fs.mkdtemp(join(tmpdir(), "automobile-signing-"));
    const localPath = join(workDir, "base.apk");
    const dispose = async () => {
      await fs.rm(workDir, { recursive: true, force: true });
    };
    try {
      await adb.executeCommand(`pull ${shellQuote(remotePath)} ${shellQuote(localPath)}`, {
        timeoutMs: APK_PULL_TIMEOUT_MS,
        noRetry: true,
        signal,
      });
      const handle = await fs.open(localPath, "r");
      let size: number;
      try {
        size = (await handle.stat()).size;
      } catch (error) {
        // The caller only ever gets `dispose` on success: close the handle here (#11058).
        await handle.close().catch((closeError: unknown) => {
          logger.warn(`Failed to close pulled APK ${localPath}: ${errorMessage(closeError)}`);
        });
        throw error;
      }
      return {
        source: {
          size,
          read: async (offset: number, length: number) => {
            const buffer = Buffer.alloc(length);
            const { bytesRead } = await handle.read(buffer, 0, length, offset);
            return buffer.subarray(0, bytesRead);
          },
        },
        dispose: async () => {
          await handle.close();
          await dispose();
        },
      };
    } catch (error) {
      await dispose();
      throw error;
    }
  }
}
