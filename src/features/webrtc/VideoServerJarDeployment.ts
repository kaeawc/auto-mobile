import { ActionableError } from "../../models";
import type { VideoSourceAdb } from "./videoSourceAdb";
import { logger } from "../../utils/logger";
import { shellQuote } from "../../utils/shellQuote";
import type { PersistentEncoderH264SourceOptions } from "./PersistentEncoderH264Source";
import {
  VideoServerJarProvider,
  type JarIntegrityProbe,
  type VideoServerJarIntegrity,
} from "./VideoServerJarProvider";

/** Remote path the DEX jar is pushed to before launch. */
export const VIDEO_SERVER_REMOTE_JAR_PATH = "/data/local/tmp/automobile-video.jar";

/**
 * Parse the on-device jar-integrity probe output (issue #4733): the combined
 * stdout of `sha256sum <jar>` (a `<64-hex>  <path>` line) and `wc -c < <jar>` (a
 * bare byte count). Order-independent. Returns `null` on any missing/garbled
 * field — a partial or absent result (jar missing, `sha256sum`/`wc` unavailable)
 * is treated by the caller as "push needed", never as a match.
 */
function parseRemoteJarIntegrity(output: string): VideoServerJarIntegrity | null {
  let sha256: string | null = null;
  let size: number | null = null;
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) {
      continue;
    }
    if (/^[0-9]+$/.test(line)) {
      size = Number.parseInt(line, 10);
      continue;
    }
    const shaMatch = /^([a-f0-9]{64})(?:\s|$)/.exec(line);
    if (shaMatch) {
      sha256 = shaMatch[1];
    }
  }
  if (sha256 === null || size === null || !Number.isInteger(size) || size < 0) {
    return null;
  }
  return { sha256, size };
}
export class VideoServerJarDeployment {
  private expectedJarIntegrity: VideoServerJarIntegrity | null = null;
  remoteJarVerified = false;
  private readonly jarIntegrityProvider: JarIntegrityProbe | undefined;
  constructor(
    private readonly options: PersistentEncoderH264SourceOptions,
    private readonly commandTimeoutMs: number,
    private readonly withTimeout: <T>(
      operation: Promise<T>,
      ms: number,
      label: string,
    ) => Promise<T>,
  ) {
    this.jarIntegrityProvider = options.jarIntegrityProvider;
  }

  /**
   * Push the jar to `/data/local/tmp` only when the on-device copy does not
   * already match the verified host bytes (issue #4733). The remote jar is
   * sha256summed + sized through the ADB seam and compared against the host-known
   * expected {@link VideoServerJarIntegrity}; a byte-identical remote copy skips
   * the ~2.5 MB USB push (first-frame latency), otherwise the push runs. Any
   * mismatch OR uncertainty (unreadable remote, missing `sha256sum`/`wc`, a probe
   * timeout) pushes — correctness is never traded for the optimization. A skip is
   * recorded in {@link remoteJarVerified} so the pre-launch verify can reuse it
   * (the happy path hashes the remote once). Bounded by the launch-command
   * timeout (issue #4741) like every other launch-path ADB call.
   */
  async ensureRemoteJar(adb: VideoSourceAdb): Promise<void> {
    const expected = await this.resolveExpectedJarIntegrity();
    const remote = await this.statAndHashRemoteJar(adb);
    if (remote !== null && remote.size === expected.size && remote.sha256 === expected.sha256) {
      this.remoteJarVerified = true;
      logger.info(
        `[PersistentEncoderH264Source] on-device video-server jar already matches ` +
          `(sha256=${expected.sha256}, size=${expected.size}); skipping push`,
      );
      return;
    }
    if (remote !== null) {
      logger.info(
        `[PersistentEncoderH264Source] on-device video-server jar differs ` +
          `(expected sha256=${expected.sha256} size=${expected.size}, ` +
          `remote sha256=${remote.sha256} size=${remote.size}); pushing`,
      );
    }
    await this.withTimeout(
      adb.executeCommand(`push "${this.options.jarPath}" ${VIDEO_SERVER_REMOTE_JAR_PATH}`, {
        timeoutMs: this.commandTimeoutMs,
      }),
      this.commandTimeoutMs,
      "adb push video-server jar",
    );
  }

