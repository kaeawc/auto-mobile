package dev.jasonpearson.automobile.protoviewer

import android.content.Context
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.core.app.ApplicationProvider
import dev.jasonpearson.automobile.ctrlproxy.prototype.SavedPrototypeLoadResult
import dev.jasonpearson.automobile.protocol.PrototypeSpecValidation
import dev.jasonpearson.automobile.protocol.PrototypeSpecValidator
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class DeniedNetworkTest {
  @get:Rule val compose = createComposeRule()

  @Test
  fun deviceRequestSetsErrorStatusWithoutNetwork() {
    val spec =
      """{"id":"offline","window":{"placement":{"type":"fullscreen"}},"state":{"status":"idle"},"root":{"type":"column","children":[{"type":"button","label":"Request","onTap":[{"type":"request","url":"https://example.test","method":"GET","via":"device","statusKey":"status"}]},{"type":"text","text":"Blocked request","visibleWhen":{"key":"status","equals":"error"}}]}}"""
    val validated = PrototypeSpecValidator.validate(spec) as PrototypeSpecValidation.Success
    val repository = FakeLibraryRepository()
    repository.prototypes[FIRST] =
      LibraryPrototype(
        Fixtures.entry(),
        SavedPrototypeLoadResult.Loaded(
          FIRST,
          "Offline",
          "slug",
          0,
          validated.spec,
          spec,
          emptyMap(),
        ),
      )
    val app = ApplicationProvider.getApplicationContext<ProtoViewerApplication>()
    app.servicesFactory = {
      ProtoViewerServices(
        repository,
        LibraryStorage(FakePrototypeStorage()),
        UnconfinedTestDispatcher(),
        LibraryClock { 42 },
      )
    }
    val context: Context = app
    val controller =
      Robolectric.buildActivity(ViewerActivity::class.java, ViewerLaunch.intent(context, FIRST))
        .setup()
    try {
      compose.waitForIdle()
      compose.onNodeWithText("Request").performClick()
      compose.waitForIdle()
      compose.onNodeWithText("Blocked request").assertIsDisplayed()
    } finally {
      controller.pause().stop().destroy()
    }
  }
}
