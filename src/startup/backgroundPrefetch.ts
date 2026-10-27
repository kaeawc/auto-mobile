import { ENV, readEnvRaw, readEnvTrimmed } from "../config/env";
import { ScreenCaptureHelperProvider } from "../features/screen-stream/ScreenCaptureHelperProvider";
import { prefetchVideoServerJar } from "../features/webrtc/videoServerJar";
import {
  SKIP_CTRL_PROXY_DOWNLOAD_ENV,
  SKIP_CTRL_PROXY_DOWNLOAD_FLAG,
} from "../utils/ctrlProxyDownloadControl";
import { errorMessage } from "../utils/describeUnknownError";
import { sweepNativeHelperOrphans } from "../utils/nativeHelpers/sweepNativeHelperOrphans";
import { startStartupMaintenance } from "../utils/startupMaintenance";
import { startupBenchmark } from "../utils/startupBenchmark";
import type { ServerModules } from "./serverModules";

/**
 * Reclaims artifacts leaked by previous daemons and warms the CtrlProxy and encoder caches in the
 * background. None of it gates stdio readiness: the sweeps are best-effort maintenance, not a
 * prerequisite for serving a new client (issue #4581).
 *
 * `skipDeviceStartupWork` (usage-only `--cli help`) talks to no device, so it skips the
 * prefetches and cache maintenance entirely (#10792).
 */
export function startBackgroundDeviceWork(
  modules: ServerModules,
  skipCtrlProxyDownload: boolean,
  skipDeviceStartupWork: boolean,
): void {
  if (!skipDeviceStartupWork) {
    startStartupMaintenance({
      platform: process.platform,
      startAndroidSweep: () => modules.AndroidCtrlProxyManager.sweepStalePrefetchDirsOnStartup(),
      startIosReap: () => modules.IOSCtrlProxyManager.startOrphanRunnerReapOnStartup(),
      startNativeHelperSweep: async () => {
        await sweepNativeHelperOrphans();
      },
    });
  }
  prefetchAndroidCtrlProxy(modules, skipCtrlProxyDownload, skipDeviceStartupWork);
  prefetchIosCtrlProxy(modules, skipCtrlProxyDownload, skipDeviceStartupWork);
  prefetchWebRtcHelpers(modules);
}

function prefetchAndroidCtrlProxy(
  modules: ServerModules,
  skipCtrlProxyDownload: boolean,
  skipDeviceStartupWork: boolean,
): void {
  if (skipDeviceStartupWork) {
    startupBenchmark.recordPhase("androidCtrlProxyPrefetch", 0);
  } else if (skipCtrlProxyDownload) {
    modules.logger.info(
      `CtrlProxy downloads disabled (${SKIP_CTRL_PROXY_DOWNLOAD_FLAG} or ${SKIP_CTRL_PROXY_DOWNLOAD_ENV})`,
    );
    startupBenchmark.recordPhase("androidCtrlProxyPrefetch", 0);
  } else {
    // Start prefetching the accessibility service APK in the background
    // This runs asynchronously and will be ready when first device connects
    startupBenchmark.startPhase("androidCtrlProxyPrefetch");
    void modules.AndroidCtrlProxyManager.prefetchApk().then(() => {
      startupBenchmark.endPhase("androidCtrlProxyPrefetch");
    });
  }
}

/** Start the iOS build prefetch asynchronously so it can be ready for first use. */
function prefetchIosCtrlProxy(
  modules: ServerModules,
  skipCtrlProxyDownload: boolean,
  skipDeviceStartupWork: boolean,
): void {
  if (process.platform !== "darwin" || skipDeviceStartupWork) {
    return;
  }
  if (skipCtrlProxyDownload) {
    modules.logger.info(
      `CtrlProxy iOS prefetch disabled (${SKIP_CTRL_PROXY_DOWNLOAD_FLAG} or ${SKIP_CTRL_PROXY_DOWNLOAD_ENV})`,
    );
    startupBenchmark.recordPhase("iosCtrlProxyPrefetch", 0);
    return;
  }
  startupBenchmark.startPhase("iosCtrlProxyPrefetch");
  void modules.IosCtrlProxyBuilder.prefetchBuild().then(() => {
    startupBenchmark.endPhase("iosCtrlProxyPrefetch");
  });
}

/**
 * Warm the persistent-encoder jar cache in the background, but only when WebRTC streaming is
 * configured (AUTOMOBILE_WEBRTC_WHIP_ENDPOINT) — daemons that never stream pull nothing.
 * Non-blocking; reuses the provider's single-flight so a first stream shares this download (#3835).
 */
function prefetchWebRtcHelpers(modules: ServerModules): void {
  void prefetchVideoServerJar();
  if (
    process.platform === "darwin" &&
    readEnvTrimmed(ENV.WEBRTC_WHIP_ENDPOINT) &&
    !readEnvRaw(ENV.IOS_SCREEN_CAPTURE_HELPER)
  ) {
    void ScreenCaptureHelperProvider.getInstance()
      .ensure()
      .catch((error) => {
        modules.logger.warn(
          `[SCREEN_CAPTURE_HELPER] Background prefetch failed: ${errorMessage(error)}`,
        );
      });
  }
}
