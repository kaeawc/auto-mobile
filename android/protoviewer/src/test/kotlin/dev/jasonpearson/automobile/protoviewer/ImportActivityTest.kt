package dev.jasonpearson.automobile.protoviewer

import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import org.junit.Assert.*
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf

internal class FakeLibraryImporter : LibraryImporter {
  val requests = mutableListOf<LibraryImportRequest>()
  var result: LibraryImportResult = LibraryImportResult.Rejected("spec.json", "Invalid")

  override fun import(request: LibraryImportRequest): LibraryImportResult {
    requests += request
    return result
  }
}

@RunWith(RobolectricTestRunner::class)
class ImportActivityTest {
  @get:Rule val compose = createComposeRule()
  private val importer = FakeLibraryImporter()

  @Before
  fun configure() {
    ApplicationProvider.getApplicationContext<ProtoViewerApplication>().servicesFactory = {
      ProtoViewerServices(
        FakeLibraryRepository(),
        LibraryStorage(FakePrototypeStorage()),
        UnconfinedTestDispatcher(),
        importer = importer,
        settings = FakeSettingsStore(),
        blocklist = FakeContentBlocklist(),
      )
    }
  }

  @Test
  fun capabilityRejectionShowsUpdateAndOpensPlayUrl() {
    val rejected =
      LibraryImportResult.Rejected("spec.json", UNSUPPORTED_PROTOTYPE_REASON, listOf("future_a"))
    val opened = mutableListOf<String>()
    compose.setContent {
      ImportStatus(importStatusText(null, rejected), rejected.missingCapabilities, opened::add) {}
    }
    val context = ApplicationProvider.getApplicationContext<ProtoViewerApplication>()
    compose
      .onNodeWithText(context.getString(R.string.import_requires_capabilities, "future_a"))
      .assertIsDisplayed()
    compose
      .onNodeWithText(context.getString(R.string.update_protoviewer))
      .assertIsDisplayed()
      .performClick()
    assertEquals(listOf(PROTOVIEWER_STORE_URL), opened)
  }

  @Test
  fun activityConnectsCapabilityRejectionToStoreIntent() {
    importer.result =
      LibraryImportResult.Rejected("spec.json", UNSUPPORTED_PROTOTYPE_REASON, listOf("future_a"))
    val controller =
      Robolectric.buildActivity(
          ImportActivity::class.java,
          Intent(Intent.ACTION_VIEW, Uri.parse("content://external/file")),
        )
        .setup()
    try {
      val activity = controller.get()
      compose.onNodeWithText(activity.getString(R.string.update_protoviewer)).performClick()
      val opened = shadowOf(activity).nextStartedActivity
      assertEquals(Intent.ACTION_VIEW, opened.action)
      assertEquals(PROTOVIEWER_STORE_URL, opened.data.toString())
      assertFalse(activity.isFinishing)
    } finally {
      controller.pause().stop().destroy()
    }
  }

  @Test
  fun specOnlyRejectionOmitsCapabilityNamesButOffersUpdate() {
    val rejected =
      LibraryImportResult.Rejected("spec.json", UNSUPPORTED_PROTOTYPE_REASON, emptyList())
    compose.setContent {
      ImportStatus(importStatusText(null, rejected), rejected.missingCapabilities, {}) {}
    }
    val context = ApplicationProvider.getApplicationContext<ProtoViewerApplication>()
    compose.onNodeWithText(context.getString(R.string.unsupported)).assertIsDisplayed()
    compose.onNodeWithText(context.getString(R.string.update_protoviewer)).assertIsDisplayed()
  }

  @Test
  fun ordinaryRejectionDoesNotOfferUpdate() {
    val rejected = LibraryImportResult.Rejected("spec.json", "Invalid")
    compose.setContent {
      ImportStatus(importStatusText(null, rejected), rejected.missingCapabilities, {}) {}
    }
    val context = ApplicationProvider.getApplicationContext<ProtoViewerApplication>()
    compose
      .onNodeWithText(context.getString(R.string.import_rejected, rejected.path, rejected.reason))
      .assertIsDisplayed()
    compose.onNodeWithText(context.getString(R.string.update_protoviewer)).assertDoesNotExist()
  }

  @Test
  fun updateOpenerUsesViewIntentAndIgnoresMissingHandler() {
    var opened: Intent? = null
    openProtoViewerUpdate(PROTOVIEWER_STORE_URL) { opened = it }
    assertEquals(Intent.ACTION_VIEW, opened?.action)
    assertEquals(PROTOVIEWER_STORE_URL, opened?.data.toString())
    openProtoViewerUpdate(PROTOVIEWER_STORE_URL) { throw ActivityNotFoundException() }
  }

  @Test
  fun onlyTheLibrarysHiddenRejectionGetsTheHiddenMessage() {
    assertTrue(LibraryImportResult.Rejected("library", LibraryError.Hidden.name).isHidden)
    assertFalse(LibraryImportResult.Rejected("library", LibraryError.Limit.name).isHidden)
    assertFalse(LibraryImportResult.Rejected("spec.json", LibraryError.Hidden.name).isHidden)
  }

  @Test
  fun viewIntentPassesOnlyUriAndAppChosenAction() {
    val intent =
      Intent(Intent.ACTION_VIEW, Uri.parse("content://external/file"))
        .setType("application/anything")
        .setData(Uri.parse("content://external/file"))
        .putExtra("source", "mcp")
        .putExtra("libraryId", FIRST)
    val controller = Robolectric.buildActivity(ImportActivity::class.java, intent).setup()
    assertEquals(
      listOf(LibraryImportRequest(ImportAction.View, "content://external/file")),
      importer.requests,
    )
    assertFalse(controller.get().isFinishing)
    controller.pause().stop().destroy()
  }

  @Test
  fun sendUsesStreamAndSuccessReturnsToLibrary() {
    importer.result = LibraryImportResult.Imported(Fixtures.entry())
    val intent =
      Intent(Intent.ACTION_SEND)
        .putExtra(Intent.EXTRA_STREAM, Uri.parse("content://external/shared"))
    val controller = Robolectric.buildActivity(ImportActivity::class.java, intent).setup()
    assertEquals(
      listOf(LibraryImportRequest(ImportAction.Send, "content://external/shared")),
      importer.requests,
    )
    assertEquals(
      LibraryActivity::class.java.name,
      shadowOf(controller.get()).nextStartedActivity.component?.className,
    )
    assertTrue(controller.get().isFinishing)
    controller.pause().stop().destroy()
  }

  @Test
  fun explicitUnknownActionStillGoesThroughPipelineWithInvalidAction() {
    val intent = Intent("internal.import").putExtra("path", "/inbox/spec").putExtra("source", "mcp")
    val controller = Robolectric.buildActivity(ImportActivity::class.java, intent).setup()
    assertEquals(listOf(LibraryImportRequest(null, null)), importer.requests)
    controller.pause().stop().destroy()
  }
}
