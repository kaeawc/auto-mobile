package dev.jasonpearson.automobile.desktop.core.storage

import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.runComposeUiTest
import org.junit.Test

@OptIn(ExperimentalTestApi::class)
class StorageLoadErrorUiTest {
  @Test
  fun `provider failure keeps raw detail collapsed until requested`() = runComposeUiTest {
    setContent { StorageLoadError("Could not find provider", "PROVIDER_UNAVAILABLE") }
    onNodeWithText("Could not find provider").assertDoesNotExist()
    onNodeWithText("Show details").performClick()
    onNodeWithText("Could not find provider").assertExists()
  }

  @Test
  fun `unknown failure shows full detail immediately`() = runComposeUiTest {
    setContent { StorageLoadError("database went away", null) }
    onNodeWithText("database went away").assertExists()
    onNodeWithText("Show details").assertDoesNotExist()
  }
}
