package dev.jasonpearson.automobile.desktop.core.shell

import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.runComposeUiTest
import dev.jasonpearson.automobile.desktop.core.update.ReleaseAsset
import dev.jasonpearson.automobile.desktop.core.update.UpdateStatus
import kotlin.test.assertEquals
import org.junit.Test

/**
 * Covers the launch-surface (device-picker / onboarding) update affordance (#5271). The affordance
 * is the only "update ready" surface those screens have — the workspace hosts its own top-bar pill
 * — so these tests pin the behavior the picker/onboarding path relies on.
 */
@OptIn(ExperimentalTestApi::class)
class FloatingUpdateAffordanceUiTest {

  private val available =
    UpdateStatus.UpdateAvailable(
      version = "0.0.53",
      asset = ReleaseAsset("AutoMobile-0.0.53-macos.dmg", "https://x/dmg", 10),
      releaseNotesUrl = "https://notes",
    )

  @Test
  fun `affordance is shown on a launch surface when an update is available`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        FloatingUpdateAffordance(
          status = available,
          currentVersion = "0.0.52",
          onOpenReleaseNotes = {},
        )
      }
    }
    onNodeWithText("Update ready").assertIsDisplayed()
  }

  @Test
  fun `affordance is hidden for non-available states`() {
    for (status in
      listOf(
        UpdateStatus.Idle,
        UpdateStatus.Checking,
        UpdateStatus.UpToDate,
        UpdateStatus.Failed("boom"),
      )) {
      runComposeUiTest {
        setContent {
          MaterialTheme {
            FloatingUpdateAffordance(
              status = status,
              currentVersion = "0.0.52",
              onOpenReleaseNotes = {},
            )
          }
        }
        onNodeWithText("Update ready").assertDoesNotExist()
      }
    }
  }

  @Test
  fun `details are collapsed until the pill is clicked`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        FloatingUpdateAffordance(
          status = available,
          currentVersion = "0.0.52",
          onOpenReleaseNotes = {},
        )
      }
    }
    // Before any click the details surface is not present, only the pill.
    onNodeWithText("is available", substring = true).assertDoesNotExist()
    onNodeWithText("Update ready").performClick()
    // Clicking opens the same details content: available + current version and the notes link.
    onNodeWithText("0.0.53", substring = true).assertIsDisplayed()
    onNodeWithText("0.0.52", substring = true).assertIsDisplayed()
    onNodeWithText("Release notes", substring = true).assertIsDisplayed()
  }

  @Test
  fun `clicking release notes invokes the callback`() = runComposeUiTest {
    var opened = 0
    setContent {
      MaterialTheme {
        FloatingUpdateAffordance(
          status = available,
          currentVersion = "0.0.52",
          onOpenReleaseNotes = { opened++ },
        )
      }
    }
    onNodeWithText("Update ready").performClick()
    onNodeWithText("Release notes", substring = true).performClick()
    assertEquals(1, opened)
  }

  @Test
  fun `install action is disabled until an apply callback is supplied`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        FloatingUpdateAffordance(
          status = available,
          currentVersion = "0.0.52",
          onOpenReleaseNotes = {},
          // onInstall defaults to null (the GitHub-Releases path; apply lands in #5226).
        )
      }
    }
    onNodeWithText("Update ready").performClick()
    onNodeWithText("Install", substring = true).assertIsNotEnabled()
  }

  @Test
  fun `install action is enabled and invokes the callback when supplied`() = runComposeUiTest {
    var installs = 0
    setContent {
      MaterialTheme {
        FloatingUpdateAffordance(
          status = available,
          currentVersion = "0.0.52",
          onOpenReleaseNotes = {},
          onInstall = { installs++ },
        )
      }
    }
    onNodeWithText("Update ready").performClick()
    onNodeWithText("Install", substring = true).assertIsEnabled()
    onNodeWithText("Install", substring = true).performClick()
    assertEquals(1, installs)
  }
}
