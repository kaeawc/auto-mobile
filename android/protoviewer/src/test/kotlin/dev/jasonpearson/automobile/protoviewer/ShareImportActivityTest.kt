package dev.jasonpearson.automobile.protoviewer

import android.content.Intent
import android.net.Uri
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.core.app.ApplicationProvider
import dev.jasonpearson.automobile.ctrlproxy.prototype.sha256Hex
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.android.controller.ActivityController

@RunWith(RobolectricTestRunner::class)
class ShareImportActivityTest {
  @get:Rule val compose = createComposeRule()
  private val client = FakeShareBundleClient()
  private val contentImporter = FakeLibraryImporter()
  private val settings = FakeSettingsStore()
  private var reads = 0
  private var controller: ActivityController<ImportActivity>? = null
  private val hash = sha256Hex(ImportBundleFixtures.minimal)

  @Before
  fun configure() {
    ApplicationProvider.getApplicationContext<ProtoViewerApplication>().servicesFactory = {
      ProtoViewerServices(
          FakeLibraryRepository(),
          LibraryStorage(FakePrototypeStorage()),
          UnconfinedTestDispatcher(),
          importer = contentImporter,
          settings = settings,
        )
        .also { services ->
          services.shareImporter =
            VerifiedShareLibraryImporter(
              client,
              LibraryBytesImporter { _, source, _ ->
                reads++
                assertEquals(LibrarySource.share, source)
                LibraryImportResult.Imported(Fixtures.entry())
              },
            )
        }
    }
  }

  @After
  fun close() {
    controller?.pause()?.stop()?.destroy()
  }

  @Test
  fun showsHostAndHashWithoutFetchingUntilConfirm() {
    val activity = launch()
    compose
      .onNodeWithText(activity.getString(R.string.share_import_host, "bundles.example"))
      .assertIsDisplayed()
    compose.onNodeWithText(activity.getString(R.string.share_import_hash, hash)).assertIsDisplayed()
    assertTrue(client.requests.isEmpty())
    assertTrue(contentImporter.requests.isEmpty())
    assertEquals(0, reads)
    compose.onNodeWithText(activity.getString(R.string.share_import_confirm)).performClick()
    assertEquals(1, client.requests.size)
    assertEquals(1, reads)
    assertFalse(settings.allowNetwork.value)
    assertTrue(activity.isFinishing)
    assertEquals(
      LibraryActivity::class.java.name,
      shadowOf(activity).nextStartedActivity.component?.className,
    )
  }

  @Test
  fun cancelDoesNotFetch() {
    val activity = launch()
    compose.onNodeWithText(activity.getString(R.string.cancel)).performClick()
    assertTrue(activity.isFinishing)
    assertTrue(client.requests.isEmpty())
    assertEquals(0, reads)
  }

  @Test
  fun invalidLinkIsRejectedWithoutFetchingOrUsingContentImporter() {
    val activity = launch("${shareLink(hash = hash)}&extra=1")
    compose.onNodeWithText(activity.getString(R.string.share_import_invalid)).assertIsDisplayed()
    assertTrue(client.requests.isEmpty())
    assertTrue(contentImporter.requests.isEmpty())
  }

  @Test
  fun hashMismatchShowsErrorWithoutStrictImport() {
    val activity = launch(shareLink())
    compose.onNodeWithText(activity.getString(R.string.share_import_confirm)).performClick()
    compose
      .onNodeWithText(activity.getString(R.string.share_import_hash_mismatch))
      .assertIsDisplayed()
    assertEquals(0, reads)
    assertFalse(activity.isFinishing)
  }

  @Test
  fun restoredConfirmationDoesNotFetch() {
    launch()
    controller?.recreate()
    compose.waitForIdle()
    assertTrue(client.requests.isEmpty())
    assertEquals(0, reads)
  }

  private fun launch(link: String = shareLink(hash = hash)): ImportActivity {
    controller =
      Robolectric.buildActivity(
          ImportActivity::class.java,
          Intent(Intent.ACTION_VIEW, Uri.parse(link)),
        )
        .setup()
    compose.waitForIdle()
    return checkNotNull(controller).get()
  }
}
