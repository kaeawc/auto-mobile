package dev.jasonpearson.automobile.desktop.core.shell

import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.runComposeUiTest
import dev.jasonpearson.automobile.desktop.core.update.ReleaseAsset
import dev.jasonpearson.automobile.desktop.core.update.UpdateStatus
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import org.junit.Test

@OptIn(ExperimentalTestApi::class)
class UpdateReadyButtonUiTest {

  private val available =
    UpdateStatus.UpdateAvailable(
      version = "0.0.53",
      asset = ReleaseAsset("AutoMobile-0.0.53-macos.dmg", "https://x/dmg", 10),
      releaseNotesUrl = "https://notes",
    )

  @Test
  fun `pill is shown only when an update is available`() = runComposeUiTest {
    setContent { MaterialTheme { UpdateReadyButton(status = available, onClick = {}) } }
    onNodeWithText("Update ready").assertIsDisplayed()
  }

  @Test
  fun `pill is hidden for non-available states`() {
    for (status in
      listOf(
        UpdateStatus.Idle,
        UpdateStatus.Checking,
        UpdateStatus.UpToDate,
        UpdateStatus.Failed("boom"),
      )) {
      runComposeUiTest {
        setContent { MaterialTheme { UpdateReadyButton(status = status, onClick = {}) } }
        onNodeWithText("Update ready").assertDoesNotExist()
      }
    }
  }

  @Test
  fun `clicking the pill invokes onClick`() = runComposeUiTest {
    var clicks = 0
    setContent { MaterialTheme { UpdateReadyButton(status = available, onClick = { clicks++ }) } }
    onNodeWithText("Update ready").performClick()
    assertEquals(1, clicks)
  }

  @Test
  fun `details content shows available and current versions and a notes link`() = runComposeUiTest {
    var notesOpened = 0
    setContent {
      MaterialTheme {
        UpdateDetailsContent(
          update = available,
          currentVersion = "0.0.52",
          onOpenReleaseNotes = { notesOpened++ },
        )
      }
    }
    // The available version and current version are both surfaced.
    onNodeWithText("0.0.53", substring = true).assertIsDisplayed()
    onNodeWithText("0.0.52", substring = true).assertIsDisplayed()
    // The release-notes affordance is present and wired.
    onNodeWithText("Release notes", substring = true).performClick()
    assertTrue(notesOpened == 1)
  }

  @Test
  fun `install action is present but disabled in this item`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        UpdateDetailsContent(
          update = available,
          currentVersion = "0.0.52",
          onOpenReleaseNotes = {},
        )
      }
    }
    // The install affordance exists but is not yet actionable (delivered by a later item).
    onNodeWithText("Install", substring = true).assertIsNotEnabled()
  }
}
