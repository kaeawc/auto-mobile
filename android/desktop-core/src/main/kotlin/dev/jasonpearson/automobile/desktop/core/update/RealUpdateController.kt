package dev.jasonpearson.automobile.desktop.core.update

import dev.jasonpearson.automobile.desktop.core.logging.LoggerFactory
import dev.jasonpearson.automobile.desktop.core.platform.AppVersionProvider
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

private val LOG = LoggerFactory.getLogger("UpdateController")

/**
 * Checks GitHub Releases for a build newer than the running one. Purely reactive: it performs no
 * network work until [checkForUpdate] is called, and never on construction. A development build
 * (the [AppVersion.Dev] sentinel from the version provider) and an OS with no installer both
 * resolve to [UpdateStatus.UpToDate] without a fetch, so nothing self-updates in development.
 */
class RealUpdateController(
  private val releaseSource: ReleaseSource,
  private val appVersionProvider: AppVersionProvider,
  private val platform: HostPlatform? = HostPlatform.current(),
) : UpdateController {

  private val mutableStatus = MutableStateFlow<UpdateStatus>(UpdateStatus.Idle)
  override val status: StateFlow<UpdateStatus> = mutableStatus.asStateFlow()

  override suspend fun checkForUpdate() {
    val appVersion = appVersionProvider.current()
    // A development build (no packaged version) and an OS we don't ship an installer for both mean
    // "there is nothing we could apply" — resolve without any network work so dev never
    // self-updates.
    if (appVersion.isDevelopment) {
      mutableStatus.value = UpdateStatus.UpToDate
      return
    }
    val hostPlatform = platform
    if (hostPlatform == null) {
      mutableStatus.value = UpdateStatus.UpToDate
      return
    }

    // Captured so a cancelled check restores the last stable state rather than pinning the shared
    // singleton StateFlow at Checking for every collector.
    val previousStatus = mutableStatus.value
    mutableStatus.value = UpdateStatus.Checking
    val release =
      try {
        releaseSource.fetchLatestRelease()
      } catch (cancellation: CancellationException) {
        mutableStatus.value = previousStatus
        throw cancellation
      } catch (error: Exception) {
        // Typed failure surfaced to the UI; the check is best-effort and must never crash the app.
        LOG.warn("Update check failed: ${error.message}", error)
        mutableStatus.value = UpdateStatus.Failed(error.message ?: "Update check failed")
        return
      }

    if (release.isDraft || release.isPrerelease) {
      mutableStatus.value = UpdateStatus.UpToDate
      return
    }
    if (!isNewerVersion(release.tagName, appVersion.raw)) {
      mutableStatus.value = UpdateStatus.UpToDate
      return
    }
    val asset = resolveAsset(release.assets, hostPlatform)
    if (asset == null) {
      // A newer release exists but ships no installer for this OS — stay quiet, but leave a trace.
      LOG.warn(
        "Release ${release.tagName} is newer but has no ${hostPlatform.assetSuffix} asset; staying UpToDate"
      )
      mutableStatus.value = UpdateStatus.UpToDate
      return
    }
    mutableStatus.value =
      UpdateStatus.UpdateAvailable(
        version = release.tagName.trim().removePrefix("v").removePrefix("V"),
        asset = asset,
        releaseNotesUrl = release.htmlUrl,
      )
  }
}
