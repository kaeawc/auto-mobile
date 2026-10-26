package dev.jasonpearson.automobile.protoviewer

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class LicensesActivityTest {
  @get:Rule val compose = createComposeRule()

  private val document =
    parseLicenseDocument(
      """{"libraries":[
        {"uniqueId":"b:second","name":"Second","artifactVersion":"2.0","licenses":["Apache-2.0"]},
        {"uniqueId":"a:first","name":"First","artifactVersion":"1.0",
         "organization":{"name":"First Org"},"licenses":["Apache-2.0"]}],
        "licenses":{"Apache-2.0":{"name":"Apache License 2.0","content":"Apache full text"}}}""",
    )

  @Test
  fun listsLibrariesAlphabeticallyAndExpandsLicenseText() {
    compose.setContent { ProtoViewerTheme { LicensesScreen(document, failed = false) } }
    compose.onNodeWithText("Open-source licenses").assertIsDisplayed()
    compose.onNodeWithText("1.0 · First Org · Apache License 2.0").assertIsDisplayed()
    compose.onNodeWithText("Apache full text").assertDoesNotExist()
    compose.onNodeWithTag("license-a:first").performClick()
    compose.onNodeWithTag("license-text-a:first").assertIsDisplayed()
    compose.onNodeWithTag("license-a:first").performClick()
    compose.onNodeWithText("Apache full text").assertDoesNotExist()
  }

  @Test
  fun showsLoadingWhileUnread() {
    compose.setContent { ProtoViewerTheme { LicensesScreen(null, failed = false) } }
    compose.onNodeWithText("Loading…").assertIsDisplayed()
  }

  @Test
  fun showsErrorWhenUnreadable() {
    compose.setContent { ProtoViewerTheme { LicensesScreen(null, failed = true) } }
    compose.onNodeWithText("Unable to read the open-source licenses.").assertIsDisplayed()
  }

  @Test
  fun activityRendersTheGeneratedNotices() {
    ApplicationProvider.getApplicationContext<ProtoViewerApplication>().servicesFactory = {
      ProtoViewerServices(
        FakeLibraryRepository(),
        LibraryStorage(FakePrototypeStorage()),
        UnconfinedTestDispatcher(),
        LibraryClock { 42 },
        settings = FakeSettingsStore(),
      )
    }
    val controller = Robolectric.buildActivity(LicensesActivity::class.java).setup()
    compose.waitForIdle()
    // First alphabetically in the generated notices, so it is inside the viewport.
    compose.onNodeWithText("Activity").assertIsDisplayed()
    controller.pause().stop().destroy()
  }
}
