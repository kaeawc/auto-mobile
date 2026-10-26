package dev.jasonpearson.automobile.prototype

import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.v2.createComposeRule
import dev.jasonpearson.automobile.protocol.PrototypeEvent
import dev.jasonpearson.automobile.protocol.PrototypeEventKind
import org.junit.After
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class PrototypeStackTransitionActivityTest {
  @get:Rule val compose = createComposeRule()
  private val host = EmbeddedPrototypeTestHost()

  private val shown = mutableStateOf(true)

  @After
  fun close() {
    compose.runOnIdle { shown.value = false }
    compose.waitForIdle()
    host.close()
  }

  @Test
  fun `activity back without progress pops before dismissing at root`() {
    val events = mutableListOf<PrototypeEvent>()
    val dismissals = mutableListOf<PrototypeDismissReason>()
    val spec =
      embeddedSpec(
          """{"type":"stack","id":"nav","start":"home","screens":{
      "home":{"type":"button","label":"Go","testTag":"home","onTap":[{"type":"push","stack":"nav","screen":"detail"}]},
      "detail":{"type":"text","text":"Detail","testTag":"detail"}}}""",
        )
        .replace("\"motion\":\"none\",", "")
    compose.setContent {
      if (shown.value)
        host.Content {
          AutoMobilePrototype(
            spec,
            handleBack = true,
            onEvent = { events += it },
            onDismiss = { dismissals += it },
          )
        }
    }
    compose.onNodeWithTag("home").performClick()
    compose.onNodeWithTag("detail").assertExists()
    compose.runOnIdle { host.backInput.backCompleted() }
    compose.onNodeWithTag("home").assertExists()
    compose.onNodeWithTag("detail").assertDoesNotExist()
    compose.runOnIdle {
      assertTrue(dismissals.isEmpty())
      assertEquals(2, events.count { it.kind == PrototypeEventKind.SCREEN_CHANGED })
      host.backInput.backCompleted()
    }
    compose.onNodeWithTag("home").assertDoesNotExist()
    compose.runOnIdle { assertEquals(listOf(PrototypeDismissReason.USER), dismissals) }
  }
}
