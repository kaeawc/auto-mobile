package dev.jasonpearson.automobile.protoviewer

import android.content.Intent
import android.net.Uri
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import org.junit.Assert.*
import org.junit.Before
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
  private val importer = FakeLibraryImporter()

  @Before
  fun configure() {
    ApplicationProvider.getApplicationContext<ProtoViewerApplication>().servicesFactory = {
      ProtoViewerServices(
        FakeLibraryRepository(),
        LibraryStorage(FakePrototypeStorage()),
        UnconfinedTestDispatcher(),
        importer = importer,
      )
    }
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
