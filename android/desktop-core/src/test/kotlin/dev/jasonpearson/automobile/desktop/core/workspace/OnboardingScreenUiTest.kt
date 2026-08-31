package dev.jasonpearson.automobile.desktop.core.workspace

import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.runComposeUiTest
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalTestApi::class)
class OnboardingScreenUiTest {

  @Test
  fun `renders a welcome and the capability coach panel`() = runComposeUiTest {
    setContent { MaterialTheme { OnboardingScreen(onGetStarted = {}) } }
    onNodeWithText("Welcome to AutoMobile").assertIsDisplayed()
    onNodeWithText("WHAT YOU CAN DO HERE", substring = true).assertIsDisplayed()
    onNodeWithText("Observe devices", substring = true).assertIsDisplayed()
    onNodeWithText("Compare devices", substring = true).assertIsDisplayed()
    onNodeWithContentDescription("Get started").assertIsDisplayed()
  }

  @Test
  fun `Get started invokes the callback`() = runComposeUiTest {
    var started = false
    setContent { MaterialTheme { OnboardingScreen(onGetStarted = { started = true }) } }
    onNodeWithContentDescription("Get started").performClick()
    assertTrue(started)
  }

  @Test
  fun `qualifies storage as Android-only so the inspect copy doesn't over-promise on iOS`() =
    runComposeUiTest {
      setContent { MaterialTheme { OnboardingScreen(onGetStarted = {}) } }
      // Storage tooling is Android-only (#4708): WorkspaceFacet routes Tool.Storage to a
      // placeholder on iOS. The inspect capability copy must platform-qualify storage rather
      // than naming it as universally available (#4721).
      onNodeWithText("storage on Android", substring = true, ignoreCase = true).assertIsDisplayed()
    }

  @Test
  fun `carries no AI or assistant framing`() = runComposeUiTest {
    setContent { MaterialTheme { OnboardingScreen(onGetStarted = {}) } }
    // The onboarding must stay free of AI/LLM/assistant connotations (explicit product
    // requirement).
    for (banned in listOf("AI", "LLM", "assistant", "chat", "prompt", "magic")) {
      onNodeWithText(banned, substring = true, ignoreCase = true).assertDoesNotExist()
    }
  }
}
