package dev.jasonpearson.automobile.desktop.core.update

import dev.jasonpearson.automobile.desktop.core.platform.AppVersion
import dev.jasonpearson.automobile.desktop.core.platform.AppVersionProvider
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertTrue
import kotlinx.coroutines.test.runTest

/** State-machine behavior of the update check (AC1–AC5) against a fake release source. */
class RealUpdateControllerTest {

  /** Fake [ReleaseSource] that returns a canned release or throws, recording whether it was hit. */
  private class FakeReleaseSource(
    private val release: ReleaseInfo? = null,
    private val error: ReleaseFetchException? = null,
  ) : ReleaseSource {
    var fetched = false
      private set

    override suspend fun fetchLatestRelease(): ReleaseInfo {
      fetched = true
      error?.let { throw it }
      return release ?: error("test misconfigured: no release and no error")
    }
  }

  private fun versionProvider(version: AppVersion) = AppVersionProvider { version }

  private val packaged = AppVersion(raw = "0.0.52", isDevelopment = false)

  private fun release(
    tag: String,
    assets: List<ReleaseAsset> = listOf(ReleaseAsset("AutoMobile-x-macos.dmg", "https://x/dmg", 1)),
    draft: Boolean = false,
    prerelease: Boolean = false,
  ) = ReleaseInfo(tag, draft, prerelease, "https://notes", assets)

  @Test
  fun `newer release with a matching asset yields UpdateAvailable`() = runTest {
    val source = FakeReleaseSource(release("v0.0.53"))
    val controller = RealUpdateController(source, versionProvider(packaged), HostPlatform.MAC)

    controller.checkForUpdate()

    val status = controller.status.value
    assertIs<UpdateStatus.UpdateAvailable>(status)
    assertEquals("0.0.53", status.version)
    assertEquals("AutoMobile-x-macos.dmg", status.asset.name)
    assertEquals("https://notes", status.releaseNotesUrl)
  }

  @Test
  fun `equal version yields UpToDate`() = runTest {
    val controller =
      RealUpdateController(
        FakeReleaseSource(release("v0.0.52")),
        versionProvider(packaged),
        HostPlatform.MAC,
      )
    controller.checkForUpdate()
    assertEquals(UpdateStatus.UpToDate, controller.status.value)
  }

  @Test
  fun `older version yields UpToDate`() = runTest {
    val controller =
      RealUpdateController(
        FakeReleaseSource(release("v0.0.51")),
        versionProvider(packaged),
        HostPlatform.MAC,
      )
    controller.checkForUpdate()
    assertEquals(UpdateStatus.UpToDate, controller.status.value)
  }

  @Test
  fun `development build never checks and stays UpToDate`() = runTest {
    val source = FakeReleaseSource(release("v9.9.9"))
    val controller = RealUpdateController(source, versionProvider(AppVersion.Dev), HostPlatform.MAC)

    controller.checkForUpdate()

    assertEquals(UpdateStatus.UpToDate, controller.status.value)
    assertFalse(source.fetched, "a dev build must not hit the network")
  }

  @Test
  fun `fetch failure yields Failed with the reason`() = runTest {
    val source = FakeReleaseSource(error = ReleaseFetchException("rate limited (403)"))
    val controller = RealUpdateController(source, versionProvider(packaged), HostPlatform.MAC)

    controller.checkForUpdate()

    val status = controller.status.value
    assertIs<UpdateStatus.Failed>(status)
    assertTrue(status.reason.contains("403"))
  }

  @Test
  fun `newer release without an asset for this OS stays UpToDate`() = runTest {
    // Only a macOS asset, but we are on Windows.
    val source = FakeReleaseSource(release("v0.0.53"))
    val controller = RealUpdateController(source, versionProvider(packaged), HostPlatform.WINDOWS)

    controller.checkForUpdate()

    assertEquals(UpdateStatus.UpToDate, controller.status.value)
  }

  @Test
  fun `draft and prerelease latest releases are ignored`() = runTest {
    val draft =
      RealUpdateController(
        FakeReleaseSource(release("v0.0.53", draft = true)),
        versionProvider(packaged),
        HostPlatform.MAC,
      )
    draft.checkForUpdate()
    assertEquals(UpdateStatus.UpToDate, draft.status.value)

    val pre =
      RealUpdateController(
        FakeReleaseSource(release("v0.0.53", prerelease = true)),
        versionProvider(packaged),
        HostPlatform.MAC,
      )
    pre.checkForUpdate()
    assertEquals(UpdateStatus.UpToDate, pre.status.value)
  }

  @Test
  fun `unknown host platform stays UpToDate without checking`() = runTest {
    val source = FakeReleaseSource(release("v9.9.9"))
    val controller = RealUpdateController(source, versionProvider(packaged), platform = null)

    controller.checkForUpdate()

    assertEquals(UpdateStatus.UpToDate, controller.status.value)
    assertFalse(source.fetched, "an unshipped OS must not hit the network")
  }
}
