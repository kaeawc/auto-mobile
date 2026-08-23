import { errorMessage } from "../../utils/describeUnknownError";
import { existsSync } from "node:fs";
import path from "node:path";
import { ActionableError } from "../../models/ActionableError";
import { isTruthyEnvValue } from "../../utils/ctrlProxyDownloadControl";
import { logger } from "../../utils/logger";
import { VideoServerJarProvider } from "./VideoServerJarProvider";
import { WEBRTC_ENV } from "./webrtcStreamingConfig";

/**
 * Env override pointing at an explicit, already-built `automobile-video.jar`.
 * Highest resolution precedence; never verified against a checksum (it is a
 * developer's own local artifact).
 */
export const VIDEO_SERVER_JAR_ENV = "AUTOMOBILE_VIDEO_SERVER_JAR";

/**
 * When set (`1`/`true`), any degrade-to-`screenrecord` case (no verifiable jar
 * available) becomes a hard `ActionableError` instead. Mirrors the #2746
 * `assertPinnedVersionVerifiable` fail-closed pattern. A checksum MISMATCH is
 * always fatal regardless of this flag.
 */
export const REQUIRE_VIDEO_SERVER_ENV = "AUTOMOBILE_REQUIRE_VIDEO_SERVER";

/**
 * When set (`1`/`true`), never touch the network: resolve from the local
 * override or Gradle build output only. Dedicated flag — intentionally NOT
 * `AUTOMOBILE_SKIP_CTRL_PROXY_DOWNLOAD`, whose CtrlProxy APK is mandatory
 * (different semantics; the jar is optional and degrades to `screenrecord`).
 */
export const SKIP_VIDEO_SERVER_DOWNLOAD_ENV = "AUTOMOBILE_SKIP_VIDEO_SERVER_DOWNLOAD";

/** Resolve the explicit env override iff it points at an existing file. */
function resolveOverride(env: NodeJS.ProcessEnv): string | null {
  const override = env[VIDEO_SERVER_JAR_ENV];
  return override && existsSync(override) ? override : null;
}

/** Resolve the local Gradle build output iff it exists (dev convenience). */
function resolveLocalBuild(cwd: string): string | null {
  const built = path.resolve(
    cwd,
    "android",
    "video-server",
    "build",
    "libs",
    "automobile-video.jar",
  );
  return existsSync(built) ? built : null;
}

/**
 * Synchronous local-only resolution: env override, then the Gradle build
 * output. Returns `null` when neither exists. Kept for callers that must not do
 * async work; the full precedence (which also fetches from GitHub releases)
 * lives in {@link resolveVideoServerJar}.
 */
export function resolveVideoServerJarPath(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): string | null {
  return resolveOverride(env) ?? resolveLocalBuild(cwd);
}

/** Just the ensure() surface {@link resolveVideoServerJar} needs from the provider. */
export interface VideoJarEnsurer {
  ensure(): Promise<string | null>;
}

export interface ResolveVideoServerJarDeps {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Injectable for tests; defaults to the shared provider singleton. */
  provider?: VideoJarEnsurer;
}

/**
 * Full resolution precedence for `automobile-video.jar` (#3834), on top of the
 * download provider (#3831):
 *
 *   1. `AUTOMOBILE_VIDEO_SERVER_JAR` explicit local override.
 *   2. Valid cached download        ┐ both via the provider's `ensure()`
 *   3. Fresh download + sha256 verify ┘ (skipped entirely when SKIP is set).
 *   4. Local Gradle build output (dev).
 *   5. else `null` → caller uses `screenrecord`.
 *
 * Fail-modes:
 *   - checksum known + matches   → use the jar.
 *   - checksum known + mismatch  → fatal `ActionableError` (thrown by the
 *     provider), even in degrade mode — never silently accepted.
 *   - checksum absent/unknown    → degrade (provider returns `null`).
 *   - `AUTOMOBILE_REQUIRE_VIDEO_SERVER` → a degrade result becomes fatal.
 *   - `AUTOMOBILE_SKIP_VIDEO_SERVER_DOWNLOAD` → local-only; the provider (cache
 *     + network) is never consulted.
 */