  /**
   * Refuse to `app_process`-launch a jar whose on-device bytes DEFINITIVELY do
   * not match the verified host copy (issue #4733) — a supply-chain / TOCTOU
   * guard, since the jar runs in the screen/audio-capture context. Reuses the
   * pre-push match when the push was skipped ({@link remoteJarVerified}); `adb
   * forward` does not touch the jar, so that match still holds as the launch gate.
   * Otherwise (a push just ran) it re-hashes the remote jar and throws an
   * {@link ActionableError} on a definitive mismatch. An unreadable probe (device
   * without `sha256sum`/`wc`, or a probe timeout) is not a mismatch: the push has
   * already overwritten the remote with our trusted bytes, so — mirroring the
   * handshake graceful-degrade — it logs and proceeds rather than regressing every
   * such device to screenrecord.
   */
  async verifyRemoteJarBeforeLaunch(adb: VideoSourceAdb): Promise<void> {
    if (this.remoteJarVerified) {
      return;
    }
    const expected = await this.resolveExpectedJarIntegrity();
    const remote = await this.statAndHashRemoteJar(adb);
    if (remote === null) {
      logger.warn(
        `[PersistentEncoderH264Source] could not hash the on-device jar at ${VIDEO_SERVER_REMOTE_JAR_PATH} ` +
          "before launch; proceeding on the just-pushed trusted bytes (integrity verification degraded)",
      );
      return;
    }
    if (remote.size !== expected.size || remote.sha256 !== expected.sha256) {
      throw new ActionableError(
        `Refusing to launch video-server: the on-device jar at ${VIDEO_SERVER_REMOTE_JAR_PATH} failed ` +
          `integrity verification (expected sha256=${expected.sha256} size=${expected.size}, got ` +
          `sha256=${remote.sha256} size=${remote.size}). The bytes on the device do not match the ` +
          "verified host copy; app_process will not be launched.",
      );
    }
    this.remoteJarVerified = true;
  }

  /**
   * Host-known expected sha256 + size of the local jar, memoized (issue #4733).
   * Delegates to the injected {@link JarIntegrityProbe}, which hashes the actual
   * bytes at {@link PersistentEncoderH264SourceOptions.jarPath} with the canonical
   * calculator — correct for cache, override, and local-build jars alike.
   */
  private async resolveExpectedJarIntegrity(): Promise<VideoServerJarIntegrity> {
    if (this.expectedJarIntegrity === null) {
      const provider = this.jarIntegrityProvider ?? VideoServerJarProvider.getInstance();
      const integrity = await provider.computeLocalJarIntegrity(this.options.jarPath);
      this.expectedJarIntegrity = { sha256: integrity.sha256.toLowerCase(), size: integrity.size };
    }
    return this.expectedJarIntegrity;
  }

  /**
   * Read the on-device jar's sha256 + byte size through the ADB seam, or `null`
   * when it cannot be determined (issue #4733). A single `sh -c` runs
   * `sha256sum` + `wc -c` on the constant remote path (no interpolation), bounded
   * by the launch-command timeout. A missing jar, absent tooling, or a timeout
   * yields `null` — the callers treat that as "push"/"refuse", never as a match.
   */
  private async statAndHashRemoteJar(adb: VideoSourceAdb): Promise<VideoServerJarIntegrity | null> {
    const probe =
      `sha256sum ${VIDEO_SERVER_REMOTE_JAR_PATH} 2>/dev/null; ` +
      `wc -c < ${VIDEO_SERVER_REMOTE_JAR_PATH} 2>/dev/null`;
    try {
      const result = await this.withTimeout(
        adb.executeCommand(`shell sh -c ${shellQuote(probe)}`, {
          timeoutMs: this.commandTimeoutMs,
        }),
        this.commandTimeoutMs,
        "adb hash video-server jar",
      );
      return parseRemoteJarIntegrity(result.stdout);
    } catch (error) {
      // Uncertainty is not fatal here: the caller pushes (or refuses to launch)
      // on a null probe, so a wedged/absent probe never yields a false match.
      logger.debug(
        `[PersistentEncoderH264Source] unable to hash on-device video-server jar: ${error}`,
      );
      return null;
    }
  }
}
