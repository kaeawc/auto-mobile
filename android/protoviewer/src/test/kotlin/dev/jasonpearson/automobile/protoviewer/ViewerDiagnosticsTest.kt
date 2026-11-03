package dev.jasonpearson.automobile.protoviewer

import android.content.ClipboardManager
import android.content.Context
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.core.app.ApplicationProvider
import dev.jasonpearson.automobile.ctrlproxy.prototype.SavedPrototypeLoadResult
import dev.jasonpearson.automobile.protocol.PrototypeStoredValues
import dev.jasonpearson.automobile.prototype.AutoMobilePrototype
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.serialization.json.JsonPrimitive
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.android.controller.ActivityController

@RunWith(RobolectricTestRunner::class)
class ViewerDiagnosticsTest {
  @get:Rule val compose = createComposeRule()
  private val repository = FakeLibraryRepository()
  private val storage = FakePrototypeStorage()
  private var controller: ActivityController<ViewerActivity>? = null

  @Before
  fun configure() {
    // Plant the sentinel everywhere user content lives: spec, label, slug and saved state.
    val stored = PrototypeStoredValues(1, mapOf(SENTINEL to JsonPrimitive(SENTINEL)))
    storage.values[FIRST] = stored
    storage.values[SENTINEL] = stored
    ApplicationProvider.getApplicationContext<ProtoViewerApplication>().servicesFactory = {
      ProtoViewerServices(
        repository,
        LibraryStorage(storage),
        UnconfinedTestDispatcher(),
        LibraryClock { 42 },
        settings = FakeSettingsStore(),
      )
    }
  }

  @After
  fun close() {
    controller?.pause()?.stop()?.destroy()
  }

  private fun prototype(specJson: String) =
    LibraryPrototype(
      Fixtures.entry().copy(label = "Label $SENTINEL"),
      SavedPrototypeLoadResult.Loaded(
        FIRST,
        "Label $SENTINEL",
        "slug-$SENTINEL",
        10,
        Fixtures.spec,
        specJson,
        emptyMap(),
      ),
    )

  private fun copyFromViewer(): String {
    val context = ApplicationProvider.getApplicationContext<Context>()
    controller =
      Robolectric.buildActivity(ViewerActivity::class.java, ViewerLaunch.intent(context, FIRST))
        .setup()
    compose.waitForIdle()
    compose.onNodeWithText("Copy diagnostics").performClick()
    compose.waitForIdle()
    val clip = context.getSystemService(ClipboardManager::class.java).primaryClip
    return checkNotNull(clip).getItemAt(0).text.toString()
  }

  private fun assertNoUserContent(text: String) {
    assertFalse(text, text.contains(SENTINEL))
    assertFalse(text, text.contains(FIRST))
  }

  @Test
  fun copiedDiagnosticsFromWorkingPrototypeLeakNoSpecOrStorage() {
    val spec = SPEC.replace("Prototype content", "Prototype content $SENTINEL")
    repository.prototypes[FIRST] = prototype(spec)
    val text = copyFromViewer()
    compose.onNodeWithText("Prototype content $SENTINEL").assertIsDisplayed()
    assertNoUserContent(text)
    assertTrue(text, text.contains("last-error: none"))
    assertTrue(text, text.contains("watchdog-tripped: false"))
    assertTrue(
      text,
      text.contains("capabilities: ${AutoMobilePrototype.capabilities.sorted().joinToString(",")}"),
    )
  }

  @Test
  fun copiedDiagnosticsAfterValidationErrorKeepOnlyTheCode() {
    // The validator's path and message would echo this unknown type; diagnostics must not.
    repository.prototypes[FIRST] =
      prototype("""{"id":"$SENTINEL","root":{"type":"$SENTINEL","id":"$SENTINEL"}}""")
    val text = copyFromViewer()
    assertNoUserContent(text)
    assertTrue(text, text.contains("last-error: validation"))
  }

  @Test
  fun copiedDiagnosticsAfterLoadErrorReportLibraryCode() {
    repository.error = LibraryError.Corrupt
    val text = copyFromViewer()
    assertTrue(text, text.contains("last-error: library-corrupt"))
  }

  @Test
  fun formatListsFixedKeysOnly() {
    val text =
      ViewerDiagnostics("1.2.3", 34, setOf("b", "a"), ViewerFailure.Watchdog, true).format()
    assertEquals(
      listOf(
          "ProtoViewer diagnostics",
          "platform: android",
          "app-version: 1.2.3",
          "android-sdk: 34",
          "capabilities: a,b",
          "last-error: watchdog",
          "watchdog-tripped: true",
        )
        .joinToString("\n"),
      text,
    )
  }

  @Test
  fun everyLibraryErrorHasADistinctCode() {
    val codes = LibraryError.entries.map { ViewerFailure.of(it).code }
    assertEquals(codes.size, codes.toSet().size)
  }

  private companion object {
    const val SENTINEL = "zz-private-7f3a"
  }
}