export async function resolveVideoServerJar(
  deps: ResolveVideoServerJarDeps = {},
): Promise<string | null> {
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();

  // 1. Explicit override always wins.
  const override = resolveOverride(env);
  if (override) {
    logger.info("[VIDEO_JAR] Using AUTOMOBILE_VIDEO_SERVER_JAR override", { path: override });
    return override;
  }

  const skip = isTruthyEnvValue(env[SKIP_VIDEO_SERVER_DOWNLOAD_ENV]);
  const requireJar = isTruthyEnvValue(env[REQUIRE_VIDEO_SERVER_ENV]);

  // 2 & 3. Cached-or-downloaded, verified jar — unless downloads are skipped.
  // A checksum mismatch/corruption throws here and is intentionally NOT caught:
  // it must stay fatal even when REQUIRE is off.
  if (!skip) {
    const provider = deps.provider ?? VideoServerJarProvider.getInstance();
    const downloaded = await provider.ensure();
    if (downloaded) {
      return downloaded;
    }
  } else {
    logger.info(
      "[VIDEO_JAR] AUTOMOBILE_SKIP_VIDEO_SERVER_DOWNLOAD set; resolving local sources only",
    );
  }

  // 4. Local Gradle build output (developer convenience).
  const built = resolveLocalBuild(cwd);
  if (built) {
    logger.info("[VIDEO_JAR] Using local Gradle build output", { path: built });
    return built;
  }

  // 5. Nothing verifiable available.
  if (requireJar) {
    throw new ActionableError(
      `${REQUIRE_VIDEO_SERVER_ENV} is set but no verifiable automobile-video.jar is available ` +
        `(no override, no ${skip ? "" : "downloadable or "}locally-built jar). ` +
        `Provide ${VIDEO_SERVER_JAR_ENV}, build \`:video-server:d8Dex\`, ` +
        `pin a release whose checksum registry includes videoJarSha256, ` +
        `or unset ${REQUIRE_VIDEO_SERVER_ENV} to allow the screenrecord fallback.`,
    );
  }
  logger.info("[VIDEO_JAR] No verifiable jar available; degrading to screenrecord");
  return null;
}

export interface PrefetchVideoServerJarDeps {
  env?: NodeJS.ProcessEnv;
  /** Injectable for tests; defaults to the shared provider singleton. */
  provider?: VideoJarEnsurer;
}

/**
 * Warm the jar cache at daemon startup, but only when WebRTC streaming is
 * actually configured (`AUTOMOBILE_WEBRTC_WHIP_ENDPOINT` present) so daemons
 * that never stream pull nothing (~2.5 MB saved). Best-effort and non-blocking:
 * the caller invokes it as `void prefetchVideoServerJar()`; the returned promise
 * exists only so tests can await completion. Reuses the provider's single-flight,
 * so a concurrent first-stream `ensure()` shares this download rather than
 * starting a second. Mirrors `AndroidCtrlProxyManager.prefetchApk`.
 *
 * Skips (no download) when downloads are disabled or an explicit override makes
 * the download unnecessary. A fatal fail-mode (checksum mismatch) is swallowed
 * here — the first real stream re-resolves via {@link resolveVideoServerJar} and
 * surfaces it there.
 */
export async function prefetchVideoServerJar(deps: PrefetchVideoServerJarDeps = {}): Promise<void> {
  const env = deps.env ?? process.env;

  const whip = env[WEBRTC_ENV.WHIP_ENDPOINT]?.trim();
  if (!whip) {
    logger.debug("[VIDEO_JAR] No WHIP endpoint configured; skipping background jar prefetch");
    return;
  }
  // Prefetch warms the DOWNLOAD cache specifically, so it re-derives the two
  // download-relevant gates from resolveVideoServerJar's precedence: an override
  // or SKIP means the download is never used, so there is nothing to warm.
  if (isTruthyEnvValue(env[SKIP_VIDEO_SERVER_DOWNLOAD_ENV])) {
    logger.debug(
      `[VIDEO_JAR] ${SKIP_VIDEO_SERVER_DOWNLOAD_ENV} set; skipping background jar prefetch`,
    );
    return;
  }
  if (resolveOverride(env)) {
    logger.debug(
      "[VIDEO_JAR] Local override present; skipping background jar prefetch (download unused)",
    );
    return;
  }

  const provider = deps.provider ?? VideoServerJarProvider.getInstance();
  logger.info(
    "[VIDEO_JAR] Prefetching video-server jar in the background (WebRTC streaming configured)",
  );
  try {
    const jarPath = await provider.ensure();
    if (jarPath) {
      logger.info("[VIDEO_JAR] Background prefetch warmed the jar cache", { path: jarPath });
    }
  } catch (error) {
    // Best-effort: the first stream re-resolves and surfaces any fatal error.
    logger.warn(`[VIDEO_JAR] Background jar prefetch failed: ${errorMessage(error)}`, error);
  }
}
