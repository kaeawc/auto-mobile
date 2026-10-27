package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.v2.createComposeRule
import dev.jasonpearson.automobile.protocol.*
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class PrototypeClosedRuntimeContentTest {
  @get:Rule val compose = createComposeRule()
  private lateinit var runtime: PrototypeRuntime

  @Before
  fun showContent() {
    runtime =
      PrototypeRuntime(
        PrototypeSpec(
          "window",
          PrototypeWindow(PrototypeFullscreenPlacement()),
          root = PrototypeTextNode(text = "Final content"),
        ),
        nextSequence = { 1L },
      )
    compose.setContent {
      CompositionLocalProvider(LocalPrototypeWindowRetainsContent provides true) {
        PrototypeRuntimeContent(runtime) {}
      }
    }
    compose.waitForIdle()
  }

  @Test
  fun `closed runtime content remains available to the window exit`() {
    compose.runOnUiThread { runtime.close() }
    compose.onNodeWithText("Final content").assertExists()
  }
}
