package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.v2.createComposeRule
import dev.jasonpearson.automobile.protocol.*
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** Chat lists (#14232): geometry, runtime requests and the rendered scroll's effects. */
@RunWith(RobolectricTestRunner::class)
class PrototypeChatScrollTest {
  @get:Rule val compose = createComposeRule()
  private val interactions = mutableListOf<PrototypeInteraction>()

  @Test
  fun `the end and start follow the scroll direction`() {
    assertTrue(PrototypeChatScroll.atEnd(0, 500, reverse = true))
    assertFalse(PrototypeChatScroll.atEnd(0, 500, reverse = false))
    assertTrue(PrototypeChatScroll.atEnd(500, 500, reverse = false))
    assertTrue(PrototypeChatScroll.atStart(500, 500, reverse = true))
    assertTrue(PrototypeChatScroll.atStart(0, 500, reverse = false))
    // A list that fits loads no older history.
    assertFalse(PrototypeChatScroll.atStart(0, 0, reverse = false))
  }

  @Test
  fun `only a forward scroll at its end follows appended rows`() {
    assertTrue(PrototypeChatScroll.follows(true, reverse = false, wasAtEnd = true, grew = true))
    assertFalse(PrototypeChatScroll.follows(true, reverse = false, wasAtEnd = false, grew = true))
    assertFalse(PrototypeChatScroll.follows(true, reverse = true, wasAtEnd = true, grew = true))
    assertFalse(PrototypeChatScroll.follows(false, reverse = false, wasAtEnd = true, grew = true))
    assertFalse(PrototypeChatScroll.follows(true, reverse = false, wasAtEnd = true, grew = false))
  }

  @Test
  fun `targets resolve to offsets in either direction`() {
    assertEquals(0, PrototypeChatScroll.offset(PrototypeScrollTarget.Start, 500, false, null))
    assertEquals(500, PrototypeChatScroll.offset(PrototypeScrollTarget.Start, 500, true, null))
    assertEquals(0, PrototypeChatScroll.offset(PrototypeScrollTarget.End, 500, true, null))
    assertEquals(120, PrototypeChatScroll.offset(PrototypeScrollTarget.Key("m"), 500, false, 120))
    assertEquals(380, PrototypeChatScroll.offset(PrototypeScrollTarget.Key("m"), 500, true, 120))
    assertEquals(500, PrototypeChatScroll.offset(PrototypeScrollTarget.Key("m"), 500, false, 900))
    assertNull(PrototypeChatScroll.offset(PrototypeScrollTarget.Key("m"), 500, false, null))
  }

  @Test
  fun `targets and row keys parse from the authored forms`() {
    assertEquals(
      PrototypeScrollTarget.End,
      PrototypeScrollTarget.of(Json.parseToJsonElement("\"end\"")),
    )
    assertEquals(
      PrototypeScrollTarget.Key("m3"),
      PrototypeScrollTarget.of(Json.parseToJsonElement("""{"key":"m3"}""")),
    )
    assertEquals(
      PrototypeScrollTarget.Key("7"),
      PrototypeScrollTarget.of(Json.parseToJsonElement("""{"key":7}""")),
    )
    assertNull(PrototypeScrollTarget.of(Json.parseToJsonElement("\"middle\"")))
    assertEquals("m3", PrototypeChatScroll.rowKey("root.child.repeat[m3].children[0]"))
    assertNull(PrototypeChatScroll.rowKey("root.child.repeat[m3].children[1]"))
  }

  @Test
  fun `scrollTo queues a request per scroll without changing state`() = runTest {
    val spec =
      PrototypeSpec(
        "chat",
        PrototypeWindow(PrototypeFullscreenPlacement()),
        emptyMap(),
        PrototypeScrollNode(id = "chat", reverse = true, child = PrototypeSpacerNode()),
      )
    val events = mutableListOf<PrototypeEvent>()
    var sequence = 0L
    val runtime = PrototypeRuntime(spec, { events += it }, { 1L }, { ++sequence })
    val to = Json.parseToJsonElement("\"start\"")
    runtime.handle(PrototypeInteraction.Tap(listOf(PrototypeScrollToAction("chat", to, false))))
    runtime.handle(PrototypeInteraction.Tap(listOf(PrototypeScrollToAction("chat", to))))
    val request = runtime.current.scrollRequests.getValue("chat")
    assertEquals(PrototypeScrollTarget.Start, request.target)
    assertTrue(request.animated)
    assertEquals(2L, request.sequence)
    assertTrue(events.isEmpty())
  }

  private fun chat(requests: Map<String, PrototypeScrollRequest>) =
    PrototypeSpec(
      "chat",
      PrototypeWindow(PrototypeFullscreenPlacement()),
      mapOf("atEnd" to PrototypeScalar.BooleanValue(false)),
      PrototypeScrollNode(
        id = "chat",
        reverse = true,
        atEndKey = "atEnd",
        onStartReached = listOf(PrototypeEmitAction("older")),
        style = PrototypeStyle(height = PrototypeDimension.Dp(100.0)),
        child =
          PrototypeColumnNode(
            children =
              List(30) {
                PrototypeTextNode(
                  text = "Message $it",
                  style = PrototypeStyle(height = PrototypeDimension.Dp(40.0)),
                )
              },
          ),
      ),
    ) to requests

  @Test
  fun `a reverse chat starts at its end and a scrollTo start reports the start`() {
    val requests = mutableStateOf<Map<String, PrototypeScrollRequest>>(emptyMap())
    val (spec, _) = chat(emptyMap())
    compose.setContent {
      CompositionLocalProvider(
        LocalPrototypeFillsWindow provides true,
        LocalPrototypeMotion provides false,
        LocalPrototypeScrollRequests provides requests.value,
      ) {
        Box(Modifier.fillMaxSize()) {
          PrototypeSpecContent(mapPrototypeSpec(spec).root) { interactions += it }
        }
      }
    }
    compose.waitForIdle()
    assertEquals(listOf(atEnd(true)), interactions)
    interactions.clear()
    requests.value =
      mapOf("chat" to PrototypeScrollRequest(PrototypeScrollTarget.Start, animated = false, 1L))
    compose.waitForIdle()
    assertEquals(
      listOf(atEnd(false), PrototypeInteraction.Tap(listOf(PrototypeEmitAction("older")))),
      interactions,
    )
  }

  private fun atEnd(value: Boolean) =
    PrototypeInteraction.Tap(
      listOf(PrototypeSetStateAction("atEnd", PrototypeScalar.BooleanValue(value))),
    )
}
